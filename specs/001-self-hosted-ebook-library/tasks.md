# Tasks: Self-Hosted Ebook Library and Reader

**Input**: Design documents from
`/specs/001-self-hosted-ebook-library/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/API.md, quickstart.md

**Organization**: Tasks are grouped by the four user stories in spec.md.
The existing application already implements most specified flows; tasks focus
on verified coverage gaps and acceptance validation rather than rewriting
working capabilities.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the current application baseline before changing it.

- [X] T001 Run `pytest -q tests/test_backend.py` to establish the backend test baseline before feature work; use `tests/test_backend.py` as the baseline suite.

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Confirm shared prerequisites for story work.

The FastAPI application, SQLite migrations, browser frontend, and test fixture
already exist. No new foundational implementation is required; user-story
tasks can begin after T001.

## Phase 3: User Story 1 - Manage a Personal Library (Priority: P1)

**Goal**: Preserve the existing book-management flow and verify that removal
cleans up the selected book's related data without affecting other books.

**Independent Test**: Add two books, organize one, create reading data for
both, delete one after confirmation, and verify the other and its data remain.

### Tests and implementation

- [X] T002 [P] [US1] Add a regression test in `tests/test_backend.py` that deleting one book removes its book file, cover, and cascaded annotations, bookmarks, collection memberships, tags, device progress, and reading sessions while preserving a second book and its data.

**Checkpoint**: User Story 1 passes its existing upload, duplicate, search,
metadata, collection, tag, and delete tests plus the new deletion-isolation
regression test.

## Phase 4: User Story 2 - Read Across Devices (Priority: P1)

**Goal**: Validate the implemented reader on desktop and mobile viewports,
including format-specific navigation and core reading without optional
browser capabilities.

**Independent Test**: Follow the reader scenario in
`specs/001-self-hosted-ebook-library/quickstart.md` using EPUB, PDF, and text
samples on desktop and mobile-sized screens.

### Acceptance validation

- [X] T003 [P] [US2] Execute and record the desktop/mobile EPUB, PDF, and text reader scenarios in `specs/001-self-hosted-ebook-library/quickstart.md`, checking saved preferences, PDF navigation and selectable text, EPUB/PDF in-book search, locally served reader resources, and that missing optional browser capabilities do not block core reading.

**Checkpoint**: The core reading scenarios in User Story 2 pass at both
viewport sizes and use locally served reader resources.

## Phase 5: User Story 3 - Resume and Annotate Reading (Priority: P2)

**Goal**: Preserve reading positions and annotations, and close the verified
gap where Markdown and JSON exports omit bookmarks.

**Independent Test**: Create a highlight with a note and a bookmark for a
book, export both formats, and verify both annotation types and their
associated content are present.

### Tests

- [X] T004 [US3] Run the existing `test_progress_and_manual_status_override` and `test_annotations_collections_tags_and_device_progress` cases in `tests/test_backend.py`, then record same-device resume and cross-device position-choice results in `specs/001-self-hosted-ebook-library/quickstart.md`.
- [X] T005 [US3] Add a regression test in `tests/test_backend.py` that creates a highlight with a note and a bookmark, then asserts the Markdown and JSON exports include both annotation types, their locations, and their saved content while retaining the existing JSON list response.

### Implementation

- [X] T006 [US3] Update the Markdown and JSON export handlers in `app.py` to include bookmarks alongside highlights; keep existing routes and highlight fields, represent JSON bookmarks as additive entries with `type: "bookmark"`, and include bookmark label, chapter, progress, and locator in both exports.
- [X] T007 [US3] Document the additive bookmark export entries and Markdown representation in `specs/001-self-hosted-ebook-library/contracts/API.md` and clarify in `README.md` that both highlights and bookmarks can be exported as Markdown or JSON.

**Checkpoint**: User Story 3 passes the existing progress and annotation
tests, cross-device position-choice validation, and the new export regression
test for both formats.

## Phase 6: User Story 4 - Use Optional Access and Reading Services (Priority: P3)

**Goal**: Verify optional PIN, watched-folder, catalog, AI-consent, and offline
behavior without making optional integrations prerequisites for core reading.

**Independent Test**: Follow the optional-capability scenarios in
`specs/001-self-hosted-ebook-library/quickstart.md` with an isolated data
directory, checking both disabled and enabled behavior where available.

### Acceptance validation

- [X] T008 [US4] Run `pytest -q tests/test_backend.py -k "watch_folder_imports_duplicates_and_rejects_invalid_files or opds_stats_and_optional_features or pin_login_rate_limit"` and record isolated-data validation of AI/dictionary confirmation and PIN-aware offline caching in `specs/001-self-hosted-ebook-library/quickstart.md`.

**Checkpoint**: User Story 4 passes the existing backend tests and confirms
that unconfirmed external requests are not sent and PIN-protected book files
are unavailable offline.

## Final Phase: Polish & Cross-Cutting Concerns

**Purpose**: Run the complete acceptance suite and confirm documentation and
repository quality gates.

- [X] T009 Run `pytest -q`, execute the completed scenarios in `specs/001-self-hosted-ebook-library/quickstart.md`, and check documentation changes in `README.md` and `specs/001-self-hosted-ebook-library/contracts/API.md` against `specs/001-self-hosted-ebook-library/spec.md`.

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 establishes the existing backend test baseline.
- **Foundational (Phase 2)**: No new work; the shared infrastructure is
  already present.
- **User Stories (Phases 3-6)**: Start after T001. T002 and T003 can proceed
  in parallel because they touch separate files. T004 and T008 share test and
  quickstart files with other tasks and are best run sequentially.
  User Story 3 follows test-first order for the export gap: T005, then T006,
  then T007.
- **Polish (Final Phase)**: T009 follows all story tasks.

### User Story Dependencies

- **User Story 1 (P1)**: Independent after T001; verifies library integrity.
- **User Story 2 (P1)**: Independent after T001; validates the existing
  browser reader.
- **User Story 3 (P2)**: Depends on existing book and annotation records;
  implementation can start after T001. T005 precedes T006 and T007; T004
  validates the existing progress behavior independently.
- **User Story 4 (P3)**: Independent after T001; optional capabilities do not
  block core library or reader use.

### Parallel Opportunities

- T002 and T003 can run in parallel: the former edits
  `tests/test_backend.py`, while the latter updates
  `specs/001-self-hosted-ebook-library/quickstart.md`.
- T005 must finish before T006 because it verifies the required export
  behavior; T006 documents T005's result.
- T009 is a final integration check and is not parallelizable with unfinished
  implementation or validation tasks.

## Parallel Execution Examples

```text
# After T001, separate contributors can take different stories:
T002: deletion integrity regression in tests/test_backend.py
T003: desktop/mobile reader acceptance in specs/001-self-hosted-ebook-library/quickstart.md
```

## Implementation Strategy

### MVP First

1. Run T001 to establish the backend baseline.
2. Complete T002 and verify the library's independent add, organize, and
   remove journey.
3. Validate User Story 1 before proceeding to reader and optional features.

### Incremental Delivery

1. Validate User Story 1 and preserve library data integrity.
2. Validate User Story 2 independently on desktop and mobile.
3. Close the bookmark export gap in User Story 3 using test-first order.
4. Validate optional capabilities in User Story 4 without making them
   prerequisites for core use.
5. Complete T009 as the final cross-story acceptance gate.

## Phase 7: Convergence

The implementation contains the required reader and optional-capability code,
but the prior acceptance record did not exercise all environment-dependent
scenarios. Complete these validation tasks before treating the feature as
fully converged.

- [ ] T010 [US2] Run the complete reader acceptance matrix with local EPUB, PDF, and text fixtures at desktop and mobile viewport sizes; verify format-specific navigation, saved preferences and positions, PDF zoom/fit/page navigation/selectable text, EPUB/PDF in-book search, locally served reader resources, and graceful operation when optional browser capabilities are unavailable, then update `specs/001-self-hosted-ebook-library/quickstart.md` (FR-006, FR-008, US2/AC1-5; partial).
- [ ] T011 [US4] Run isolated enabled and disabled optional-capability validation with disposable data and browser state; verify AI/dictionary disclosure and confirmation suppress unconfirmed requests, confirmed requests use only the disclosed destination and text, and PIN protection disables offline book caching while core access remains protected, then update `specs/001-self-hosted-ebook-library/quickstart.md` (FR-013, FR-014, US4/AC4-5; partial).
