# State migrations and rollback

The state document carries `schemaVersion`. Version `0.1.x` reads and writes schema 1 only. Startup fails closed on an unknown version and never rewrites it.

For every future schema change:

1. add a pure migration from the immediately preceding schema;
2. test the previous released fixture, repeated migration, restart, and rollback behavior;
3. write the migrated document atomically only after validation;
4. document whether the previous binary can read the result;
5. require a consistent backup of state, spool, and archive before promotion.

Rollback within `0.1.x` is safe while schema remains 1. To roll back, stop the service, restore the pre-upgrade state/spool/archive snapshot, and start the prior immutable image digest. Never run two versions against the same writable volumes.

