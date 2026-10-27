# HTTP and Reader Contracts

This is a planning reference for the existing user-facing contracts. It is
not a replacement for generated OpenAPI or a promise to change endpoint
behavior. Preserve current routes and payloads unless a verified requirement
gap requires a reviewed, documented change.

## General Behavior

- The browser uses same-origin JSON endpoints under `/api/`, plus the OPDS
  catalog at `/opds`.
- JSON validation and application errors use a JSON `detail` value. Relevant
  outcomes include 401 for missing or invalid PIN sessions, 404 for missing
  library items, 409 for duplicates or invalid conversion retries, 413 for
  oversized input, 415 for unsupported formats or operations, 422 for invalid
  input, 429 for rate limits, and 503 when an optional capability is
  unavailable.
- When `PAGEANDPINE_PIN` is configured, API routes and `/opds` require the
  signed HTTP-only session cookie, except for auth status, login, and logout.
  The static application shell is served separately.
- External AI passage requests are issued only after browser confirmation.
  The server accepts configured HTTPS destinations (localhost is permitted
  for development), keeps the provider key server-side, and rate-limits
  requests.
- The upload limit is 150 MiB. A duplicate upload returns 409 with the
  existing book identifier. Formats requiring Calibre are unavailable if its
  conversion tool cannot be found.

## Endpoint Inventory

### Service and capabilities

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/health` | Returns `{"status":"ok"}`. |
| GET | `/api/capabilities` | Returns supported `formats` and whether `calibre` conversion is available. |

### Books and reading progress

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/books` | Lists books. Supports `q`, `status`, `sort`, `favorite`, and `tag` filters. |
| POST | `/api/books` | Accepts multipart field `file`; returns the created book record. |
| GET | `/api/books/{book_id}` | Returns one book record. |
| POST | `/api/books/{book_id}/retry` | Retries a failed conversion when the converter is available. |
| GET | `/api/books/{book_id}/cover` | Returns an extracted JPEG cover when present. |
| GET | `/api/books/{book_id}/file` | Returns the book file for the reader or catalog client. |
| GET | `/api/books/{book_id}/text` | Returns `{"text": ...}` for supported text documents. |
| PUT | `/api/books/{book_id}/progress` | Accepts `progress` from 0 to 1, `locator`, and optional `deviceId`; updates the reading position. |
| PATCH | `/api/books/{book_id}` | Updates one or more of `title`, `author`, `series`, `status`, and `favorite`. |
| DELETE | `/api/books/{book_id}` | Deletes the book and its associated records and files; browser confirmation precedes this call. |
| GET | `/api/books/{book_id}/device-progress` | Requires `device_id`; returns the saved position and whether another device is ahead. |
| POST | `/api/books/{book_id}/sessions` | Records `startedAt`, `durationSeconds`, `progressStart`, and `progressEnd` for reading statistics. |

Book list and detail records include the book identifier, metadata, original
and reader formats, conversion state, file size, progress and locator,
timestamps, cover availability, status, and favorite state. Do not expose
server secrets or physical storage paths in book records.

### Annotations

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/books/{book_id}/highlights` | Lists highlights and notes for a book. |
| POST | `/api/books/{book_id}/highlights` | Creates a highlight from `locator`, `text`, optional `color`, `note`, `chapter`, and `progress`. |
| PATCH | `/api/highlights/{highlight_id}` | Updates a highlight's `color` and/or `note`. |
| DELETE | `/api/highlights/{highlight_id}` | Deletes a highlight. |
| GET | `/api/books/{book_id}/highlights.json` | Exports highlights and their notes as JSON, plus additive bookmark entries with `type: "bookmark"`, `label`, `chapter`, `progress`, and `locator`. |
| GET | `/api/books/{book_id}/highlights.md` | Exports highlights and their notes as Markdown, followed by a Bookmarks section containing each bookmark's label, chapter, progress, and locator. |
| GET | `/api/books/{book_id}/bookmarks` | Lists bookmarks for a book. |
| POST | `/api/books/{book_id}/bookmarks` | Creates a bookmark from `locator`, optional `label`, `chapter`, and `progress`. |
| PATCH | `/api/bookmarks/{bookmark_id}` | Updates a bookmark label. |
| DELETE | `/api/bookmarks/{bookmark_id}` | Deletes a bookmark. |

Progress values are between 0 and 1. Highlight colors are yellow, green,
blue, or pink. Stored locators are book-format reader positions; they are not
portable identifiers guaranteed to resolve after the source book changes.

### Collections, tags, and statistics

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/collections` | Lists collections with their `id`, `name`, `description`, `created_at`, and `book_count`. |
| POST | `/api/collections` | Creates a collection with a non-empty `name` and optional `description`. |
| GET | `/api/collections/{collection_id}/books` | Lists the collection's books. |
| PUT | `/api/collections/{collection_id}/books` | Adds the `bookId` from the JSON body to a collection. |
| DELETE | `/api/collections/{collection_id}/books/{book_id}` | Removes a book from a collection. |
| DELETE | `/api/collections/{collection_id}` | Deletes a collection. |
| GET | `/api/books/{book_id}/tags` | Lists tag names for a book. |
| GET | `/api/tags` | Lists tags with their book counts. |
| PUT | `/api/books/{book_id}/tags` | Replaces a book's tag set using `{"tags":[...]}`. |
| GET | `/api/stats` | Returns books finished, seconds read, reading streak, and daily reading totals. |

Tag updates accept at most 50 values; each trimmed name is at most 80
characters. Collection names are unique.

### PIN and optional AI

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/auth/status` | Returns whether PIN protection is enabled and the current session is authenticated. |
| POST | `/api/auth/login` | Accepts `{"pin":"..."}`; success sets the session cookie. |
| POST | `/api/auth/logout` | Clears the session cookie. |
| GET | `/api/ai/config` | Reports whether AI is enabled/configured and whether it uses an external service; never returns credentials. |
| POST | `/api/ai/explain` | Accepts `passage`, optional `question`, and the supported provider selection; returns `{"answer": ...}`. Browser consent is required before submission. |

### OPDS

`GET /opds` returns an Atom-based OPDS acquisition feed for ready books. Each
entry provides title, author, update time, an acquisition link, and an image
link when a cover is available. The same PIN session requirement as protected
API access applies when authentication is enabled.

## Browser-Only Contracts

- Reading preferences are saved per device and do not imply server-side
  preference synchronization.
- The service worker caches the local app shell and may cache books already
  opened on that device. With PIN protection required, offline book caching
  must be disabled and cached book-file responses must not be served.
- Speech, install prompts, offline storage, and other browser capabilities
  are optional enhancements; absence of a capability must not prevent the
  core library and reading flows from working.
