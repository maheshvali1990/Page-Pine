<!--
Sync Impact Report
Version change: uninitialized scaffold -> 1.0.0
Modified principles: none; the scaffold contained no adopted principles
Added principles: Privacy & Local Ownership; Secure-by-Default Operation;
  Reader-Centered Compatibility; Data Integrity & Safe Migrations;
  Tested, Maintainable Changes
Added sections: Additional Constraints; Development Workflow
Removed sections: none
Follow-up TODOs: Confirm the original ratification date and replace the
  RATIFICATION_DATE TODO.
-->
# Page & Pine Constitution

## Core Principles

### I. Privacy & Local Ownership
Book files, library metadata, reading progress, and annotations MUST remain
under the library owner's control in the configured data directory. Optional
integrations MUST be disabled by default or require informed user action before
sending data externally. The AI feature MUST keep provider credentials on the
server and obtain confirmation before sending an excerpt and question. This
protects private reading material and keeps external data sharing explicit.

### II. Secure-by-Default Operation
Server endpoints MUST validate untrusted input, constrain file operations to
intended library paths, and apply the configured access controls and rate
limits. Documentation MUST distinguish a shared PIN gate from individual
accounts and MUST warn against exposing the app directly to the public
internet. This is a self-hosted application, so safe defaults and clear
deployment boundaries are essential.

### III. Reader-Centered Compatibility
The reader MUST preserve the documented supported formats and provide a
responsive experience across desktop, mobile, and tablet browsers. Reading
preferences and positions MUST continue to work within the limits of each
format and device. Features that depend on browser capabilities MUST degrade
gracefully when those capabilities are unavailable.

### IV. Data Integrity & Safe Migrations
Changes to persisted data MUST preserve existing library data and provide
backward-safe SQLite migrations when schemas change. Migration and import
behavior MUST not silently replace or discard user data. Tests MUST cover
changed persistence behavior and relevant migration paths.

### V. Tested, Maintainable Changes
Behavior changes MUST include focused automated tests for expected behavior
and important regressions. Implementations MUST favor clear, minimal changes
that fit the existing Python backend and browser-based frontend; additional
dependencies require a concrete need and suitable licensing. This keeps the
self-hosted application dependable and straightforward to maintain.

## Additional Constraints

The server MUST remain runnable with Python 3.10 or newer, and library data
MUST be stored in SQLite and the configured data directory. The browser
application and required reader assets MUST be served locally; a core reading
flow MUST NOT depend on a third-party CDN. Changes to supported formats,
external integrations, or required runtime dependencies MUST be documented.

## Development Workflow

Before completing a change, contributors MUST run the focused tests covering
it; backend changes MUST be validated with the project test suite when
practical. Changes to user-facing behavior, configuration, or data handling
MUST update the relevant README documentation. Reviewers MUST check that
privacy, security, compatibility, and data-integrity principles are met and
that validation results are reported.

## Governance

This constitution governs project decisions and is amended through a reviewed
change to this file. Every amendment MUST explain its impact, update the
version and last-amended date, and preserve applicable requirements unless
they are explicitly changed. Compliance MUST be reviewed for each substantive
change, and any exception MUST be documented with its rationale and scope.

Versioning follows Semantic Versioning: MAJOR for incompatible changes to
principles or governance, MINOR for new or materially expanded principles or
sections, and PATCH for clarifications and non-semantic wording changes.

**Version**: 1.0.0 | **Ratified**: TODO(RATIFICATION_DATE): confirm original adoption date | **Last Amended**: 2026-10-24
