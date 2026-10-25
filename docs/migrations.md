# State migrations and rollback

Version 0.3.x writes ledger schema 2. It accepts schema 1, validates the collection types, adds an empty durable rotations journal, and atomically persists the migration before admitting the runtime. Repeated migration is a no-op; unknown schemas fail closed. Segment manifest schema 1 remains compatible, with an optional format field.

Schema 2 records unfinished producer handoffs and archive cleanup ownership. Version 0.2.x cannot read this ledger. Before upgrading, take a consistent state/spool/archive snapshot. Rollback requires stopping the new instance and restoring that complete pre-upgrade snapshot with its prior immutable image; never point an older image at the migrated ledger or run two versions against the same writable volumes.

Rejected mutations do not poison later writes. Failed persistence does not acknowledge the draft as committed; ambiguous publication is reconciled from disk. If published bytes cannot be read safely, reload is required before more writes. Linux files and directories are fsynced around atomic publication; targeted Windows tests do not replace native Linux power-loss qualification.
