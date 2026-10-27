# Feature Specification: Self-Hosted Ebook Library and Reader

**Feature Branch**: `not created`

**Created**: 2026-10-24

**Status**: Draft

**Input**: User description: "Use the README as the reference to create a product-level specification for Page & Pine."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Manage a Personal Library (Priority: P1)

A library owner adds ebooks to a private library, browses and searches the
collection, organizes books, and removes a book when it is no longer wanted.

**Why this priority**: A useful reader depends on readers being able to find
and manage the books they own.

**Independent Test**: Add a supported book, find it in the library, change its
organization or metadata, and remove it after confirming the action.

**Acceptance Scenarios**:

1. **Given** a valid supported ebook, **When** the owner adds it, **Then** it
   appears in the library with its available title, author, and cover
   information.
2. **Given** a populated library, **When** the owner searches or filters by a
   tag, **Then** only matching books are shown and the owner can open a result.
3. **Given** a book in the library, **When** the owner marks it as a favorite,
   changes its status, edits its metadata, assigns a tag, or places it in a
   collection, **Then** the chosen details and organization are visible when
   browsing the library.
4. **Given** a book selected for removal, **When** the owner cancels the
   confirmation, **Then** it remains in the library; **When** the owner
   confirms, **Then** it is removed from the library.
5. **Given** a duplicate, damaged, unsupported, or DRM-protected file,
   **When** the owner tries to add it, **Then** the system identifies the
   outcome and does not silently replace an existing book.
6. **Given** books and related reading data in the owner's library, **When**
   the owner uses the library, **Then** those items remain under the owner's
   control and are not sent to an unrelated external service.

### User Story 2 - Read Across Devices (Priority: P1)

A reader opens a book and reads comfortably on a desktop, phone, or tablet.
The reader can adjust available reading preferences and use navigation
appropriate to the book format.

**Why this priority**: Reading is the core value of the product; format-aware,
responsive reading makes the library useful on the owner's devices.

**Independent Test**: Open one supported book on a desktop-sized screen and a
mobile-sized screen, navigate through it, and verify that the reading view
remains usable.

**Acceptance Scenarios**:

1. **Given** a supported book in the library, **When** the reader opens it,
   **Then** the content is readable and the available navigation matches the
   format.
2. **Given** a reader using a supported format, **When** they adjust a
   preference that format supports, **Then** the reading view reflects the
   selection and retains it for that device.
3. **Given** a PDF, **When** the reader navigates or adjusts its view, **Then**
   page navigation, zoom or fit controls, and selectable text are available.
4. **Given** a narrow screen or a browser capability that is unavailable,
   **When** the reader opens a book, **Then** the core reading task remains
   usable, core reader resources do not depend on an unrelated external
   delivery service, and unavailable enhancements do not prevent reading.
5. **Given** an EPUB or PDF with searchable text, **When** the reader searches
   within the open book, **Then** matching text can be found in that book.

### User Story 3 - Resume and Annotate Reading (Priority: P2)

A reader can continue where they left off and keep personal highlights,
bookmarks, and notes with the book. They can export those annotations for
their own use.

**Why this priority**: Progress and annotations support sustained reading
without requiring a cloud account or centralized service.

**Independent Test**: Read part of a book, save a position and an annotation,
leave and reopen the book, then verify the position and annotation and export
the annotation.

**Acceptance Scenarios**:

1. **Given** a saved reading position, **When** the reader reopens that book
   on the same device, **Then** the reader can return to the saved position.
2. **Given** a book with saved positions on multiple devices, **When** the
   reader opens it on a device that is behind, **Then** the reader is offered
   the option to move to the further-ahead position; positions are not
   presented as automatic cloud synchronization.
3. **Given** a passage in a supported reader, **When** the reader creates or
   edits a highlight, note, or bookmark, **Then** the annotation remains
   associated with the book.
4. **Given** annotations for a book, **When** the reader exports them, **Then**
   the export is available in Markdown or JSON and contains the saved
   annotation content.

### User Story 4 - Use Optional Access and Reading Services (Priority: P3)

A library owner may enable shared-PIN protection, import books from a watched
folder, or use compatible catalog and reading services. Optional dictionary,
AI, speech, and offline capabilities make reading more convenient without
changing who controls the library.

**Why this priority**: These conveniences extend the self-hosted library but
are not required for adding, finding, and reading books.

**Independent Test**: Verify the library's behavior with optional services
disabled, then enable an available service and confirm its access, consent,
and failure behavior.

**Acceptance Scenarios**:

1. **Given** shared-PIN protection is enabled, **When** a client requests
   protected library or catalog content without a valid session, **Then**
   access is denied; repeated incorrect attempts are rate-limited.
2. **Given** a watched import folder is enabled, **When** a supported book is
   placed there, **Then** it is imported and moved to the appropriate
   completed, duplicate, or rejected location with its outcome identifiable.
3. **Given** a reader using a compatible catalog application, **When** they
   access the catalog, **Then** available books can be discovered; if
   protection is enabled, the same access requirements apply.
4. **Given** offline use is available in the reader's environment, **When**
   the reader has opened and cached the app and a book, **Then** they can
   continue reading that book offline; while PIN protection is enabled,
   offline book caching is disabled.
5. **Given** an optional dictionary or AI request, **When** the reader has not
   confirmed the disclosed text and destination, **Then** no external request
   is made; when confirmed and configured, only the disclosed request is
   sent.
6. **Given** browser speech support and an installed voice, **When** the reader
   starts speech, **Then** the text is spoken and the current sentence is
   indicated where supported; if speech is unavailable, reading remains
   usable.

### Edge Cases

- A file is corrupted, unsupported, DRM-protected, or has incomplete
  metadata.
- An import duplicates a book already present or is interrupted before
  completion.
- A book is removed while it has saved progress or annotations.
- A reader opens a book on a device with no saved position or with a position
  that cannot be mapped to the current book content.
- Two devices have different reading positions, or a device cannot reach the
  shared server.
- A browser lacks installation, offline storage, speech, or other optional
  capabilities.
- PIN protection is enabled while an offline copy exists, or a user makes
  repeated incorrect PIN attempts.
- The configured external provider or dictionary service is unavailable,
  rejects a request, or returns an unusable response.
- A watched-folder item cannot be moved or processed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST let the library owner add supported books and
  browse, search, and filter the resulting library. Acceptance coverage:
  User Story 1, scenarios 1-2.
- **FR-002**: The system MUST show available book cover and metadata and let
  the owner edit metadata, mark favorites, set reading status, create
  collections, and filter by tags. Acceptance coverage: User Story 1,
  scenarios 1-3.
- **FR-003**: The system MUST support opening EPUB, PDF, Word DOCX, TXT,
  Markdown, and HTML/HTM books. It MUST support the additional formats AZW3,
  AZW, MOBI, RTF, ODT, FB2, CBZ/CBR, and other convertible formats when the
  required optional conversion capability is available. It MUST identify
  unsupported, corrupted, and DRM-protected books without attempting DRM
  removal. Acceptance coverage: User Story 1, scenario 5; User Story 2,
  scenarios 1 and 4.
- **FR-004**: The system MUST identify duplicate imports and MUST NOT silently
  overwrite a different book or its data. Acceptance coverage: User Story 1,
  scenario 5; User Story 4, scenario 2.
- **FR-005**: The system MUST require confirmation before removing a book from
  the library and MUST preserve it when the owner cancels. Acceptance
  coverage: User Story 1, scenario 4.
- **FR-006**: The reader MUST provide responsive reading views and
  format-appropriate navigation and preferences. For PDF, the reader MUST
  provide page navigation, zoom or fit, and selectable text. Acceptance
  coverage: User Story 2, scenarios 1-4.
- **FR-007**: The system MUST retain supported reading preferences and
  positions per device and offer the reader a choice when another device has
  a further-ahead position. It MUST NOT represent this behavior as cloud
  synchronization. Acceptance coverage: User Story 3, scenarios 1-2.
- **FR-008**: The system MUST let readers create and edit highlights, notes,
  and bookmarks, and export annotations in Markdown or JSON. EPUB and PDF
  reading MUST support in-book search. Acceptance coverage: User Story 2,
  scenario 5; User Story 3, scenarios 3-4.
- **FR-009**: The system MUST keep books, metadata, progress, annotations,
  collections, tags, and statistics under the owner's control in the
  configured library location. Acceptance coverage: User Story 1,
  scenario 6; User Stories 1 and 3.
- **FR-010**: When enabled, shared-PIN protection MUST protect library and
  catalog access and rate-limit repeated incorrect attempts. The system MUST
  identify this as a shared-library gate, not individual user accounts.
  Acceptance coverage: User Story 4, scenario 1.
- **FR-011**: When enabled, watched-folder imports MUST classify completed,
  duplicate, and rejected items and make each outcome identifiable.
  Acceptance coverage: User Story 4, scenario 2.
- **FR-012**: The system MUST offer an acquisition catalog to compatible
  reading applications and apply configured access protection to that
  catalog. Acceptance coverage: User Story 4, scenario 3.
- **FR-013**: Where supported, the system MUST allow offline access to the
  app and locally opened books, and MUST disable offline book caching while
  PIN protection is enabled. Acceptance coverage: User Story 4, scenario 4.
- **FR-014**: Optional dictionary lookup and AI features MUST disclose the
  text and destination before sending and MUST require the reader's
  confirmation. AI MUST be disabled unless configured, and provider
  credentials MUST remain server-side. Acceptance coverage: User Story 4,
  scenario 5.
- **FR-015**: Where browser speech and installed voices are available, the
  reader MUST provide text-to-speech and indicate the sentence being spoken
  where supported; lack of speech support MUST NOT prevent reading.
  Acceptance coverage: User Story 4, scenario 6.
- **FR-016**: The system MUST keep required reader resources available
  locally, without requiring a third-party content delivery service for core
  reading. Acceptance coverage: User Story 2, scenario 4.

### Key Entities

- **Library**: The owner's collection and its configured private storage
  location.
- **Book**: An imported reading item with its file, available metadata, cover,
  format, and library status.
- **Collection and Tag**: Owner-defined organization used to group or filter
  books.
- **Reading Position**: A device-specific location associated with a book.
- **Reading Preference**: A reader-selected display or navigation setting,
  retained on the device where applicable.
- **Annotation**: A highlight, note, or bookmark associated with a book and
  available for export.
- **Access Session**: A validated shared-PIN session for protected library
  and catalog access.
- **External Request**: A confirmed dictionary or AI request containing the
  disclosed text and destination.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In usability testing, at least 9 out of 10 readers can find and
  open a specified book from a populated library within 60 seconds without
  assistance.
- **SC-002**: At least 95% of valid files in the published supported-format
  test set are added with their available metadata and can be opened; every
  unsuccessful import has an identifiable outcome.
- **SC-003**: At least 9 out of 10 readers can resume a book at the saved or
  chosen reading position within 30 seconds of opening it.
- **SC-004**: All scripted reading acceptance tasks pass on desktop, phone,
  and tablet screen sizes for the supported format and capability combinations
  in the test set.
- **SC-005**: In privacy acceptance tests, zero dictionary or AI requests are
  sent before confirmation, and every confirmed request matches the disclosed
  text and destination.
- **SC-006**: All scripted protection tests deny unauthenticated access when
  PIN protection is enabled and demonstrate rate limiting after repeated
  incorrect attempts.
- **SC-007**: In usability testing, at least 9 out of 10 readers can create,
  find, and export an annotation without assistance.

## Assumptions

- Page & Pine is a self-hosted library for an owner and trusted readers, not a
  public hosting service or a multi-account platform.
- Books and reading data remain in the owner's configured storage; accessing
  the same server from multiple devices does not constitute cloud
  synchronization.
- The documented formats define the expected compatibility boundary.
  Additional format conversion is available only when its optional
  conversion capability is installed and usable.
- PIN protection, watched-folder imports, offline access, catalog access,
  dictionary lookup, AI assistance, and speech are optional capabilities;
  readers can use core library and reading features without enabling them.
- Offline behavior depends on browser support and a previously opened book.
  PIN-protected use intentionally does not cache book files for offline
  reading.
- External services are not controlled by Page & Pine; users decide whether
  to configure them and whether to send each disclosed request.
- DRM removal, public-internet hosting, individual user accounts, and
  cross-device cloud synchronization are outside this specification.
