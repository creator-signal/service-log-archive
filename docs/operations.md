# Operations and recovery

## Health

- `/livez`: process-only liveness, public and content-free.
- `/readyz`: state-loaded readiness and revision, public and content-free.
- `/api/v1/status`: authenticated source/spool/restore summary.
- `/metrics`: authenticated Prometheus gauges.

Alert on failed archive work, spool utilization and oldest age, missing active files, repeated rotations failures, and stale restore verification. Filesystem free-space alerting remains a host/storage responsibility.

## Archive outage

Rotation continues while the spool has capacity. Failed items remain in durable state and on disk. Restore the archive destination, call `POST /api/v1/archive/retry`, and verify the queue returns to zero. Do not delete spool files manually.

## Reopen failure

The rotation completes with a warning because the old segment is already preserved. Confirm the producer opened the replacement path before accepting further writes. Fix the callback/producer configuration and run a synthetic continuity test.

## State backup and restore

Quiesce the container or take a consistent filesystem snapshot of state, spool, and archive. Restore to empty, permission-correct volumes. Start the same digest, verify readiness, retry the archive queue, and run the non-destructive restore verification endpoint. Record the image digest, state schema, snapshot identity, result, and time.

## Upgrade

Use an immutable image digest. Back up all writable volumes, stop the old instance, start one new instance, check readiness, API/UI authorization, source paths, archive retry, and restore verification. Roll back by restoring the matching snapshot and prior digest; do not downgrade migrated state speculatively.

