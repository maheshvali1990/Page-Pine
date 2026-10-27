# Quickstart Validation: Page & Pine

Use an isolated temporary data directory for manual checks so a personal
library is not changed. The project uses Windows PowerShell commands below.

## Prerequisites

- Python 3.10 or newer.
- Development dependencies installed in the project virtual environment.
- A small, non-DRM test book in a supported format. Do not use private books
  for external-service tests.
- Optional: Calibre installed and `ebook-convert` available on `PATH` to
  validate conversion formats.

## Start with isolated data

From the repository root:

```powershell
.\.venv\Scripts\Activate.ps1
$env:PAGEANDPINE_DATA = Join-Path $env:TEMP "pageandpine-validation"
python run.py
```

Open `http://localhost:8000` in a browser. Keep this server session open while
running manual scenarios.

## Automated checks

In a second PowerShell window from the repository root:

```powershell
.\.venv\Scripts\Activate.ps1
pytest -q
```

Expected outcome: all backend tests pass, including migration preservation,
import validation and duplicate handling, search and metadata, progress,
annotations and organization, conversion recovery, optional access, and PIN
throttling.

## End-to-end scenarios

1. **Library**: Add one supported book; verify its title and author appear;
   search for it; edit its metadata; assign a tag and collection; cancel a
   delete confirmation and verify it remains; confirm deletion and verify it
   is gone.
2. **Reader**: Open EPUB, PDF, and text samples where available; use each
   format's navigation and supported preferences; verify the layout remains
   usable at desktop and mobile viewport sizes.
3. **Progress and annotations**: Save a position, close and reopen the same
   book, create a highlight/note and bookmark, then export annotations as
   Markdown and JSON. Verify both the highlight/note and bookmark are present
   in each export. This checks the FR-008 export gap noted in
   [research.md](./research.md). If two devices are available, confirm that
   the further-ahead prompt offers a choice rather than automatic sync.
4. **Optional capabilities**: With PIN, AI, and inbox settings unset, confirm
   core library use works. Test optional PIN and watch-folder behavior only
   with a disposable data directory. For AI or dictionary checks, use a
   non-sensitive excerpt and verify no request is sent before confirmation.
5. **Offline**: In a supported secure context, open the app and a test book,
   then disconnect the client and confirm the app shell and cached book work.
   Repeat with PIN protection enabled and verify the book is not available
   offline.

## Validation record

- **2026-10-27 backend**: `python -m pytest -q tests/test_backend.py -k
  "deleting_book_preserves_other_books_and_removes_related_data or
  annotation_exports_include_highlights_and_bookmarks or
  progress_and_manual_status_override or
  annotations_collections_tags_and_device_progress or
  watch_folder_imports_duplicates_and_rejects_invalid_files or
  opds_stats_and_optional_features or pin_login_rate_limit"` passed: 7
  tests passed, 8 deselected. The run emitted only the existing
  Starlette/httpx deprecation warning.
- **2026-10-27 browser**: Local reader smoke validation passed for the
  library shell at desktop and narrow mobile viewport sizes. The local app
  loaded without external reader-resource requests; core navigation remained
  available without optional speech/install capabilities. Full EPUB/PDF
  fixture validation remains dependent on supplying local EPUB and PDF sample
  files.
- **2026-10-27 optional capabilities**: The focused watch-folder, OPDS,
  optional-feature, and PIN-throttling backend tests passed above. Manual
  AI/dictionary confirmation and PIN-aware offline checks require a separate
  disposable server run with those environment settings enabled.

## Acceptance References

See [spec.md](./spec.md) for measurable outcomes,
[data-model.md](./data-model.md) for persisted and browser-local state, and
[contracts/API.md](./contracts/API.md) for the endpoint and browser contracts.
