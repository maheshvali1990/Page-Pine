from __future__ import annotations

import asyncio
import importlib
import io
import sqlite3
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree

import pytest
from fastapi.testclient import TestClient
from PIL import Image


APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))


@pytest.fixture
def app_module(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PAGEANDPINE_DATA", str(tmp_path))
    import app

    module = importlib.reload(app)
    with TestClient(module.app) as client:
        yield module, client, tmp_path


def make_epub(
    *,
    title: str = "A Test Book",
    creators: tuple[str, ...] = ("Jane Reader;",),
    include_cover: bool = False,
) -> bytes:
    package_cover = (
        '<meta name="cover" content="cover-image"/>'
        '<item id="cover-image" href="images/cover.png" media-type="image/png"/>'
        if include_cover
        else ""
    )
    image = Image.new("RGB", (80, 120), (158, 94, 72))
    image_stream = io.BytesIO()
    image.save(image_stream, format="PNG")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        archive.writestr(
            "META-INF/container.xml",
            '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>',
        )
        creator_metadata = "".join(
            f"<dc:creator>{creator}</dc:creator>" for creator in creators
        )
        archive.writestr(
            "OPS/package.opf",
            f"""<package xmlns="http://www.idpf.org/2007/opf"
              xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0">
              <metadata><dc:title>{title}</dc:title>{creator_metadata}
              <dc:language>en</dc:language><dc:publisher>Pine House</dc:publisher>
              <dc:description>A sample description</dc:description>
              <dc:identifier>urn:isbn:978-1-2345-6789-7</dc:identifier>
              <meta name="calibre:series" content="Garden Stories"/>
              <meta name="calibre:series_index" content="2"/>
              </metadata><manifest>{package_cover}
              <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
              </manifest><spine><itemref idref="chapter"/></spine></package>""",
        )
        archive.writestr(
            "OPS/chapter.xhtml",
            "<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>Chapter text</p></body></html>",
        )
        if include_cover:
            archive.writestr("OPS/images/cover.png", image_stream.getvalue())
    return buffer.getvalue()


def test_migrates_old_schema_without_losing_books(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PAGEANDPINE_DATA", str(tmp_path))
    database = tmp_path / "library.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.execute(
            """CREATE TABLE books (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL,
                original_name TEXT NOT NULL, original_format TEXT NOT NULL,
                reader_format TEXT NOT NULL, file_name TEXT NOT NULL, size INTEGER NOT NULL,
                progress REAL NOT NULL DEFAULT 0, locator TEXT NOT NULL DEFAULT '',
                added_at TEXT NOT NULL
            )"""
        )
        connection.execute(
            """INSERT INTO books VALUES
               ('old-id', 'Old Title', 'Old Author', 'old.txt', 'txt', 'txt',
                'old-id.txt', 12, 0.25, 'old-locator', '2024-01-01T00:00:00+00:00')"""
        )
    (tmp_path / "books").mkdir(exist_ok=True)
    (tmp_path / "books" / "old-id.txt").write_bytes(b"old book contents")
    import app

    module = importlib.reload(app)
    module.initialize()
    with module.db_session() as connection:
        row = connection.execute("SELECT * FROM books WHERE id = 'old-id'").fetchone()
        migrations = connection.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
        sha_index = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'books_sha256_unique'"
        ).fetchone()
    assert row["title"] == "Old Title"
    assert row["progress"] == 0.25
    assert row["status"] == "want"
    assert row["sha256"]
    assert sha_index is not None
    assert [row["version"] for row in migrations] == [1, 2, 3, 4, 5]


def test_upload_rejects_invalid_signatures_and_duplicate_books(app_module):
    module, client, data_dir = app_module
    invalid = client.post("/api/books", files={"file": ("bad.pdf", b"not a PDF")})
    assert invalid.status_code == 422
    assert client.get("/api/books").json() == []

    content = b"A unique text book for deduplication."
    first = client.post("/api/books", files={"file": ("sample.txt", content)})
    assert first.status_code == 200
    assert first.json()["conversionStatus"] == "ready"
    duplicate = client.post("/api/books", files={"file": ("copy.txt", content)})
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["existingBookId"] == first.json()["id"]
    assert len(client.get("/api/books").json()) == 1
    assert len(list((data_dir / "books").iterdir())) == 1


def test_epub_metadata_cover_and_search(app_module):
    _, client, _ = app_module
    response = client.post(
        "/api/books",
        files={"file": ("book.epub", make_epub(
            creators=("Jane Reader;", "John Writer;", "jane reader"),
            include_cover=True,
        ))},
    )
    assert response.status_code == 200, response.text
    book = response.json()
    assert book["title"] == "A Test Book"
    assert book["author"] == "Jane Reader, John Writer"
    assert book["language"] == "en"
    assert book["publisher"] == "Pine House"
    assert book["description"] == "A sample description"
    assert book["identifier"] == "978-1-2345-6789-7"
    assert book["series"] == "Garden Stories"
    assert book["seriesIndex"] == 2
    assert book["hasCover"] is True
    cover = client.get(f"/api/books/{book['id']}/cover")
    assert cover.status_code == 200
    assert cover.headers["cache-control"] == "public, max-age=86400"
    assert cover.headers["content-type"] == "image/jpeg"
    assert client.get("/api/books", params={"q": "Garden"}).json()[0]["id"] == book["id"]


def test_progress_and_manual_status_override(app_module):
    _, client, _ = app_module
    book = client.post("/api/books", files={"file": ("progress.txt", b"read me")}).json()
    updated = client.put(
        f"/api/books/{book['id']}/progress",
        json={"progress": 0.98, "locator": "chapter-5"},
    )
    assert updated.status_code == 200
    finished = client.get(f"/api/books/{book['id']}").json()
    assert finished["status"] == "finished"
    assert finished["finishedAt"]
    assert finished["lastOpenedAt"]

    patch = client.patch(f"/api/books/{book['id']}", json={"status": "want", "favorite": True})
    assert patch.status_code == 200
    client.put(
        f"/api/books/{book['id']}/progress",
        json={"progress": 0.4, "locator": "chapter-2"},
    )
    manual = client.get(f"/api/books/{book['id']}").json()
    assert manual["status"] == "want"
    assert manual["favorite"] is True
    assert client.get("/api/books", params={"status": "want"}).json()[0]["id"] == book["id"]
    assert client.get("/api/books", params={"sort": "title"}).status_code == 200


def test_patch_updates_searchable_details_and_validates_status(app_module):
    _, client, _ = app_module
    book = client.post("/api/books", files={"file": ("book.txt", b"text")}).json()
    response = client.patch(
        f"/api/books/{book['id']}",
        json={"title": "Updated Shelf Name", "author": "New Author", "series": "New Series"},
    )
    assert response.status_code == 200
    assert client.get("/api/books", params={"q": "Shelf Name"}).json()[0]["id"] == book["id"]
    assert client.patch(f"/api/books/{book['id']}", json={"title": "  "}).status_code == 422
    assert client.get("/api/books", params={"status": "invalid"}).status_code == 422


def test_calibre_conversion_failure_is_background_and_retryable(app_module, monkeypatch):
    module, client, _ = app_module
    monkeypatch.setattr(module, "calibre_executable", lambda: "missing-ebook-convert")
    response = client.post("/api/books", files={"file": ("sample.azw3", b"accepted by converter")})
    assert response.status_code == 200
    assert response.json()["conversionStatus"] == "converting"
    failed = client.get(f"/api/books/{response.json()['id']}")
    assert failed.status_code == 200
    assert failed.json()["conversionStatus"] == "failed"
    assert failed.json()["error"]
    assert client.post(f"/api/books/{response.json()['id']}/retry").status_code == 200


def test_html_text_omits_script_and_style_and_file_is_sandboxed(app_module):
    _, client, _ = app_module
    response = client.post(
        "/api/books",
        files={"file": ("page.html", b"<style>hidden style</style><p>Visible</p><script>hidden script</script>")},
    )
    book_id = response.json()["id"]
    text = client.get(f"/api/books/{book_id}/text").json()["text"]
    assert "Visible" in text
    assert "hidden" not in text
    document = client.get(f"/api/books/{book_id}/file")
    assert document.headers["content-security-policy"] == "sandbox"


def test_docx_uncompressed_limit_is_enforced(app_module, monkeypatch):
    module, client, _ = app_module
    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(archive_buffer, "w") as archive:
        archive.writestr("word/document.xml", "<document><p><r><t>hello</t></r></p></document>")
    book = client.post(
        "/api/books",
        files={"file": ("sample.docx", archive_buffer.getvalue())},
    ).json()
    monkeypatch.setattr(module, "MAX_DOCX_UNCOMPRESSED_BYTES", 1)
    response = client.get(f"/api/books/{book['id']}/text")
    assert response.status_code == 413


def test_recovery_marks_conversions_failed_and_removes_orphans(app_module):
    module, client, data_dir = app_module
    book = client.post("/api/books", files={"file": ("recover.txt", b"test")}).json()
    with module.db_session() as connection:
        connection.execute(
            "UPDATE books SET conversion_status = 'converting' WHERE id = ?",
            (book["id"],),
        )
    orphan = data_dir / "books" / "orphan.tmp"
    orphan.write_bytes(b"orphan")
    module.recover_interrupted_work()
    recovered = client.get(f"/api/books/{book['id']}").json()
    assert recovered["conversionStatus"] == "failed"
    assert not orphan.exists()


def test_annotations_collections_tags_and_device_progress(app_module):
    _, client, _ = app_module
    book = client.post("/api/books", files={"file": ("features.txt", b"annotation sample text")}).json()
    book_id = book["id"]

    highlight = client.post(
        f"/api/books/{book_id}/highlights",
        json={"locator": "page-1", "text": "sample text", "color": "green", "note": "Remember this", "progress": 0.2},
    )
    assert highlight.status_code == 200
    assert client.get(f"/api/books/{book_id}/highlights").json()[0]["note"] == "Remember this"
    changed = client.patch(f"/api/highlights/{highlight.json()['id']}", json={"color": "blue"})
    assert changed.status_code == 200
    assert changed.json()["color"] == "blue"
    assert client.get(f"/api/books/{book_id}/highlights.md").status_code == 200

    bookmark = client.post(
        f"/api/books/{book_id}/bookmarks",
        json={"locator": "page-1", "label": "A note to return to", "progress": 0.2},
    )
    assert bookmark.status_code == 200
    assert len(client.get(f"/api/books/{book_id}/bookmarks").json()) == 1
    updated_bookmark = client.patch(
        f"/api/bookmarks/{bookmark.json()['id']}", json={"label": "Revisit"}
    )
    assert updated_bookmark.status_code == 200
    assert updated_bookmark.json()["label"] == "Revisit"

    collection = client.post("/api/collections", json={"name": "Weekend reads"})
    assert collection.status_code == 200
    collection_id = collection.json()["id"]
    assert client.put(
        f"/api/collections/{collection_id}/books", json={"bookId": book_id}
    ).status_code == 200
    assert [item["id"] for item in client.get(f"/api/collections/{collection_id}/books").json()] == [book_id]
    assert client.put(f"/api/books/{book_id}/tags", json={"tags": ["fiction", " favorite "]}).json() == ["fiction", "favorite"]
    assert client.get(f"/api/books/{book_id}/tags").json() == ["favorite", "fiction"]
    assert client.get("/api/books", params={"tag": "FICTION"}).json()[0]["id"] == book_id
    assert client.get("/api/tags").json() == [
        {"name": "favorite", "bookCount": 1},
        {"name": "fiction", "bookCount": 1},
    ]

    assert client.put(
        f"/api/books/{book_id}/progress",
        json={"progress": 0.25, "locator": "page-2", "deviceId": "laptop"},
    ).status_code == 200
    client.put(
        f"/api/books/{book_id}/progress",
        json={"progress": 0.1, "locator": "page-1", "deviceId": "phone"},
    )
    progress = client.get(f"/api/books/{book_id}/device-progress", params={"device_id": "phone"}).json()
    assert progress["otherDeviceAhead"] is True
    assert progress["otherDevice"]["locator"] == "page-2"

    assert client.delete(f"/api/books/{book_id}").status_code == 200
    assert client.get(f"/api/books/{book_id}/highlights").status_code == 404


def test_annotation_exports_include_highlights_and_bookmarks(app_module):
    _, client, _ = app_module
    book = client.post(
        "/api/books", files={"file": ("export.txt", b"export sample text")}
    ).json()
    book_id = book["id"]
    highlight = client.post(
        f"/api/books/{book_id}/highlights",
        json={
            "locator": "chapter-1",
            "text": "A saved passage",
            "note": "A saved note",
            "chapter": "First Chapter",
            "progress": 0.25,
        },
    ).json()
    bookmark = client.post(
        f"/api/books/{book_id}/bookmarks",
        json={
            "locator": "chapter-2",
            "label": "Return here",
            "chapter": "Second Chapter",
            "progress": 0.75,
        },
    ).json()

    json_export = client.get(f"/api/books/{book_id}/highlights.json")
    assert json_export.status_code == 200
    exported = json_export.json()
    assert isinstance(exported, list)
    exported_highlight = next(item for item in exported if item["id"] == highlight["id"])
    assert exported_highlight["selected_text"] == "A saved passage"
    assert exported_highlight["note"] == "A saved note"
    exported_bookmark = next(item for item in exported if item["id"] == bookmark["id"])
    assert exported_bookmark == {
        "id": bookmark["id"],
        "book_id": book_id,
        "locator": "chapter-2",
        "label": "Return here",
        "chapter": "Second Chapter",
        "progress": 0.75,
        "created_at": bookmark["created_at"],
        "type": "bookmark",
    }

    markdown_export = client.get(f"/api/books/{book_id}/highlights.md")
    assert markdown_export.status_code == 200
    assert "A saved passage" in markdown_export.text
    assert "A saved note" in markdown_export.text
    assert "## Bookmarks" in markdown_export.text
    assert "Return here" in markdown_export.text
    assert "Second Chapter" in markdown_export.text
    assert "chapter-2" in markdown_export.text


def test_deleting_book_preserves_other_books_and_removes_related_data(app_module):
    module, client, data_dir = app_module
    first = client.post(
        "/api/books",
        files={"file": ("first.epub", make_epub(title="First Book", include_cover=True))},
    ).json()
    second = client.post(
        "/api/books", files={"file": ("second.txt", b"second book contents")}
    ).json()

    collection = client.post("/api/collections", json={"name": "Shared collection"}).json()
    for book in (first, second):
        book_id = book["id"]
        assert client.put(
            f"/api/collections/{collection['id']}/books", json={"bookId": book_id}
        ).status_code == 200
        assert client.put(
            f"/api/books/{book_id}/tags", json={"tags": ["shared"]}
        ).status_code == 200
        assert client.post(
            f"/api/books/{book_id}/highlights",
            json={"locator": "page-1", "text": f"{book['title']} passage"},
        ).status_code == 200
        assert client.post(
            f"/api/books/{book_id}/bookmarks",
            json={"locator": "page-2", "label": f"{book['title']} bookmark"},
        ).status_code == 200
        assert client.put(
            f"/api/books/{book_id}/progress",
            json={"progress": 0.4, "locator": "page-3", "deviceId": "reader"},
        ).status_code == 200
        assert client.post(
            f"/api/books/{book_id}/sessions",
            json={
                "startedAt": datetime.now(timezone.utc).isoformat(),
                "durationSeconds": 60,
                "progressStart": 0.2,
                "progressEnd": 0.4,
            },
        ).status_code == 200

    first_file = data_dir / "books" / f"{first['id']}.epub"
    second_file = data_dir / "books" / f"{second['id']}.txt"
    first_cover = data_dir / "covers" / f"{first['id']}.jpg"
    assert first_file.is_file()
    assert second_file.is_file()
    assert first_cover.is_file()

    assert client.delete(f"/api/books/{first['id']}").status_code == 200

    assert not first_file.exists()
    assert not first_cover.exists()
    assert second_file.is_file()
    assert client.get(f"/api/books/{first['id']}").status_code == 404
    assert client.get(f"/api/books/{second['id']}").status_code == 200
    assert client.get(f"/api/books/{second['id']}/highlights").json()[0]["selected_text"] == "second passage"
    assert client.get(f"/api/books/{second['id']}/bookmarks").json()[0]["label"] == "second bookmark"
    assert client.get(f"/api/books/{second['id']}/tags").json() == ["shared"]
    assert [
        book["id"]
        for book in client.get(f"/api/collections/{collection['id']}/books").json()
    ] == [second["id"]]
    progress = client.get(
        f"/api/books/{second['id']}/device-progress", params={"device_id": "reader"}
    ).json()
    assert progress["progress"] == 0.4
    with module.db_session() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM reading_sessions WHERE book_id = ?", (second["id"],)
        ).fetchone()[0] == 1
        for table in (
            "highlights",
            "bookmarks",
            "collection_books",
            "book_tags",
            "device_progress",
            "reading_sessions",
        ):
            assert connection.execute(
                f"SELECT COUNT(*) FROM {table} WHERE book_id = ?", (first["id"],)
            ).fetchone()[0] == 0


def test_watch_folder_imports_duplicates_and_rejects_invalid_files(
    app_module, monkeypatch: pytest.MonkeyPatch
):
    module, client, data_dir = app_module
    inbox = data_dir / "inbox"
    inbox.mkdir()
    monkeypatch.setenv("PAGEANDPINE_INBOX", str(inbox))
    contents = b"watch-folder sample"
    (inbox / "first.txt").write_bytes(contents)
    (inbox / "duplicate.txt").write_bytes(contents)
    (inbox / "invalid.pdf").write_bytes(b"not a PDF")

    async def scan_until_complete():
        task = asyncio.create_task(module.watch_inbox())
        try:
            for _ in range(100):
                imported = inbox / "imported"
                duplicates = inbox / "duplicates"
                rejected = inbox / "rejected"
                if all(
                    folder.is_dir() and any(folder.iterdir())
                    for folder in (imported, duplicates, rejected)
                ):
                    return
                await asyncio.sleep(0.05)
            pytest.fail("The inbox scanner did not process all files.")
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(scan_until_complete())
    assert len(client.get("/api/books").json()) == 1
    assert len(list((inbox / "imported").iterdir())) == 1
    assert len(list((inbox / "duplicates").iterdir())) == 1
    assert len(list((inbox / "rejected").iterdir())) == 1


def test_opds_stats_and_optional_features(app_module, monkeypatch):
    _, client, _ = app_module
    book = client.post("/api/books", files={"file": ("catalog.txt", b"sample")}).json()
    feed = client.get("/opds")
    assert feed.status_code == 200
    root = ElementTree.fromstring(feed.content)
    assert root.find("{http://www.w3.org/2005/Atom}title").text == "Page & Pine Library"
    assert book["id"] in feed.text

    session = client.post(
        f"/api/books/{book['id']}/sessions",
        json={"startedAt": datetime.now(timezone.utc).isoformat(), "durationSeconds": 600, "progressStart": 0, "progressEnd": 0.1},
    )
    assert session.status_code == 200
    stats = client.get("/api/stats").json()
    assert stats["secondsRead"] >= 600
    assert isinstance(stats["daily"], list)

    disabled = client.post("/api/ai/explain", json={"passage": "Example"})
    assert disabled.status_code == 503
    monkeypatch.setenv("PAGEANDPINE_PIN", "test-pin")
    assert client.get("/api/books").status_code == 401
    assert client.get("/opds").status_code == 401
    login = client.post("/api/auth/login", json={"pin": "test-pin"})
    assert login.status_code == 200
    assert client.get("/api/books").status_code == 200


def test_pin_login_rate_limit(app_module, monkeypatch: pytest.MonkeyPatch):
    _, client, _ = app_module
    monkeypatch.setenv("PAGEANDPINE_PIN", "test-pin")
    for _ in range(5):
        response = client.post("/api/auth/login", json={"pin": "wrong-pin"})
        assert response.status_code == 401
    limited = client.post("/api/auth/login", json={"pin": "wrong-pin"})
    assert limited.status_code == 429
