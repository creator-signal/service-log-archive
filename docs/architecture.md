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
