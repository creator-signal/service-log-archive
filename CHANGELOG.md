# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/) and semantic versioning.

## [Unreleased]

## [0.3.1]

- Verify newly copied gzip and manifest bytes against the durable ledger before archive admission; fsync local acceptance.
- Serialize archive-cache admission and reserve restore capacity against concurrent rotations.

## [0.3.0]

- Journal rotation phases before file changes; verify producer reopen before completing capture or removing the old inode.
- Persist archive completion before cleanup and recover interrupted immutable uploads and cleanup.
- Recover the state write queue after rejected operations; fsync atomic state publication and migrate schema 1 to schema 2.
- Bound raw/gzip/cache/restore working space, stream S3 transfers and verify remote bytes independently.
- Support selected-segment restore and bounded JSONL verification; expose rotation, source, spool and restore-age metrics.
- Keep interrupted copytruncate fail-closed rather than repeating destructive truncation.



## [0.2.0] - 2026-08-01

### Added

- Optional provider-neutral S3-compatible SigV4 archive adapter with file-backed credentials, immutable upload, independent verification, idempotent retry, and verified restore download.
- Narrow fixed-PID `SIGHUP`, `SIGUSR1`, and `SIGUSR2` reopen adapter for explicitly shared PID namespaces.

## [0.1.0] - 2026-08-01

### Added

- Standalone non-root rotation service with allowlisted file sources.
- Size/time policies, rename/create and acknowledged copy/truncate strategies.
- Gzip segments, checksummed manifests, bounded spool, verified local archive, retries, and restore verification.
- Versioned authenticated API, scoped token/OIDC roles, metrics, audit history, and responsive operator UI.
- Public Compose example, OpenAPI contract, threat model, operations/migration guidance, CI, image scanning, SBOM, and provenance release workflow.

[Unreleased]: https://github.com/creator-signal/service-log-archive/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/creator-signal/service-log-archive/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/creator-signal/service-log-archive/releases/tag/v0.1.0
