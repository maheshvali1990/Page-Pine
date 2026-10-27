# Data Model: Self-Hosted Ebook Library and Reader

This model describes the existing product concepts and persisted state.
Implementation work should preserve these records and relationships unless a
verified specification gap requires a migration.

## Persisted Entities

### Book

Represents one book in the owner's library.

- **Identity**: `id`.
- **Content reference**: `original_name`, `original_format`,
  `reader_format`, `file_name`, `size`, and `sha256`.
- **Bibliographic details**: `title`, `author`, `language`, `publisher`,
  `description`, `identifier`, `series`, `series_index`, and `has_cover`.
- **Library state**: `added_at`, `conversion_status`, `error`, `status`,
  `status_manual`, and `favorite`.
- **Reading state**: `progress`, `locator`, `last_opened_at`, and
  `finished_at`.
- **Validation rules**: The SHA-256 digest is unique when present; progress is
  between 0 and 1; status is `want`, `reading`, or `finished`; conversion
  state is `ready`, `converting`, or `failed`. Book files and covers resolve
  directly within their configured storage directories.

### Highlight

Represents selected book text and the reader's associated note.

- **Identity and relationship**: `id`, `book_id` (many highlights to one
  book; deleting the book cascades).
- **Content and location**: `locator`, `selected_text`, `chapter`,
  `progress`, `color`, and `note`.
- **Timestamps**: `created_at`, `updated_at`.
- **Validation rules**: Location and selected text are non-empty; progress is
  between 0 and 1; color is one of yellow, green, blue, or pink.

### Bookmark

Represents a named or unnamed reading location.

- **Identity and relationship**: `id`, `book_id` (many bookmarks to one
  book; deleting the book cascades).
- **Content and location**: `locator`, `label`, `chapter`, and `progress`.
- **Timestamp**: `created_at`.
- **Validation rules**: Locator is non-empty; progress is between 0 and 1.

### Collection and Collection Membership

Groups books under an owner-defined name.

- **Collection fields**: `id`, unique `name`, `description`, and `created_at`.
- **Membership fields**: `collection_id`, `book_id`.
- **Relationships**: Many-to-many between collections and books. Removing a
  book or collection removes its memberships.
- **Validation rules**: Collection name is non-empty and unique.

### Tag and Book Tag

Provides reusable labels for filtering books.

- **Tag fields**: `id`, unique `name`.
- **Membership fields**: `book_id`, `tag_id`.
- **Relationships**: Many-to-many between books and tags. Tags are normalized
  case-insensitively when assigned; deleting a book removes its memberships.
- **Validation rules**: At most 50 tags per update; names are trimmed and at
  most 80 characters.

### Device Progress

Stores the latest known location for a book on a browser device.

- **Identity**: Composite key `(book_id, device_id)`.
- **Fields**: `progress`, `locator`, `updated_at`.
- **Relationships**: Many device positions to one book; deleting the book
  cascades.
- **Validation rules**: Progress is between 0 and 1; device identifier is
  non-empty and at most 100 characters.
- **Behavior**: Used to tell a reader that another device is further ahead
  and offer an explicit choice; it is not cloud synchronization.

### Reading Session

Records a completed period of reading for statistics.

- **Identity and relationship**: `id`, `book_id` (many sessions to one book;
  deleting the book cascades).
- **Fields**: `started_at`, `duration_seconds`, `progress_start`,
  `progress_end`.
- **Validation rules**: Duration is from 1 through 86,400 seconds; start and
  end progress are between 0 and 1.

### Schema Migration

Records which numbered SQLite migrations have been applied.

- **Fields**: `version` (primary key), `applied_at`.
- **Invariant**: Migrations run once, transactionally, and must preserve
  existing library data.

## Device-Local State

### Reader Preferences

Reader display and navigation settings are retained in browser storage,
including theme, typeface, text size, line height, column width, alignment,
hyphenation, page flow, spread, and optional page-refresh behavior. These are
per-device preferences and are not canonical library records.

### Device Identity and Offline Copies

The browser stores a device identifier for progress reporting. The service
worker may cache the local app shell and previously opened book files for
offline use when supported. Offline caching is disabled while PIN protection
is enabled.

## Configuration and Secrets

PIN and optional AI settings are supplied through the server environment.
Session-signing material is stored in the configured data directory. API keys
must not be stored in browser state or returned to the browser.

## Key Relationships

```text
Book 1 ── * Highlight
Book 1 ── * Bookmark
Book * ── * Collection
Book * ── * Tag
Book 1 ── * Device Progress
Book 1 ── * Reading Session
```
