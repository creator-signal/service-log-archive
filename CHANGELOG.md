# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/) and semantic versioning.

## [Unreleased]

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
