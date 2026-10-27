# Research: Self-Hosted Ebook Library and Reader

## Decisions

### Retain the existing application architecture

- **Decision**: Keep the FastAPI backend, SQLite persistence, and static
  browser frontend. Use the existing API and user flows as the compatibility
  baseline; plan implementation work as gap closure rather than a rewrite.
- **Rationale**: The repository already has a single-process self-hosted
  application, a versioned migration sequence, browser readers, and backend
  tests. A replacement architecture would increase migration and privacy
  risk without a user requirement for it.
- **Alternatives considered**: Split the backend and frontend into separate
  services or add a hosted account/synchronization service. Both add
  operational and data-sharing complexity and conflict with the product's
  local-ownership and no-cloud-sync scope.

### Keep library records and reading state locally owned

- **Decision**: Continue storing the canonical library and shared reading
  records in the configured local data directory. Keep preferences and
  device identity in browser-local storage; use the existing per-device
  progress records only to offer the reader a choice between positions.
- **Rationale**: This matches the self-hosted model and avoids implying that
  the application synchronizes data through a hosted service.
- **Alternatives considered**: Cloud synchronization or a central account
  system. These are explicitly outside the specification.

### Treat optional integrations as explicit capability boundaries

- **Decision**: Keep PIN access, Calibre conversion, watched-folder imports,
  OPDS, offline support, dictionary lookup, AI assistance, and speech
  optional. Preserve confirmation before external text sharing and server-side
  handling of AI credentials.
- **Rationale**: The product's primary library and reader must remain useful
  without optional services, and readers must know when private text leaves
  their server.
- **Alternatives considered**: Require a provider account or external
  service for core reading. This would violate local operation and privacy
  commitments.

### Preserve the existing contract and data model unless a requirement proves
otherwise

- **Decision**: Treat the routes and persisted entities summarized in
  [contracts/API.md](./contracts/API.md) and [data-model.md](./data-model.md)
  as the compatibility baseline. Change them only to close a requirement gap,
  and add focused regression tests for any changed behavior.
- **Rationale**: Existing integrations, reading clients, and user libraries
  depend on current behavior; unnecessary contract or schema changes create
  avoidable migration risk.
- **Alternatives considered**: Redesign the API or schema before gap analysis.
  No requirement justifies that broader change.

## Repository Findings

- The server uses Python 3.10-compatible syntax, FastAPI, Pydantic, and
  SQLite. Data files are rooted in `PAGEANDPINE_DATA`.
- Migrations are numbered and transactional; existing tables include books,
  annotations, collections, tags, per-device progress, and reading sessions.
- The browser app is served from `static/`, with local EPUB/PDF reader
  libraries, reader settings, an installable app shell, and service-worker
  book caching.
- Backend tests already cover migrations, uploads and duplicates, EPUB
  metadata and search, progress, metadata changes, conversion recovery,
  HTML/DOCX handling, annotations and organization, watched-folder imports,
  OPDS, statistics, optional features, and PIN throttling.
- Documented deployment cautions and optional feature configuration are
  defined in [README.md](../../README.md).

## Verified Specification Gap

- **Annotation export**: The specification requires Markdown and JSON export
  of annotations including bookmarks. The current export routes serialize
  highlights and their notes; bookmarks have separate list/create/update/
  delete routes but are not included in those exports. Treat bookmark export
  as a verified requirement gap, and add focused coverage when implementing
  it rather than assuming the existing export meets FR-008.

## Open Questions

No unknown technical choices block the initial plan. The bookmark-export
mismatch above is a concrete work item, not an unresolved question. The product
specification provides reasonable boundaries for optional integrations and
browser-dependent capabilities. Implementation should verify each other
stated outcome against the current code and tests before changing behavior.
