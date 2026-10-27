# Implementation Plan: Self-Hosted Ebook Library and Reader

**Branch**: `not created` | **Date**: 2026-10-24 | **Spec**: [spec.md](./spec.md)

**Input**: Product specification based on the Page & Pine README.

## Summary

Deliver the specified self-hosted library and browser reader by preserving and
validating the product's existing vertical slices rather than replacing its
architecture. The project already contains the main library, reader,
annotations, PIN access, imports, OPDS, AI, offline, and speech surfaces.
Implementation work must first compare each requirement against this baseline,
then make only the changes needed to close verified gaps. One known gap is that
the existing Markdown and JSON export routes serialize highlights and notes,
not bookmarks, while the specification includes bookmarks in export.
Preserve local data, existing API behavior, format compatibility, and explicit
consent boundaries.

## Technical Context

**Language/Version**: Python 3.10 or newer; browser-native JavaScript, HTML,
and CSS.

**Primary Dependencies**: FastAPI, Pydantic, Uvicorn, SQLite, pytest, and
httpx. EPUB.js, PDF.js, and other reader assets are bundled locally.
Optional Calibre conversion uses the installed `ebook-convert` executable.

**Storage**: SQLite database and book/cover files under `PAGEANDPINE_DATA`
(default: repository `data/`); reader preferences and device identity are
stored in the browser; service-worker caches are device-local.

**Testing**: pytest and httpx; backend integration tests live in
`tests/test_backend.py`. Browser behavior requires validation in supported
desktop and mobile browsers.

**Target Platform**: Self-hosted Python server accessed through desktop,
mobile, and tablet browsers. PWA installation and offline capabilities depend
on browser support and a secure context.

**Project Type**: Single-project web application with a Python backend and
static browser frontend.

**Performance Goals**: Meet the user-focused measures in the specification.
No additional throughput target is defined. Preserve the existing 150 MiB
upload limit and existing conversion timeout unless a separately approved
requirement changes them.

**Constraints**: No user accounts, hosted cloud sync, DRM removal, or direct
public-internet deployment. Core reader resources remain local. PIN protection
is a shared-library gate; optional integrations must remain opt-in and
external text must be disclosed and confirmed before sending.

**Scale/Scope**: One self-hosted library with a private collection and
trusted readers, multiple reader devices, the documented supported formats,
and the optional capabilities described in the specification.

## Constitution Check

- **Privacy & Local Ownership**: Pass. Keep books and reading records in the
  configured library; retain device-scoped behavior without representing it as
  cloud sync; require confirmation for external text sharing.
- **Secure-by-Default Operation**: Pass. Preserve input validation, bounded
  file handling, safe path checks, optional PIN protection, rate limits, and
  deployment warnings.
- **Reader-Centered Compatibility**: Pass. Preserve documented format and
  device behavior; optional browser capabilities must not block core reading.
- **Data Integrity & Safe Migrations**: Pass. Any schema change requires an
  additive, transactional migration and regression coverage for existing
  libraries.
- **Tested, Maintainable Changes**: Pass. Extend focused tests and keep changes
  within the existing backend/frontend structure; document user-visible
  changes.
- **Gate result**: No constitution violations identified. No exception or
  complexity justification is required.

## Project Structure

### Documentation (this feature)

```text
specs/001-self-hosted-ebook-library/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── API.md
└── tasks.md              # Created later by /speckit-tasks
```

### Source Code (repository root)

```text
app.py                     # FastAPI routes, persistence, imports, integrations
run.py                     # Server entry point
static/
├── app.js                 # Library, reader, preferences, PWA interactions
├── index.html             # Application and reader interface
├── service-worker.js      # App-shell and offline book caching
├── styles.css
├── vendor/                # Locally hosted reader libraries and fonts
└── fonts/
tests/
└── test_backend.py        # Backend behavior, persistence, and API tests
```

**Structure Decision**: Keep the existing single-project web application.
Implement verified gaps in the owning surface (`app.py`, `static/`, or
`tests/test_backend.py`); do not introduce new services or a second frontend.
Create contracts and further design notes under this feature directory.

## Complexity Tracking

No constitution violations or additional architectural components are
proposed.
