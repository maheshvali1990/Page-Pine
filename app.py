from __future__ import annotations

import asyncio
import hmac
import hashlib
import json
import logging
import os
import posixpath
import re
import secrets
import shutil
import sqlite3
import time
import uuid
import zipfile
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Literal
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError
from xml.etree import ElementTree

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field


ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("PAGEANDPINE_DATA", ROOT / "data")).resolve()
BOOKS_DIR = DATA_DIR / "books"
COVERS_DIR = DATA_DIR / "covers"
DB_PATH = DATA_DIR / "library.sqlite3"
MAX_UPLOAD_BYTES = 150 * 1024 * 1024
MAX_DOCX_ENTRIES = 5000
MAX_DOCX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
CONVERSION_TIMEOUT_SECONDS = 180
NATIVE_FORMATS = {"epub", "pdf", "txt", "md", "html", "htm", "docx"}
CALIBRE_FORMATS = {
    "azw", "azw3", "azw4", "cb7", "cbc", "cbr", "cbz", "chm", "djvu",
    "fb2", "lit", "lrf", "mobi", "odt", "pdb", "prc", "rb",
    "rtf", "snb", "tcr",
}
ALLOWED_FORMATS = NATIVE_FORMATS | CALIBRE_FORMATS
MIME_TYPES = {
    "epub": "application/epub+zip",
    "pdf": "application/pdf",
    "txt": "text/plain; charset=utf-8",
    "md": "text/plain; charset=utf-8",
    "html": "text/html; charset=utf-8",
    "htm": "text/html; charset=utf-8",
}
BOOK_STATUSES = {"want", "reading", "finished"}
logger = logging.getLogger("pageandpine")


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=10000")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


@contextmanager
def db_session() -> Iterator[sqlite3.Connection]:
    connection = connect()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}


def _migration_initial_schema(connection: sqlite3.Connection) -> None:
    connection.execute(
        """CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            author TEXT NOT NULL,
            original_name TEXT NOT NULL,
            original_format TEXT NOT NULL,
            reader_format TEXT NOT NULL,
            file_name TEXT NOT NULL,
            size INTEGER NOT NULL,
            progress REAL NOT NULL DEFAULT 0,
            locator TEXT NOT NULL DEFAULT '',
            added_at TEXT NOT NULL
        )"""
    )


def _migration_book_metadata_and_state(connection: sqlite3.Connection) -> None:
    additions = {
        "conversion_status": "TEXT NOT NULL DEFAULT 'ready'",
        "error": "TEXT",
        "language": "TEXT NOT NULL DEFAULT ''",
        "publisher": "TEXT NOT NULL DEFAULT ''",
        "description": "TEXT NOT NULL DEFAULT ''",
        "identifier": "TEXT NOT NULL DEFAULT ''",
        "series": "TEXT NOT NULL DEFAULT ''",
        "series_index": "REAL",
        "sha256": "TEXT NOT NULL DEFAULT ''",
        "has_cover": "INTEGER NOT NULL DEFAULT 0",
        "status": "TEXT NOT NULL DEFAULT 'want'",
        "status_manual": "INTEGER NOT NULL DEFAULT 0",
        "favorite": "INTEGER NOT NULL DEFAULT 0",
        "last_opened_at": "TEXT",
        "finished_at": "TEXT",
    }
    present = _columns(connection, "books")
    for name, declaration in additions.items():
        if name not in present:
            connection.execute(f"ALTER TABLE books ADD COLUMN {name} {declaration}")


def _migration_fts(connection: sqlite3.Connection) -> None:
    connection.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(title, author, series, content='books', content_rowid='rowid')"
    )
    connection.execute(
        """CREATE TRIGGER IF NOT EXISTS books_fts_insert AFTER INSERT ON books BEGIN
            INSERT INTO books_fts(rowid, title, author, series)
            VALUES (new.rowid, new.title, new.author, new.series);
        END"""
    )
    connection.execute(
        """CREATE TRIGGER IF NOT EXISTS books_fts_update AFTER UPDATE OF title, author, series ON books BEGIN
            INSERT INTO books_fts(books_fts, rowid, title, author, series)
            VALUES ('delete', old.rowid, old.title, old.author, old.series);
            INSERT INTO books_fts(rowid, title, author, series)
            VALUES (new.rowid, new.title, new.author, new.series);
        END"""
    )
    connection.execute(
        """CREATE TRIGGER IF NOT EXISTS books_fts_delete AFTER DELETE ON books BEGIN
            INSERT INTO books_fts(books_fts, rowid, title, author, series)
            VALUES ('delete', old.rowid, old.title, old.author, old.series);
        END"""
    )
    connection.execute(
        "INSERT INTO books_fts(books_fts) VALUES ('rebuild')"
    )


def _migration_backfill_hashes(connection: sqlite3.Connection) -> None:
    rows = connection.execute(
        "SELECT id, original_format, file_name FROM books WHERE sha256 = ''"
    ).fetchall()
    for row in rows:
        candidates = (f'{row["id"]}.{row["original_format"]}', row["file_name"])
        source = next(
            (
                (BOOKS_DIR / name).resolve()
                for name in candidates
                if (BOOKS_DIR / name).resolve().parent == BOOKS_DIR.resolve()
                and (BOOKS_DIR / name).is_file()
            ),
            None,
        )
        if source is None:
            logger.warning("Could not backfill a duplicate-detection hash for book %s; its file is missing.", row["id"])
            continue
        digest = hashlib.sha256()
        with source.open("rb") as book_file:
            for chunk in iter(lambda: book_file.read(1024 * 1024), b""):
                digest.update(chunk)
        existing = connection.execute(
            "SELECT id FROM books WHERE sha256 = ? AND id != ?",
            (digest.hexdigest(), row["id"]),
        ).fetchone()
        if existing:
            logger.warning(
                "Books %s and %s contain identical files; preserving both library records.",
                existing["id"],
                row["id"],
            )
            continue
        connection.execute(
            "UPDATE books SET sha256 = ? WHERE id = ?", (digest.hexdigest(), row["id"])
        )
    connection.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS books_sha256_unique ON books(sha256) WHERE sha256 != ''"
    )


def _migration_reader_features(connection: sqlite3.Connection) -> None:
    statements = (
        """CREATE TABLE IF NOT EXISTS highlights (
            id TEXT PRIMARY KEY,
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            locator TEXT NOT NULL,
            selected_text TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT 'yellow',
            note TEXT NOT NULL DEFAULT '',
            chapter TEXT NOT NULL DEFAULT '',
            progress REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS bookmarks (
            id TEXT PRIMARY KEY,
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            locator TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            chapter TEXT NOT NULL DEFAULT '',
            progress REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS collections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS collection_books (
            collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            PRIMARY KEY(collection_id, book_id)
        )""",
        """CREATE TABLE IF NOT EXISTS tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE
        )""",
        """CREATE TABLE IF NOT EXISTS book_tags (
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY(book_id, tag_id)
        )""",
        """CREATE TABLE IF NOT EXISTS device_progress (
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            device_id TEXT NOT NULL,
            progress REAL NOT NULL DEFAULT 0,
            locator TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL,
            PRIMARY KEY(book_id, device_id)
        )""",
        """CREATE TABLE IF NOT EXISTS reading_sessions (
            id TEXT PRIMARY KEY,
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            started_at TEXT NOT NULL,
            duration_seconds INTEGER NOT NULL CHECK(duration_seconds >= 0),
            progress_start REAL NOT NULL DEFAULT 0,
            progress_end REAL NOT NULL DEFAULT 0
        )""",
        "CREATE INDEX IF NOT EXISTS reading_sessions_started ON reading_sessions(started_at)",
    )
    for statement in statements:
        connection.execute(statement)


MIGRATIONS = (
    (1, _migration_initial_schema),
    (2, _migration_book_metadata_and_state),
    (3, _migration_fts),
    (4, _migration_backfill_hashes),
    (5, _migration_reader_features),
)


def initialize() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BOOKS_DIR.mkdir(parents=True, exist_ok=True)
    COVERS_DIR.mkdir(parents=True, exist_ok=True)
    with db_session() as connection:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            )"""
        )
        for version, migration in MIGRATIONS:
            exists = connection.execute(
                "SELECT 1 FROM schema_migrations WHERE version = ?", (version,)
            ).fetchone()
            if exists:
                continue
            connection.execute("BEGIN IMMEDIATE")
            try:
                migration(connection)
                connection.execute(
                    "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                    (version, datetime.now(timezone.utc).isoformat()),
                )
                connection.commit()
            except Exception:
                connection.rollback()
                raise


def recover_interrupted_work() -> None:
    with db_session() as connection:
        connection.execute(
            """UPDATE books SET conversion_status = 'failed',
               error = 'Conversion was interrupted when Page & Pine stopped.'
               WHERE conversion_status = 'converting'"""
        )
        rows = connection.execute("SELECT id, original_format, file_name FROM books").fetchall()
    known_files = {
        name
        for row in rows
        for name in (row["file_name"], f'{row["id"]}.{row["original_format"]}')
    }
    for path in BOOKS_DIR.iterdir():
        if path.is_file() and path.name not in known_files:
            path.unlink()
    known_covers = {f"{row['id']}.jpg" for row in rows}
    for path in COVERS_DIR.iterdir():
        if path.is_file() and path.name not in known_covers:
            path.unlink()


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize()
    recover_interrupted_work()
    inbox_task = asyncio.create_task(watch_inbox()) if os.environ.get("PAGEANDPINE_INBOX") else None
    try:
        yield
    finally:
        if inbox_task:
            inbox_task.cancel()
            try:
                await inbox_task
            except asyncio.CancelledError:
                pass


app = FastAPI(title="Page & Pine", version="1.0.0", lifespan=lifespan)
AUTH_COOKIE = "pageandpine_session"
AUTH_WINDOW_SECONDS = 300
AUTH_MAX_ATTEMPTS = 5
_auth_attempts: dict[str, list[float]] = {}
_ai_requests: dict[str, list[float]] = {}
_signing_secret: bytes | None = None


def _auth_enabled() -> bool:
    return bool(os.environ.get("PAGEANDPINE_PIN"))


def _session_secret() -> bytes:
    global _signing_secret
    if _signing_secret is not None:
        return _signing_secret
    secret_path = DATA_DIR / "session.secret"
    try:
        descriptor = os.open(secret_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        _signing_secret = secret_path.read_bytes()
    else:
        _signing_secret = secrets.token_bytes(32)
        with os.fdopen(descriptor, "wb") as secret_file:
            secret_file.write(_signing_secret)
    return _signing_secret


def _signed_session(expiry: int) -> str:
    payload = str(expiry).encode()
    signature = hmac.new(_session_secret(), payload, hashlib.sha256).hexdigest().encode()
    return (payload + b"." + signature).decode()


def _valid_session(value: str | None) -> bool:
    if not value:
        return False
    try:
        expiry_text, signature = value.encode().split(b".", 1)
        expiry = int(expiry_text)
    except (ValueError, TypeError):
        return False
    if expiry < int(time.time()):
        return False
    expected = hmac.new(_session_secret(), expiry_text, hashlib.sha256).hexdigest().encode()
    return hmac.compare_digest(signature, expected)


@app.middleware("http")
async def optional_pin_auth(request: Request, call_next):
    protected_path = request.url.path == "/opds" or request.url.path.startswith("/api/")
    if (
        _auth_enabled()
        and protected_path
        and request.url.path not in {"/api/auth/status", "/api/auth/login", "/api/auth/logout"}
        and not _valid_session(request.cookies.get(AUTH_COOKIE))
    ):
        return Response(
            content=json.dumps({"detail": "Enter your Page & Pine PIN to continue."}),
            status_code=401,
            media_type="application/json",
        )
    return await call_next(request)


def _limited_request(bucket: dict[str, list[float]], key: str, limit: int, window: int) -> bool:
    now = time.monotonic()
    recent = [value for value in bucket.get(key, []) if now - value < window]
    if len(recent) >= limit:
        bucket[key] = recent
        return False
    recent.append(now)
    bucket[key] = recent
    return True


def fetch_book(book_id: str) -> sqlite3.Row | None:
    with db_session() as connection:
        return connection.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()


def book_or_404(book_id: str) -> sqlite3.Row:
    row = fetch_book(book_id)
    if row is None:
        raise HTTPException(status_code=404, detail="This book is no longer in your library.")
    return row


def safe_title(filename: str) -> str:
    return Path(filename).stem.replace("_", " ").replace("-", " ").strip() or "Untitled"


def calibre_executable() -> str | None:
    executable = shutil.which("ebook-convert") or shutil.which("ebook-convert.exe")
    if executable:
        return executable
    if os.name == "nt":
        roots = (
            os.environ.get("ProgramW6432"),
            os.environ.get("ProgramFiles"),
            os.environ.get("ProgramFiles(x86)"),
            os.environ.get("LOCALAPPDATA"),
        )
        for root in filter(None, roots):
            for relative in (("Calibre2", "ebook-convert.exe"), ("Programs", "Calibre2", "ebook-convert.exe")):
                candidate = Path(root).joinpath(*relative)
                if candidate.is_file():
                    return str(candidate)
    return None


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _metadata_text(package: ElementTree.Element, names: set[str]) -> list[str]:
    return [
        (element.text or "").strip()
        for element in package.iter()
        if _local_name(element.tag) in names and (element.text or "").strip()
    ]


def epub_metadata(path: Path, fallback_title: str) -> dict[str, Any]:
    try:
        with zipfile.ZipFile(path) as archive:
            container = ElementTree.fromstring(archive.read("META-INF/container.xml"))
            rootfile = next(
                element.attrib["full-path"]
                for element in container.iter()
                if _local_name(element.tag) == "rootfile" and element.attrib.get("full-path")
            )
            package = ElementTree.fromstring(archive.read(rootfile))
    except (OSError, KeyError, StopIteration, ElementTree.ParseError, zipfile.BadZipFile) as error:
        raise ValueError("The EPUB package or its metadata is invalid.") from error

    titles = _metadata_text(package, {"title"})
    creators = _metadata_text(package, {"creator"})
    authors: list[str] = []
    seen_authors: set[str] = set()
    for creator in creators:
        for author in creator.strip(" ;,").split(";"):
            cleaned = author.strip(" ;,")
            if cleaned and cleaned.casefold() not in seen_authors:
                authors.append(cleaned)
                seen_authors.add(cleaned.casefold())

    metadata = list(package.iter())
    publisher = next(iter(_metadata_text(package, {"publisher"})), "")
    description = next(iter(_metadata_text(package, {"description"})), "")
    language = next(iter(_metadata_text(package, {"language"})), "")
    identifiers = _metadata_text(package, {"identifier"})
    isbn = next(
        (
            match.group(1)
            for value in identifiers
            if (match := re.search(r"(?i)(?:isbn(?:-1[03])?[:\s]*)?((?:[\dX][ -]?){9,16}[\dX])", value))
            and len(re.sub(r"[^0-9Xx]", "", match.group(1))) in {10, 13}
        ),
        "",
    )
    identifier = isbn or next(iter(identifiers), "")
    series = ""
    series_index: float | None = None
    for element in metadata:
        name = element.attrib.get("name", "").casefold()
        property_name = element.attrib.get("property", "").casefold()
        if name == "calibre:series" or property_name == "belongs-to-collection":
            series = (element.attrib.get("content") or element.text or "").strip()
        if name == "calibre:series_index" or property_name == "group-position":
            try:
                series_index = float(element.attrib.get("content") or element.text or "")
            except ValueError:
                logger.warning("Ignoring an invalid EPUB series index in %s", path.name)

    return {
        "title": next(iter(titles), "") or fallback_title,
        "author": ", ".join(authors) or "Unknown author",
        "language": language,
        "publisher": publisher,
        "description": description,
        "identifier": identifier,
        "series": series,
        "series_index": series_index,
    }


def _epub_cover_bytes(path: Path) -> bytes | None:
    try:
        with zipfile.ZipFile(path) as archive:
            container = ElementTree.fromstring(archive.read("META-INF/container.xml"))
            rootfile = next(
                element.attrib["full-path"]
                for element in container.iter()
                if _local_name(element.tag) == "rootfile" and element.attrib.get("full-path")
            )
            package = ElementTree.fromstring(archive.read(rootfile))
            manifest = next(element for element in package.iter() if _local_name(element.tag) == "manifest")
            items = [element for element in manifest if _local_name(element.tag) == "item"]
            cover_id = next(
                (
                    element.attrib.get("content")
                    for element in package.iter()
                    if _local_name(element.tag) == "meta" and element.attrib.get("name", "").casefold() == "cover"
                ),
                None,
            )
            cover = next(
                (
                    item for item in items
                    if item.attrib.get("id") == cover_id
                    or "cover-image" in item.attrib.get("properties", "").split()
                ),
                None,
            )
            if cover is None:
                guide = next((element for element in package.iter() if _local_name(element.tag) == "guide"), None)
                cover_reference = None
                if guide is not None:
                    cover_reference = next(
                        (
                            element.attrib.get("href")
                            for element in guide
                            if _local_name(element.tag) == "reference"
                            and "cover" in element.attrib.get("type", "").casefold()
                        ),
                        None,
                    )
                if cover_reference:
                    cover_href = cover_reference.split("#", 1)[0]
                else:
                    cover_href = next(
                        (
                            item.attrib["href"] for item in items
                            if item.attrib.get("media-type", "").startswith("image/")
                        ),
                        None,
                    )
            else:
                cover_href = cover.attrib.get("href")
            if not cover_href:
                return None
            member = posixpath.normpath(posixpath.join(posixpath.dirname(rootfile), cover_href))
            return archive.read(member)
    except (OSError, KeyError, StopIteration, ElementTree.ParseError, zipfile.BadZipFile):
        logger.warning("Could not extract the cover from EPUB %s", path.name, exc_info=True)
        return None


def _save_image_cover(image_data: bytes, destination: Path) -> bool:
    from io import BytesIO

    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(BytesIO(image_data)) as image:
            image = image.convert("RGB")
            image.thumbnail((600, 900), Image.Resampling.LANCZOS)
            image.save(destination, "JPEG", quality=88, optimize=True)
        return True
    except (UnidentifiedImageError, OSError):
        logger.warning("Skipping an unreadable book cover image.", exc_info=True)
        return False


def create_cover(path: Path, book_id: str, reader_format: str) -> bool:
    destination = COVERS_DIR / f"{book_id}.jpg"
    if reader_format == "epub":
        image_data = _epub_cover_bytes(path)
        return _save_image_cover(image_data, destination) if image_data else False
    if reader_format == "pdf":
        try:
            import fitz
        except ImportError:
            return False
        try:
            with fitz.open(path) as document:
                if not document.page_count:
                    return False
                pixmap = document[0].get_pixmap(matrix=fitz.Matrix(1.2, 1.2), alpha=False)
                return _save_image_cover(pixmap.tobytes("png"), destination)
        except (OSError, RuntimeError, ValueError):
            logger.warning("Could not render the first page of PDF %s as a cover.", path.name, exc_info=True)
            return False
    return False


def validate_magic(path: Path, extension: str) -> None:
    if extension == "pdf":
        with path.open("rb") as source:
            if not source.read(5).startswith(b"%PDF-"):
                raise HTTPException(status_code=422, detail="The file does not have a valid PDF signature.")
    elif extension in {"epub", "docx"}:
        try:
            with zipfile.ZipFile(path) as archive:
                entries = archive.infolist()
                if extension == "docx":
                    if len(entries) > MAX_DOCX_ENTRIES or sum(entry.file_size for entry in entries) > MAX_DOCX_UNCOMPRESSED_BYTES:
                        raise HTTPException(status_code=413, detail="This Word document is too large to unpack safely.")
                    if not any(entry.filename == "word/document.xml" for entry in entries):
                        raise HTTPException(status_code=422, detail="The file does not contain a valid Word document.")
                else:
                    if not any(entry.filename == "META-INF/container.xml" for entry in entries):
                        raise HTTPException(status_code=422, detail="The file does not contain a valid EPUB package.")
                    if archive.read("mimetype") != b"application/epub+zip":
                        raise HTTPException(status_code=422, detail="The file does not have a valid EPUB signature.")
        except zipfile.BadZipFile as error:
            raise HTTPException(status_code=422, detail=f"The file is not a valid {extension.upper()} archive.") from error


def docx_text(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_DOCX_ENTRIES:
                raise HTTPException(status_code=413, detail="This Word document contains too many files.")
            uncompressed_size = sum(entry.file_size for entry in entries)
            if uncompressed_size > MAX_DOCX_UNCOMPRESSED_BYTES:
                raise HTTPException(status_code=413, detail="This Word document is too large to unpack safely.")
            document_bytes = archive.read("word/document.xml")
            if len(document_bytes) > MAX_DOCX_UNCOMPRESSED_BYTES:
                raise HTTPException(status_code=413, detail="The Word document text is too large to read safely.")
            document = ElementTree.fromstring(document_bytes)
    except HTTPException:
        raise
    except (OSError, KeyError, ElementTree.ParseError, zipfile.BadZipFile) as error:
        raise HTTPException(status_code=422, detail="This Word document is invalid or damaged.") from error

    paragraphs: list[str] = []
    for paragraph in document.iter():
        if _local_name(paragraph.tag) != "p":
            continue
        parts = []
        for element in paragraph.iter():
            kind = _local_name(element.tag)
            if kind == "t" and element.text:
                parts.append(element.text)
            elif kind == "tab":
                parts.append("\t")
            elif kind in {"br", "cr"}:
                parts.append("\n")
        paragraphs.append("".join(parts))
    return "\n\n".join(paragraphs)


def book_json(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "author": row["author"],
        "originalName": row["original_name"],
        "format": row["original_format"].upper(),
        "readerFormat": row["reader_format"],
        "size": row["size"],
        "progress": row["progress"],
        "locator": row["locator"],
        "addedAt": row["added_at"],
        "conversionStatus": row["conversion_status"],
        "error": row["error"],
        "language": row["language"],
        "publisher": row["publisher"],
        "description": row["description"],
        "identifier": row["identifier"],
        "series": row["series"],
        "seriesIndex": row["series_index"],
        "hasCover": bool(row["has_cover"]),
        "status": row["status"],
        "favorite": bool(row["favorite"]),
        "lastOpenedAt": row["last_opened_at"],
        "finishedAt": row["finished_at"],
    }


def _search_expression(query: str) -> str:
    terms = re.findall(r"[\w]+", query, flags=re.UNICODE)
    if not terms:
        return ""
    return " AND ".join('"{}"*'.format(term.replace('"', '""')) for term in terms)


def _safe_file(row: sqlite3.Row, filename: str) -> Path:
    path = (BOOKS_DIR / filename).resolve()
    if path.parent != BOOKS_DIR.resolve() or not path.is_file():
        raise HTTPException(status_code=404, detail="The book file could not be found.")
    return path


def _book_from_upload(book_id: str) -> sqlite3.Row:
    return book_or_404(book_id)


async def convert_book(book_id: str, source_path: Path, converter: str) -> None:
    target_path = BOOKS_DIR / f"{book_id}.epub"
    try:
        process = await asyncio.create_subprocess_exec(
            converter,
            str(source_path),
            str(target_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(process.communicate(), timeout=CONVERSION_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            process.kill()
            await process.communicate()
            raise RuntimeError(f"Calibre conversion timed out after {CONVERSION_TIMEOUT_SECONDS} seconds.")
        if process.returncode != 0 or not target_path.is_file():
            error_text = stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(error_text or "Calibre could not convert this book.")

        metadata = epub_metadata(target_path, safe_title(source_path.name))
        has_cover = create_cover(target_path, book_id, "epub")
        with db_session() as connection:
            connection.execute(
                """UPDATE books SET reader_format = 'epub', file_name = ?,
                   conversion_status = 'ready', error = NULL, title = ?, author = ?,
                   language = ?, publisher = ?, description = ?, identifier = ?,
                   series = ?, series_index = ?, has_cover = ? WHERE id = ?""",
                (
                    target_path.name, metadata["title"], metadata["author"],
                    metadata["language"], metadata["publisher"], metadata["description"],
                    metadata["identifier"], metadata["series"], metadata["series_index"],
                    int(has_cover), book_id,
                ),
            )
            if connection.total_changes == 0:
                target_path.unlink(missing_ok=True)
                (COVERS_DIR / f"{book_id}.jpg").unlink(missing_ok=True)
    except asyncio.CancelledError:
        target_path.unlink(missing_ok=True)
        raise
    except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as error:
        target_path.unlink(missing_ok=True)
        with db_session() as connection:
            connection.execute(
                "UPDATE books SET conversion_status = 'failed', error = ? WHERE id = ?",
                (str(error), book_id),
            )
        logger.warning("Could not convert book %s: %s", book_id, error)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/capabilities")
def capabilities() -> dict[str, Any]:
    return {"formats": sorted(ALLOWED_FORMATS), "calibre": calibre_executable() is not None}


@app.get("/api/books")
def list_books(
    q: str = Query(default="", max_length=200),
    status: Literal["want", "reading", "finished"] | None = None,
    sort: Literal["recent", "title", "progress", "last_opened"] = "recent",
    favorite: bool | None = None,
    tag: str | None = Query(default=None, max_length=80),
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    parameters: list[Any] = []
    if status:
        clauses.append("books.status = ?")
        parameters.append(status)
    if favorite is not None:
        clauses.append("books.favorite = ?")
        parameters.append(int(favorite))
    if tag:
        clauses.append(
            """books.id IN (
                SELECT book_tags.book_id FROM book_tags
                JOIN tags ON tags.id = book_tags.tag_id
                WHERE tags.name = ? COLLATE NOCASE
            )"""
        )
        parameters.append(tag.strip())
    search_expression = _search_expression(q)
    if search_expression:
        clauses.append("books.rowid IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)")
        parameters.append(search_expression)
    order_by = {
        "recent": "books.added_at DESC",
        "title": "books.title COLLATE NOCASE ASC",
        "progress": "books.progress DESC",
        "last_opened": "books.last_opened_at DESC, books.added_at DESC",
    }[sort]
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with db_session() as connection:
        rows = connection.execute(
            f"SELECT books.* FROM books {where} ORDER BY {order_by}", parameters
        ).fetchall()
    return [book_json(row) for row in rows]


@app.post("/api/books")
async def upload_book(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
) -> dict[str, Any]:
    original_name = Path(file.filename or "").name
    extension = Path(original_name).suffix.lower().lstrip(".")
    if extension not in ALLOWED_FORMATS:
        raise HTTPException(
            status_code=415,
            detail="That file type is not supported. Try EPUB, PDF, DOCX, TXT, HTML, or a format supported by Calibre.",
        )

    converter = calibre_executable() if extension in CALIBRE_FORMATS else None
    if extension in CALIBRE_FORMATS and converter is None:
        raise HTTPException(
            status_code=415,
            detail=(
                f"{extension.upper()} needs Calibre's ebook-convert tool to prepare it for reading. "
                "Install Calibre and restart Page & Pine, or upload an EPUB or PDF."
            ),
        )

    book_id = uuid.uuid4().hex
    original_path = BOOKS_DIR / f"{book_id}.{extension}"
    digest = hashlib.sha256()
    size = 0
    try:
        with original_path.open("wb") as destination:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Books must be smaller than 150 MB.")
                digest.update(chunk)
                destination.write(chunk)
        validate_magic(original_path, extension)
        with db_session() as connection:
            duplicate = connection.execute(
                "SELECT id FROM books WHERE sha256 = ? AND sha256 != ''", (digest.hexdigest(),)
            ).fetchone()
        if duplicate:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "This book is already in your library.",
                    "existingBookId": duplicate["id"],
                },
            )
    except Exception:
        original_path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()

    reader_format = extension
    conversion_status = "converting" if converter else "ready"
    reader_path = BOOKS_DIR / f"{book_id}.epub" if converter else original_path
    title = safe_title(original_name)
    metadata: dict[str, Any] = {
        "title": title,
        "author": "Unknown author",
        "language": "",
        "publisher": "",
        "description": "",
        "identifier": "",
        "series": "",
        "series_index": None,
    }
    if extension == "epub":
        try:
            metadata = epub_metadata(original_path, title)
        except ValueError as error:
            original_path.unlink(missing_ok=True)
            raise HTTPException(status_code=422, detail=str(error)) from error
    has_cover = create_cover(original_path, book_id, reader_format) if not converter else False

    now = datetime.now(timezone.utc).isoformat()
    file_name = original_path.name if converter else reader_path.name
    try:
        with db_session() as connection:
            connection.execute(
                """INSERT INTO books (
                    id, title, author, original_name, original_format, reader_format,
                    file_name, size, progress, locator, added_at, conversion_status,
                    language, publisher, description, identifier, series, series_index,
                    sha256, has_cover, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'want')""",
                (
                    book_id, metadata["title"], metadata["author"], original_name,
                    extension, reader_format, file_name, size, now, conversion_status,
                    metadata["language"], metadata["publisher"], metadata["description"],
                    metadata["identifier"], metadata["series"], metadata["series_index"],
                    digest.hexdigest(), int(has_cover),
                ),
            )
    except sqlite3.IntegrityError:
        original_path.unlink(missing_ok=True)
        (COVERS_DIR / f"{book_id}.jpg").unlink(missing_ok=True)
        with db_session() as connection:
            duplicate = connection.execute(
                "SELECT id FROM books WHERE sha256 = ?", (digest.hexdigest(),)
            ).fetchone()
        if duplicate:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "This book is already in your library.",
                    "existingBookId": duplicate["id"],
                },
            )
        raise
    except Exception:
        original_path.unlink(missing_ok=True)
        (COVERS_DIR / f"{book_id}.jpg").unlink(missing_ok=True)
        raise

    if converter:
        background_tasks.add_task(convert_book, book_id, original_path, converter)
    return book_json(_book_from_upload(book_id))


@app.get("/api/books/{book_id}")
def get_book(book_id: str) -> dict[str, Any]:
    return book_json(book_or_404(book_id))


@app.post("/api/books/{book_id}/retry")
def retry_conversion(book_id: str, background_tasks: BackgroundTasks) -> dict[str, Any]:
    row = book_or_404(book_id)
    if row["conversion_status"] != "failed":
        raise HTTPException(status_code=409, detail="Only a failed conversion can be retried.")
    converter = calibre_executable()
    if converter is None:
        raise HTTPException(status_code=503, detail="Calibre's ebook-convert tool is not available.")
    source_path = _safe_file(row, f"{book_id}.{row['original_format']}")
    with db_session() as connection:
        connection.execute(
            """UPDATE books SET conversion_status = 'converting', error = NULL,
               file_name = ?, reader_format = ? WHERE id = ?""",
            (source_path.name, row["original_format"], book_id),
        )
    background_tasks.add_task(convert_book, book_id, source_path, converter)
    return book_json(book_or_404(book_id))


@app.get("/api/books/{book_id}/cover")
def get_book_cover(book_id: str) -> FileResponse:
    row = book_or_404(book_id)
    if not row["has_cover"]:
        raise HTTPException(status_code=404, detail="This book does not have an extracted cover.")
    path = (COVERS_DIR / f"{book_id}.jpg").resolve()
    if path.parent != COVERS_DIR.resolve() or not path.is_file():
        raise HTTPException(status_code=404, detail="The book cover could not be found.")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/books/{book_id}/file")
def get_book_file(book_id: str) -> FileResponse:
    row = book_or_404(book_id)
    path = _safe_file(row, row["file_name"])
    headers = {"Content-Security-Policy": "sandbox"} if row["reader_format"] in {"html", "htm"} else None
    return FileResponse(
        path,
        media_type=MIME_TYPES.get(row["reader_format"], "application/octet-stream"),
        headers=headers,
    )


@app.get("/api/books/{book_id}/text")
def get_book_text(book_id: str) -> dict[str, str]:
    row = book_or_404(book_id)
    path = _safe_file(row, row["file_name"])
    if row["reader_format"] == "docx":
        return {"text": docx_text(path)}
    if row["reader_format"] not in {"txt", "md", "html", "htm"}:
        raise HTTPException(status_code=415, detail="This book is not a text document.")
    try:
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        text = path.read_text(encoding="cp1252")
    if row["reader_format"] in {"html", "htm"}:
        from html.parser import HTMLParser

        class TextExtractor(HTMLParser):
            def __init__(self) -> None:
                super().__init__()
                self.parts: list[str] = []
                self.skip_depth = 0

            def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
                if tag.lower() in {"script", "style"}:
                    self.skip_depth += 1

            def handle_endtag(self, tag: str) -> None:
                if tag.lower() in {"script", "style"} and self.skip_depth:
                    self.skip_depth -= 1

            def handle_data(self, data: str) -> None:
                if not self.skip_depth:
                    self.parts.append(data)

        parser = TextExtractor()
        parser.feed(text)
        text = "\n".join(parser.parts)
    return {"text": text}


class ProgressUpdate(BaseModel):
    progress: float = Field(ge=0, le=1)
    locator: str = Field(default="", max_length=2000)
    deviceId: str | None = Field(default=None, min_length=1, max_length=100)


class BookPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=500)
    author: str | None = Field(default=None, max_length=500)
    series: str | None = Field(default=None, max_length=500)
    status: Literal["want", "reading", "finished"] | None = None
    favorite: bool | None = None


@app.put("/api/books/{book_id}/progress")
def update_progress(book_id: str, update: ProgressUpdate) -> dict[str, Any]:
    book_or_404(book_id)
    now = datetime.now(timezone.utc).isoformat()
    with db_session() as connection:
        row = connection.execute(
            "SELECT status_manual FROM books WHERE id = ?", (book_id,)
        ).fetchone()
        assignments = ["progress = ?", "locator = ?", "last_opened_at = ?"]
        values: list[Any] = [update.progress, update.locator, now]
        if not row["status_manual"]:
            new_status = "finished" if update.progress >= 0.98 else "reading" if update.progress > 0 else "want"
            assignments.append("status = ?")
            values.append(new_status)
            assignments.append("finished_at = ?")
            values.append(now if new_status == "finished" else None)
        values.append(book_id)
        connection.execute(
            f"UPDATE books SET {', '.join(assignments)} WHERE id = ?", values
        )
        if update.deviceId:
            connection.execute(
                """INSERT INTO device_progress(book_id, device_id, progress, locator, updated_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(book_id, device_id) DO UPDATE SET
                   progress = excluded.progress, locator = excluded.locator,
                   updated_at = excluded.updated_at""",
                (book_id, update.deviceId, update.progress, update.locator, now),
            )
    return {
        "progress": update.progress,
        "locator": update.locator,
        "lastOpenedAt": now,
    }


@app.patch("/api/books/{book_id}")
def patch_book(book_id: str, update: BookPatch) -> dict[str, Any]:
    row = book_or_404(book_id)
    values = update.model_dump(exclude_unset=True)
    if not values:
        return book_json(row)
    if any(values.get(field) is None for field in ("title", "author", "series", "status", "favorite") if field in values):
        raise HTTPException(status_code=422, detail="Updated book fields cannot be null.")
    assignments: list[str] = []
    parameters: list[Any] = []
    for field in ("title", "author", "series", "favorite"):
        if field in values:
            value = values[field]
            if field in {"title", "author", "series"}:
                value = (value or "").strip()
                if field == "title" and not value:
                    raise HTTPException(status_code=422, detail="A book title cannot be blank.")
            assignments.append(f"{field} = ?")
            parameters.append(int(value) if field == "favorite" else value)
    if "status" in values:
        assignments.extend(("status = ?", "status_manual = 1", "finished_at = ?"))
        parameters.extend((
            values["status"],
            datetime.now(timezone.utc).isoformat() if values["status"] == "finished" else None,
        ))
    parameters.append(book_id)
    with db_session() as connection:
        connection.execute(f"UPDATE books SET {', '.join(assignments)} WHERE id = ?", parameters)
    return book_json(book_or_404(book_id))


@app.delete("/api/books/{book_id}")
def delete_book(book_id: str) -> dict[str, bool]:
    row = book_or_404(book_id)
    with db_session() as connection:
        connection.execute("DELETE FROM books WHERE id = ?", (book_id,))
    (BOOKS_DIR / row["file_name"]).unlink(missing_ok=True)
    original_path = BOOKS_DIR / f"{book_id}.{row['original_format']}"
    if original_path.name != row["file_name"]:
        original_path.unlink(missing_ok=True)
    (COVERS_DIR / f"{book_id}.jpg").unlink(missing_ok=True)
    return {"deleted": True}


class HighlightCreate(BaseModel):
    locator: str = Field(min_length=1, max_length=2000)
    text: str = Field(min_length=1, max_length=20000)
    color: Literal["yellow", "green", "blue", "pink"] = "yellow"
    note: str = Field(default="", max_length=10000)
    chapter: str = Field(default="", max_length=500)
    progress: float = Field(default=0, ge=0, le=1)


class HighlightPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    color: Literal["yellow", "green", "blue", "pink"] | None = None
    note: str | None = Field(default=None, max_length=10000)


class BookmarkCreate(BaseModel):
    locator: str = Field(min_length=1, max_length=2000)
    label: str = Field(default="", max_length=500)
    chapter: str = Field(default="", max_length=500)
    progress: float = Field(default=0, ge=0, le=1)


class BookmarkPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(min_length=1, max_length=500)


class CollectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)


class CollectionMembership(BaseModel):
    bookId: str


class TagUpdate(BaseModel):
    tags: list[str] = Field(max_length=50)


class ReadingSessionCreate(BaseModel):
    startedAt: datetime
    durationSeconds: int = Field(ge=1, le=86400)
    progressStart: float = Field(default=0, ge=0, le=1)
    progressEnd: float = Field(default=0, ge=0, le=1)


class LoginRequest(BaseModel):
    pin: str = Field(min_length=1, max_length=128)


class ExplainRequest(BaseModel):
    passage: str = Field(min_length=1, max_length=12000)
    question: str = Field(default="Explain this passage in clear, plain language.", max_length=1000)
    provider: Literal["openai-compatible"] = "openai-compatible"


@app.get("/api/auth/status")
def auth_status(request: Request) -> dict[str, bool]:
    return {"enabled": _auth_enabled(), "authenticated": not _auth_enabled() or _valid_session(request.cookies.get(AUTH_COOKIE))}


@app.post("/api/auth/login")
def auth_login(payload: LoginRequest, request: Request) -> Response:
    if not _auth_enabled():
        return Response(
            content=json.dumps({"enabled": False}),
            media_type="application/json",
        )
    host = request.client.host if request.client else "unknown"
    if not _limited_request(_auth_attempts, host, AUTH_MAX_ATTEMPTS, AUTH_WINDOW_SECONDS):
        raise HTTPException(status_code=429, detail="Too many PIN attempts. Wait five minutes and try again.")
    if not hmac.compare_digest(payload.pin, os.environ["PAGEANDPINE_PIN"]):
        raise HTTPException(status_code=401, detail="That PIN is not correct.")
    _auth_attempts.pop(host, None)
    response = Response(
        content=json.dumps({"enabled": True, "authenticated": True}),
        media_type="application/json",
    )
    response.set_cookie(
        AUTH_COOKIE,
        _signed_session(int(time.time()) + 60 * 60 * 24 * 14),
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
        max_age=60 * 60 * 24 * 14,
        path="/",
    )
    return response


@app.post("/api/auth/logout")
def auth_logout() -> Response:
    response = Response(content=json.dumps({"authenticated": False}), media_type="application/json")
    response.delete_cookie(AUTH_COOKIE, path="/", httponly=True, samesite="strict")
    return response


@app.get("/api/ai/config")
def ai_configuration() -> dict[str, Any]:
    enabled = os.environ.get("PAGEANDPINE_AI_ENABLED", "").casefold() == "true"
    configured = bool(
        enabled
        and os.environ.get("PAGEANDPINE_AI_API_KEY")
        and os.environ.get("PAGEANDPINE_AI_BASE_URL")
        and os.environ.get("PAGEANDPINE_AI_MODEL")
    )
    return {
        "enabled": enabled,
        "configured": configured,
        "model": os.environ.get("PAGEANDPINE_AI_MODEL", "") if configured else "",
        "usesExternalService": True,
    }


@app.post("/api/ai/explain")
async def explain_passage(payload: ExplainRequest, request: Request) -> dict[str, str]:
    config = ai_configuration()
    if not config["configured"]:
        raise HTTPException(
            status_code=503,
            detail="AI helpers are disabled. Configure the opt-in server-side AI environment settings first.",
        )
    host = request.client.host if request.client else "unknown"
    if not _limited_request(_ai_requests, host, 10, 60):
        raise HTTPException(status_code=429, detail="AI helper rate limit reached. Try again in a minute.")
    base_url = os.environ["PAGEANDPINE_AI_BASE_URL"].rstrip("/")
    if not base_url.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        raise HTTPException(status_code=422, detail="The AI provider URL must use HTTPS (except localhost).")
    body = json.dumps({
        "model": os.environ["PAGEANDPINE_AI_MODEL"],
        "messages": [
            {"role": "system", "content": "Explain the user-provided book excerpt. Do not assume facts not present in it."},
            {"role": "user", "content": f"Question: {payload.question}\n\nBook excerpt:\n{payload.passage}"},
        ],
    }).encode()
    outbound = urllib_request.Request(
        f"{base_url}/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {os.environ['PAGEANDPINE_AI_API_KEY']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    def send_request() -> str:
        try:
            with urllib_request.urlopen(outbound, timeout=30) as response:
                result = json.loads(response.read(1024 * 1024))
        except HTTPError as error:
            logger.warning("Configured AI service returned HTTP %s.", error.code)
            raise HTTPException(status_code=502, detail="The configured AI service returned an error.") from error
        except (URLError, TimeoutError, json.JSONDecodeError) as error:
            logger.warning("Could not reach configured AI service: %s", error)
            raise HTTPException(status_code=502, detail="Could not reach the configured AI service.") from error
        try:
            return result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise HTTPException(status_code=502, detail="The AI service returned an unexpected response.") from error

    answer = await asyncio.to_thread(send_request)
    return {"answer": answer}


@app.get("/api/books/{book_id}/highlights")
def list_highlights(book_id: str) -> list[dict[str, Any]]:
    book_or_404(book_id)
    with db_session() as connection:
        rows = connection.execute(
            "SELECT * FROM highlights WHERE book_id = ? ORDER BY created_at", (book_id,)
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/books/{book_id}/highlights")
def create_highlight(book_id: str, payload: HighlightCreate) -> dict[str, Any]:
    book_or_404(book_id)
    now = datetime.now(timezone.utc).isoformat()
    highlight_id = uuid.uuid4().hex
    with db_session() as connection:
        connection.execute(
            """INSERT INTO highlights
               (id, book_id, locator, selected_text, color, note, chapter, progress, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                highlight_id, book_id, payload.locator, payload.text, payload.color,
                payload.note, payload.chapter, payload.progress, now, now,
            ),
        )
        row = connection.execute("SELECT * FROM highlights WHERE id = ?", (highlight_id,)).fetchone()
    return dict(row)


@app.patch("/api/highlights/{highlight_id}")
def update_highlight(highlight_id: str, payload: HighlightPatch) -> dict[str, Any]:
    values = payload.model_dump(exclude_unset=True)
    if not values or any(value is None for value in values.values()):
        raise HTTPException(status_code=422, detail="Provide a highlight color or note.")
    with db_session() as connection:
        row = connection.execute("SELECT id FROM highlights WHERE id = ?", (highlight_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Highlight not found.")
        assignments = [f"{key} = ?" for key in values]
        connection.execute(
            f"UPDATE highlights SET {', '.join(assignments)}, updated_at = ? WHERE id = ?",
            (*values.values(), datetime.now(timezone.utc).isoformat(), highlight_id),
        )
        updated = connection.execute("SELECT * FROM highlights WHERE id = ?", (highlight_id,)).fetchone()
    return dict(updated)


@app.delete("/api/highlights/{highlight_id}")
def delete_highlight(highlight_id: str) -> dict[str, bool]:
    with db_session() as connection:
        cursor = connection.execute("DELETE FROM highlights WHERE id = ?", (highlight_id,))
    if not cursor.rowcount:
        raise HTTPException(status_code=404, detail="Highlight not found.")
    return {"deleted": True}


@app.get("/api/books/{book_id}/bookmarks")
def list_bookmarks(book_id: str) -> list[dict[str, Any]]:
    book_or_404(book_id)
    with db_session() as connection:
        rows = connection.execute(
            "SELECT * FROM bookmarks WHERE book_id = ? ORDER BY created_at", (book_id,)
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/books/{book_id}/bookmarks")
def create_bookmark(book_id: str, payload: BookmarkCreate) -> dict[str, Any]:
    book_or_404(book_id)
    bookmark_id = uuid.uuid4().hex
    with db_session() as connection:
        connection.execute(
            """INSERT INTO bookmarks(id, book_id, locator, label, chapter, progress, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                bookmark_id, book_id, payload.locator, payload.label,
                payload.chapter, payload.progress, datetime.now(timezone.utc).isoformat(),
            ),
        )
        row = connection.execute("SELECT * FROM bookmarks WHERE id = ?", (bookmark_id,)).fetchone()
    return dict(row)


@app.patch("/api/bookmarks/{bookmark_id}")
def update_bookmark(bookmark_id: str, payload: BookmarkPatch) -> dict[str, Any]:
    label = payload.label.strip()
    if not label:
        raise HTTPException(status_code=422, detail="A bookmark label cannot be blank.")
    with db_session() as connection:
        cursor = connection.execute(
            "UPDATE bookmarks SET label = ? WHERE id = ?", (label, bookmark_id)
        )
        if not cursor.rowcount:
            raise HTTPException(status_code=404, detail="Bookmark not found.")
        row = connection.execute(
            "SELECT * FROM bookmarks WHERE id = ?", (bookmark_id,)
        ).fetchone()
    return dict(row)


@app.delete("/api/bookmarks/{bookmark_id}")
def delete_bookmark(bookmark_id: str) -> dict[str, bool]:
    with db_session() as connection:
        cursor = connection.execute("DELETE FROM bookmarks WHERE id = ?", (bookmark_id,))
    if not cursor.rowcount:
        raise HTTPException(status_code=404, detail="Bookmark not found.")
    return {"deleted": True}


@app.get("/api/books/{book_id}/highlights.json")
def export_highlights_json(book_id: str) -> Response:
    highlights = list_highlights(book_id)
    return Response(
        content=json.dumps(highlights, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{book_id}-highlights.json"'},
    )


@app.get("/api/books/{book_id}/highlights.md")
def export_highlights_markdown(book_id: str) -> Response:
    book = book_or_404(book_id)
    highlights = list_highlights(book_id)
    sections = [f"# Highlights: {book['title']}", ""]
    for highlight in highlights:
        if highlight["chapter"]:
            sections.extend((f"## {highlight['chapter']}", ""))
        sections.extend((f"> {highlight['selected_text']}", ""))
        if highlight["note"]:
            sections.extend((f"Note: {highlight['note']}", ""))
    return Response(
        content="\n".join(sections),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{book_id}-highlights.md"'},
    )


@app.get("/api/collections")
def list_collections() -> list[dict[str, Any]]:
    with db_session() as connection:
        rows = connection.execute(
            """SELECT c.*, COUNT(cb.book_id) AS book_count FROM collections c
               LEFT JOIN collection_books cb ON cb.collection_id = c.id
               GROUP BY c.id ORDER BY c.name COLLATE NOCASE"""
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/collections")
def create_collection(payload: CollectionCreate) -> dict[str, Any]:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="A collection name cannot be blank.")
    collection_id = uuid.uuid4().hex
    with db_session() as connection:
        try:
            connection.execute(
                "INSERT INTO collections(id, name, description, created_at) VALUES (?, ?, ?, ?)",
                (collection_id, name, payload.description.strip(), datetime.now(timezone.utc).isoformat()),
            )
        except sqlite3.IntegrityError as error:
            raise HTTPException(status_code=409, detail="A collection with that name already exists.") from error
        row = connection.execute("SELECT * FROM collections WHERE id = ?", (collection_id,)).fetchone()
    return dict(row)


@app.get("/api/collections/{collection_id}/books")
def list_collection_books(collection_id: str) -> list[dict[str, Any]]:
    with db_session() as connection:
        exists = connection.execute(
            "SELECT 1 FROM collections WHERE id = ?", (collection_id,)
        ).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="Collection not found.")
        rows = connection.execute(
            """SELECT books.* FROM books JOIN collection_books
               ON collection_books.book_id = books.id
               WHERE collection_books.collection_id = ?
               ORDER BY books.title COLLATE NOCASE""",
            (collection_id,),
        ).fetchall()
    return [book_json(row) for row in rows]


@app.put("/api/collections/{collection_id}/books")
def add_collection_book(collection_id: str, payload: CollectionMembership) -> dict[str, bool]:
    book_or_404(payload.bookId)
    with db_session() as connection:
        if connection.execute("SELECT 1 FROM collections WHERE id = ?", (collection_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Collection not found.")
        connection.execute(
            "INSERT OR IGNORE INTO collection_books(collection_id, book_id) VALUES (?, ?)",
            (collection_id, payload.bookId),
        )
    return {"added": True}


@app.delete("/api/collections/{collection_id}/books/{book_id}")
def remove_collection_book(collection_id: str, book_id: str) -> dict[str, bool]:
    with db_session() as connection:
        cursor = connection.execute(
            "DELETE FROM collection_books WHERE collection_id = ? AND book_id = ?",
            (collection_id, book_id),
        )
    if not cursor.rowcount:
        raise HTTPException(status_code=404, detail="Book is not in that collection.")
    return {"removed": True}


@app.delete("/api/collections/{collection_id}")
def delete_collection(collection_id: str) -> dict[str, bool]:
    with db_session() as connection:
        cursor = connection.execute("DELETE FROM collections WHERE id = ?", (collection_id,))
    if not cursor.rowcount:
        raise HTTPException(status_code=404, detail="Collection not found.")
    return {"deleted": True}


@app.get("/api/books/{book_id}/tags")
def list_book_tags(book_id: str) -> list[str]:
    book_or_404(book_id)
    with db_session() as connection:
        rows = connection.execute(
            """SELECT tags.name FROM tags JOIN book_tags ON book_tags.tag_id = tags.id
               WHERE book_tags.book_id = ? ORDER BY tags.name COLLATE NOCASE""",
            (book_id,),
        ).fetchall()
    return [row["name"] for row in rows]


@app.get("/api/tags")
def list_tags() -> list[dict[str, Any]]:
    with db_session() as connection:
        rows = connection.execute(
            """SELECT tags.name, COUNT(book_tags.book_id) AS book_count
               FROM tags LEFT JOIN book_tags ON book_tags.tag_id = tags.id
               GROUP BY tags.id
               HAVING COUNT(book_tags.book_id) > 0
               ORDER BY tags.name COLLATE NOCASE"""
        ).fetchall()
    return [{"name": row["name"], "bookCount": row["book_count"]} for row in rows]


@app.put("/api/books/{book_id}/tags")
def update_book_tags(book_id: str, payload: TagUpdate) -> list[str]:
    book_or_404(book_id)
    tags = list(dict.fromkeys(tag.strip() for tag in payload.tags if tag.strip()))
    if any(len(tag) > 80 for tag in tags):
        raise HTTPException(status_code=422, detail="Tags must be 80 characters or fewer.")
    with db_session() as connection:
        connection.execute("DELETE FROM book_tags WHERE book_id = ?", (book_id,))
        for name in tags:
            tag_id = uuid.uuid5(uuid.NAMESPACE_URL, f"pageandpine:tag:{name.casefold()}").hex
            connection.execute("INSERT OR IGNORE INTO tags(id, name) VALUES (?, ?)", (tag_id, name))
            connection.execute(
                "INSERT INTO book_tags(book_id, tag_id) VALUES (?, ?)",
                (book_id, tag_id),
            )
    return tags


@app.get("/api/books/{book_id}/device-progress")
def get_device_progress(book_id: str, device_id: str = Query(min_length=1, max_length=100)) -> dict[str, Any]:
    book = book_or_404(book_id)
    with db_session() as connection:
        rows = connection.execute(
            "SELECT device_id, progress, locator, updated_at FROM device_progress WHERE book_id = ? ORDER BY progress DESC",
            (book_id,),
        ).fetchall()
    other = next((row for row in rows if row["device_id"] != device_id), None)
    return {
        "progress": book["progress"],
        "otherDeviceAhead": bool(other and other["progress"] > book["progress"]),
        "otherDevice": dict(other) if other and other["progress"] > book["progress"] else None,
    }


@app.post("/api/books/{book_id}/sessions")
def record_reading_session(book_id: str, payload: ReadingSessionCreate) -> dict[str, Any]:
    book_or_404(book_id)
    session_id = uuid.uuid4().hex
    with db_session() as connection:
        connection.execute(
            """INSERT INTO reading_sessions
               (id, book_id, started_at, duration_seconds, progress_start, progress_end)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                session_id, book_id, payload.startedAt.astimezone(timezone.utc).isoformat(),
                payload.durationSeconds, payload.progressStart, payload.progressEnd,
            ),
        )
    return {"id": session_id}


@app.get("/api/stats")
def reading_stats() -> dict[str, Any]:
    with db_session() as connection:
        books_finished = connection.execute(
            "SELECT COUNT(*) FROM books WHERE status = 'finished'"
        ).fetchone()[0]
        daily = connection.execute(
            """SELECT substr(started_at, 1, 10) AS day,
               SUM(duration_seconds) AS seconds, COUNT(DISTINCT book_id) AS books
               FROM reading_sessions WHERE started_at >= date('now', '-90 days')
               GROUP BY day ORDER BY day"""
        ).fetchall()
    days = {row["day"] for row in daily if row["seconds"]}
    streak = 0
    today = datetime.now(timezone.utc).date()
    while (today - timedelta(days=streak)).isoformat() in days:
        streak += 1
    return {
        "booksFinished": books_finished,
        "secondsRead": sum(row["seconds"] for row in daily),
        "streakDays": streak,
        "daily": [dict(row) for row in daily],
    }


@app.get("/opds")
def opds_catalog(request: Request) -> Response:
    feed = ElementTree.Element(
        "feed",
        xmlns="http://www.w3.org/2005/Atom",
        attrib={"xmlns:dc": "http://purl.org/dc/terms/"},
    )
    ElementTree.SubElement(feed, "id").text = str(request.base_url).rstrip("/") + "/opds"
    ElementTree.SubElement(feed, "title").text = "Page & Pine Library"
    ElementTree.SubElement(feed, "updated").text = datetime.now(timezone.utc).isoformat()
    with db_session() as connection:
        rows = connection.execute("SELECT * FROM books WHERE conversion_status = 'ready' ORDER BY title").fetchall()
    for row in rows:
        entry = ElementTree.SubElement(feed, "entry")
        ElementTree.SubElement(entry, "id").text = f"urn:pageandpine:{row['id']}"
        ElementTree.SubElement(entry, "title").text = row["title"]
        author = ElementTree.SubElement(entry, "author")
        ElementTree.SubElement(author, "name").text = row["author"]
        ElementTree.SubElement(entry, "updated").text = row["added_at"]
        ElementTree.SubElement(
            entry,
            "link",
            {
                "rel": "http://opds-spec.org/acquisition",
                "href": f"/api/books/{row['id']}/file",
                "type": MIME_TYPES.get(row["reader_format"], "application/octet-stream"),
            },
        )
        if row["has_cover"]:
            ElementTree.SubElement(entry, "link", {"rel": "http://opds-spec.org/image", "href": f"/api/books/{row['id']}/cover", "type": "image/jpeg"})
    return Response(
        content=ElementTree.tostring(feed, encoding="utf-8", xml_declaration=True),
        media_type="application/atom+xml;profile=opds-catalog;kind=acquisition",
    )


async def watch_inbox() -> None:
    inbox = Path(os.environ["PAGEANDPINE_INBOX"]).expanduser().resolve()
    inbox.mkdir(parents=True, exist_ok=True)
    imported = inbox / "imported"
    imported.mkdir(exist_ok=True)
    duplicates = inbox / "duplicates"
    duplicates.mkdir(exist_ok=True)
    rejected = inbox / "rejected"
    rejected.mkdir(exist_ok=True)
    while True:
        for path in inbox.iterdir():
            if not path.is_file() or path.suffix.lower().lstrip(".") not in ALLOWED_FORMATS:
                continue
            try:
                tasks = BackgroundTasks()
                with path.open("rb") as source:
                    uploaded = UploadFile(filename=path.name, file=source)
                    result = await upload_book(tasks, uploaded)
                for task in tasks.tasks:
                    await task()
                destination = imported / path.name
                if destination.exists():
                    destination = imported / f"{path.stem}-{uuid.uuid4().hex[:8]}{path.suffix}"
                shutil.move(str(path), destination)
                logger.info("Imported inbox book %s as %s", path.name, result["id"])
            except HTTPException as error:
                logger.warning("Could not import inbox book %s: %s", path.name, error.detail)
                destination_dir = duplicates if error.status_code == 409 else rejected
                destination = destination_dir / path.name
                if destination.exists():
                    destination = destination_dir / f"{path.stem}-{uuid.uuid4().hex[:8]}{path.suffix}"
                shutil.move(str(path), destination)
            except (OSError, RuntimeError, ValueError) as error:
                logger.warning("Could not import inbox book %s: %s", path.name, error)
        await asyncio.sleep(30)


app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="static")
