# Operations and recovery

## Health

- `/livez`: process-only liveness, public and content-free.
- `/readyz`: state-loaded readiness and revision, public and content-free.
- `/api/v1/status`: authenticated source/spool/restore summary.
- `/metrics`: authenticated Prometheus gauges.

Alert on failed archive work, spool utilization and oldest age, missing active files, repeated rotations failures, and stale restore verification. Filesystem free-space alerting remains a host/storage responsibility.

## Archive outage

Rotation continues while the spool has capacity. Failed items remain in durable state and on disk. Restore the archive destination, call `POST /api/v1/archive/retry`, and verify the queue returns to zero. Do not delete spool files manually.

For S3-compatible destinations, confirm endpoint/CA reachability, bucket/prefix policy, quota, and credential files independently. The service rereads credential files on each attempt. Rotate both files atomically at the deployment boundary, restore connectivity, retry the queue, and run restore verification. Never grant bucket-administrator or destructive mirror-delete authority to the worker identity.

## Reopen failure

Rotation fails closed and retains the original inode plus its durable intent. It cannot start another rotation for that source until recovery completes. Fix the producer/reopen configuration and use archive retry (also invoked during startup and scheduler recovery). Never remove retained rotating files manually. Linux signal adapters verify the configured producer's process identity and file descriptors: the replacement must be open and the old inode closed before capture and cleanup. A loopback callback must return `{ "reopened": true, "segmentId": "<the submitted segmentId>" }` only after the same handoff is complete. A successful signal syscall alone is not an acknowledgement.

## Capacity and integrity

The spool reserves a conservative raw-plus-gzip working bound, including compression overhead and metadata, before renaming. An oversized initial file is rejected without mutation; plan its finite working capacity before adoption rather than truncating it. `LOG_ARCHIVE_ARCHIVE_MAX_BYTES` independently bounds the archive cache (default: spool limit). S3 transfers stream bytes and independently GET/checksum-verify accepted objects before cleanup. Source `format: jsonl` additionally validates restored UTF-8 JSON objects with a bounded 1 MiB line limit. Restore working space is admitted against the spool bound.

Archive completion is durably recorded before cleanup. Restart recovery reconciles retained rotation phases and retries immutable uploads; completed entries with pending cleanup are safe to replay. Explicit copytruncate remains lossy and an interrupted truncate is quarantined for operator reconciliation, never blindly repeated.

## State backup and restore

Quiesce the container or take a consistent filesystem snapshot of state, spool, and archive. Restore to empty, permission-correct volumes. Start the same digest, verify readiness, retry the archive queue, and run the non-destructive restore verification endpoint. Record the image digest, state schema, snapshot identity, result, and time.

## Upgrade

Use an immutable image digest. Back up all writable volumes, stop the old instance, start one new instance, check readiness, API/UI authorization, source paths, archive retry, and restore verification. Roll back by restoring the matching snapshot and prior digest; do not downgrade migrated state speculatively.
