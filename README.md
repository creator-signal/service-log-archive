# service-log-archive

`service-log-archive` is a standalone control plane for rotating file logs and making rotation state visible through an authenticated API and responsive operator UI.

It runs as one non-root container. Consumers explicitly mount managed log files/directories, durable state, a bounded spool, an archive directory, and runtime authentication material. The service does not discover host paths, mount paths dynamically, read a Docker socket, or contain Creator Signal deployment configuration.

> Status: `0.1.0` release candidate. Local filesystem archival is implemented. S3-compatible archival is intentionally disabled until its immutable-upload and independent-verification acceptance suite is complete.

## Capabilities

- size- and time-triggered rotations;
- preferred rename/create rotation with an optional, loopback-only reopen callback;
- explicit-risk `copytruncate` compatibility mode;
- gzip compression, SHA-256 manifests, UTC-sortable immutable names;
- separately mounted, capacity-bounded spool, state, and archive paths;
- idempotent archive retry and non-destructive restore verification;
- durable source policies, execution history, segment state, audit history, and schema version;
- authenticated versioned API with viewer, operator, and administrator roles;
- scoped API-token digests and provider-neutral RS256 OIDC validation;
- embedded responsive UI with source health, policies, rotation history, queue state, audit history, and guarded actions;
- public liveness/readiness probes and protected Prometheus metrics;
- non-root, read-only-root container with all Linux capabilities dropped in the Compose example.

Raw log contents are never available through the API, UI, metrics, or service logs.

## Quick start

The repository includes a synthetic credential and fixture directory for local use only.

```sh
printf 'event-1\nevent-2\n' > examples/compose/logs/application.log
docker compose pull
docker compose up -d
```

Open <http://127.0.0.1:8080>, connect with `local-development-only`, and add `/logs/application.log`.

Or create the source directly:

```sh
curl --fail-with-body http://127.0.0.1:8080/api/v1/sources \
  -H 'authorization: Bearer local-development-only' \
  -H 'content-type: application/json' \
  --data '{
    "id":"application-log",
    "name":"Application log",
    "path":"/logs/application.log",
    "strategy":"rename-create",
    "maxBytes":10485760,
    "intervalSeconds":86400
  }'
```

The full API is published in [openapi.yaml](openapi.yaml). The local example is documented in [examples/compose/README.md](examples/compose/README.md).

## Mount contract

| Path | Access | Purpose |
| --- | --- | --- |
| `/logs` | read/write | Explicitly managed active files. Use narrower mounts in production. |
| `/var/lib/log-archive/state` | read/write | Versioned durable configuration, ledger, executions, and audit state. |
| `/var/lib/log-archive/spool` | read/write | Bounded completed-rotation outbox. |
| `/var/lib/log-archive/archive` | read/write | Provider-neutral local archive destination. |
| `/run/secrets/log-archive-api-tokens.json` | read-only | Token identifiers, roles, and SHA-256 digests. |

The service canonicalizes each source path, rejects traversal and symlink escape, requires a regular file, and permits only paths beneath `LOG_ARCHIVE_ALLOWED_ROOTS`.

The producer and service must share compatible UID/GID and permissions for rename/create. Configure a narrow loopback callback if the producer must reopen the file. Host PID access, arbitrary commands, and Docker-socket signaling are not supported.

## Authentication

Every management, state, audit, and metrics endpoint requires `Authorization: Bearer ...`. Only `/livez`, `/readyz`, and the UI shell are public.

### Scoped tokens

Generate a high-entropy token, calculate its digest outside the container, and mount a document like:

```json
{
  "tokens": [
    { "id": "automation", "role": "operator", "sha256": "64-lowercase-hex-characters" }
  ]
}
```

```sh
node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" 'replace-me'
```

The service never persists or returns plaintext tokens.

### OIDC

Set all of:

```text
LOG_ARCHIVE_OIDC_ISSUER=https://identity.example.com
LOG_ARCHIVE_OIDC_AUDIENCE=log-archive
LOG_ARCHIVE_OIDC_ROLE_CLAIM=log_archive_role
```

The API validates RS256 signatures from the issuer's discovery/JWKS endpoints, plus issuer, audience, expiry, not-before, subject, and role. The role claim must contain `viewer`, `operator`, or `administrator`. TLS termination and interactive authorization-code/PKCE login belong at the deployment ingress or an OIDC-aware proxy; the embedded token form can accept the resulting access token without storing it beyond the browser tab.

Bearer headers mean browser mutations do not use ambient cookies and therefore are not CSRF-authorizable. The UI also applies a restrictive CSP and keeps credentials in session storage only.

## Rotation semantics

`rename-create` is the safe default:

1. verify the active file is a regular file beneath an allowlisted real path;
2. reserve spool capacity and take a per-source in-process lock;
3. atomically rename the active file to a private sibling on the same mounted filesystem;
4. recreate the active path with its prior mode and ownership;
5. invoke the optional loopback reopen callback;
6. copy the stable completed inode into the separately mounted spool, verify it did not change during the copy, then gzip it and write an immutable checksum manifest;
7. persist pending work, copy it to the archive without overwrite, independently verify it, then remove only the accepted spool copy.

A failed reopen callback is recorded as a warning while the already-rotated segment remains preserved. A failed archive copy stays retryable in the spool. The service never propagates mirror deletes.

`copytruncate` must be explicitly acknowledged per source because bytes written during the copy window can be lost or duplicated. It exists only for producers that cannot reopen a renamed path.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `LOG_ARCHIVE_HOST` | `0.0.0.0` | Listen address. |
| `LOG_ARCHIVE_PORT` | `8080` | HTTP port. |
| `LOG_ARCHIVE_ALLOWED_ROOTS` | `/logs` | Comma-separated canonical mount roots. |
| `LOG_ARCHIVE_DATA_DIR` | `/var/lib/log-archive/state` | Durable state mount. |
| `LOG_ARCHIVE_SPOOL_DIR` | `/var/lib/log-archive/spool` | Bounded spool mount. |
| `LOG_ARCHIVE_ARCHIVE_DIR` | `/var/lib/log-archive/archive` | Verified local archive mount. |
| `LOG_ARCHIVE_TOKEN_FILE` | `/run/secrets/log-archive-api-tokens.json` | Read-only scoped-token digest file. |
| `LOG_ARCHIVE_SPOOL_MAX_BYTES` | `1073741824` | Hard pre-rotation spool capacity. |
| `LOG_ARCHIVE_SCHEDULER_INTERVAL_SECONDS` | `15` | Policy evaluation interval. |
| `LOG_ARCHIVE_HISTORY_LIMIT` | `500` | Bound for execution/audit/restore histories. |
| `LOG_ARCHIVE_REQUEST_MAX_BYTES` | `65536` | JSON request limit. |
| `LOG_ARCHIVE_RATE_LIMIT_PER_MINUTE` | `120` | Per-address request limit. |

## Back up and restore

Stop the service or snapshot all three writable volumes consistently. Back up state, spool, and archive independently. Restore them to empty volumes with the same ownership, start the same or newer compatible major version, wait for `/readyz`, call `POST /api/v1/archive/retry`, then call `POST /api/v1/restore-verifications`.

Unknown state schema versions fail closed. See [docs/migrations.md](docs/migrations.md) for upgrade and rollback rules.

## Development

Requires Node.js 24 and Docker:

```sh
npm ci
npm run check
docker compose config --quiet
docker compose -f compose.yaml -f compose.build.yaml config --quiet
docker build -t service-log-archive:dev .
```

The test suite uses only synthetic events and temporary directories. Public pull-request CI runs on GitHub-hosted runners without production secrets.

## Documentation

- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Operations and recovery](docs/operations.md)
- [Migrations](docs/migrations.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

Licensed under Apache-2.0.
