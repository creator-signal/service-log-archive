# Architecture

## Boundary

The container receives only paths and credentials a consumer explicitly mounts. It owns no infrastructure provisioning, ingress, identity-provider configuration, bucket lifecycle, quota, or producer process control.

```text
producer file mounts ──> scheduler / policy guard ──> rotation lock
                                                      │
                                                      v
state volume <──── versioned ledger <──── manifest + gzip spool
                                                      │
                                                      v
operator UI ──> authenticated API ───────> verified local archive
                                                      │
                                                      └──> optional verified S3 archive
```

The HTTP server, scheduler, rotation engine, archive worker, and UI are delivered in one versioned image. One active service instance owns a state/spool set. This release does not claim high availability or multi-writer coordination.

The Linux service acquires an exclusive kernel `flock` before loading or migrating
the ledger, recovering work, starting its scheduler or accepting HTTP requests.
It retains the descriptor after the short lock helper exits and releases only
after both HTTP requests and scheduler/cache work drain, or when the process dies.
Default lock creation is private and never truncates or removes an existing file.
The container supplies the fixed `flock -x -n <fd>` helper; native CI verifies the
actual non-root image with a read-only root filesystem and all capabilities dropped.

An explicit `LOG_ARCHIVE_ROTATION_LOCK_FILE` uses only an already mounted regular
file, opened read-only. Its immediate parent must be protected, and the file must
have one link, safe ownership/mode and a stable inode/metadata tuple. Symlinks,
hardlinks, replacement, changed bytes or unsafe permissions deny work. Queued
ledger mutations check ownership when they execute; rotation phases, management
actions and readiness also check it. No PID file, stale-lock deletion, permission
repair or unlocked fallback establishes ownership.

Every competing rotator must honor the same lock inode on the same Linux kernel.
An external lock is a consumer integration boundary, not permission to stop or
retire another rotator. Consumers must qualify their ownership-transfer and
recovery automation separately. Independent locks or different kernels do not
coordinate. Embedders acquire before `StateStore.load()`, call
`guardRotationOwnership(owner,{store,engine})`, pass `owner.assertHeld` as the
server's `beforeRequest` and engine checkpoint, and retain ownership through both
HTTP and engine drain. Library construction alone does not acquire a lifetime lock.

## Durable model

`state.json` is an atomically replaced schema-versioned document. It contains source policies, segment state, execution outcomes, bounded audit entries, restore-verification outcomes, and a monotonically increasing revision. It contains no log contents or credential material.

Segments transition from `pending` to `completed` or `failed`. Archive retries use immutable names and verify an existing destination before treating it as accepted. When S3 is configured, gzip and manifest uploads are exclusively created and verified with independent HEAD metadata/size checks; restore re-downloads and hashes the gzip. Spool and local cache data are deleted only after destination verification.

## Failure boundaries

- Before rename: the active file is unchanged.
- After rename/create: the old bytes remain in a service-named sibling file on the source filesystem until a stable spool copy and manifest are durable.
- After manifest persistence: startup and operator retry can resume archive work.
- During archive copy: exclusive creation prevents overwrite; an existing object must match the expected checksum.
- After destination verification: spool cleanup is safe and repeatable.

An unexpected failure before manifest persistence can leave an untracked raw spool file. It is never deleted automatically; operators must quarantine and inspect it. Automated orphan adoption is deferred until a manifest can be reconstructed without ambiguity.

## Trust boundaries

OIDC discovery/JWKS is fetched only from the configured issuer namespace. Reopen callbacks are restricted to loopback HTTP and carry source identifiers/path metadata but no log contents. TLS and browser authorization-code flow are deployment-edge responsibilities.
