# Database Migrations

SQLite schema migrations for the Covenant-Fork backend. Each migration is a numbered `.sql` file in this directory.

## How it works

On server startup, `initDb()` calls `runPendingMigrations()` from `src/services/db/migrate.ts`. The runner:

1. Ensures a `_migrations` ledger table exists.
2. Lists migration files from this directory, sorted by numeric prefix.
3. If the ledger is empty AND the DB has legacy tables (`threads`, `messages`, `config`), runs **bootstrap**: for each migration, a predicate in `src/services/db/migration-predicates.ts` checks if the schema already has that migration's effect. Satisfied ones get marked `bootstrapped=1` without running SQL. This makes the migration system drop into a database that predates it without re-executing historical DDL.
4. For any remaining pending migrations (not in ledger, not bootstrapped), runs the SQL inside a `BEGIN IMMEDIATE` transaction, then inserts a ledger row.
5. Before running any non-bootstrap work, takes a `VACUUM INTO` backup to `{dataDir}/backups/resonant-{iso}.db` (retention: keep 10 most recent).

## File naming

```
NNN_descriptive_name.sql
```

- `NNN` is a zero-padded integer, strictly greater than the last migration's number
- Lowercase, underscores, no spaces
- The file extension must be `.sql`

Examples: `001_init.sql`, `010_add_user_avatars.sql`, `023_tags_index.sql`.

Files that don't match this pattern (like this README) are ignored by the runner.

## Rules for authoring new migrations

### Never edit a migration that has been applied

Once a migration has an entry in `_migrations` on any deployed database, its contents must be treated as immutable. Edit-then-redeploy won't re-run it (the ledger thinks it's done), and the checksum drift will trigger a warning. If you need to change something, write a new migration.

### Use plain DDL

No `CREATE TABLE IF NOT EXISTS`. No try-catch-wrapped `ALTER`. Idempotency comes from the ledger, not SQL defensiveness. The runner either applies a migration fully (ledger row written) or rolls back the transaction and leaves no trace.

Exception: `001_init.sql` and `002_command_center.sql` use `IF NOT EXISTS` because they predate this system and were historically re-run on every boot. Leave them alone.

### Register a predicate when you add a migration

For every migration, add an entry to the `predicates` object in `src/services/db/migration-predicates.ts`. The predicate must return `true` if and only if the migration's effect is already present in a database. This is what enables bootstrap detection on existing production databases.

Use structural checks — `tableExists()`, `columnExists()`, `indexExists()`. Avoid string-matching on `sqlite_master.sql` unless you have no other option (see `messagesAllowsStickerContentType` for a behavioral-probe example, kept around for reference).

### Add a test for the new predicate

In `src/services/db/migrate.test.ts`, add a test that asserts the predicate returns `true` when the schema element is present and `false` when it isn't. The existing integration test at the bottom (`every registered predicate is satisfied by the schema produced by current initDb(:memory:)`) will automatically pick up your predicate — it iterates all registered versions. As long as `initDb()` produces a schema that satisfies your predicate, this test passes.

### One migration per discrete schema change

A migration that creates a table and then ALTERs it is harder to reason about than two migrations (create, then alter). Prefer the smaller units — they bootstrap more accurately and rollback-by-commit is cleaner.

### `@pragma-outside-tx` for schema surgery

Some operations (like `PRAGMA foreign_keys=OFF` for a table rebuild) cannot run inside a transaction. Mark the migration with a top-of-file comment:

```sql
-- @pragma-outside-tx
PRAGMA foreign_keys=OFF;
-- ... rebuild work ...
PRAGMA foreign_keys=ON;
```

The runner detects the directive and executes the whole migration outside a transaction. **Risks:** if the migration fails partway, the ledger row is NOT written, but the database may be in an inconsistent state. The runner logs a FATAL error and aborts startup, forcing operator recovery from the last backup before the next boot. Reserve this directive for migrations that genuinely cannot run transactionally.

## CLI commands

All assume your working directory is the backend package (`packages/backend/`).

```
npm run db:backup    # Immediate VACUUM INTO backup to data/backups/
npm run db:migrate   # Run any pending migrations against the configured DB
npm run db:status    # Print the applied / pending / orphaned migration state
```

### Manual backup before any production migration

Before running the server on a production database for the first time after any migration change:

```
npm run db:backup
```

Verify `data/backups/resonant-*.db` exists. Keep at least one known-good snapshot before committing to the new schema.

## Adding a migration — full workflow

1. Decide the schema change.
2. Create `packages/backend/migrations/NNN_descriptive_name.sql` with plain DDL.
3. Add a predicate to `src/services/db/migration-predicates.ts`.
4. Add a predicate test to `src/services/db/migrate.test.ts`.
5. Run `npm test` — the existing integration test should now exercise your predicate.
6. Run `npm run db:backup` if you're about to deploy to a live database.
7. Run `npm run db:migrate` (or just start the server) — pending migration applies.
8. Run `npm run db:status` to confirm the ledger row landed.

## Gotchas

- **WAL mode:** `data/resonant.db-wal` and `data/resonant.db-shm` sidecar files accompany the main `.db` file. Copy all three if moving a DB between machines, or use `npm run db:backup` (which uses `VACUUM INTO` — atomic, no sidecars needed).
- **Windows paths:** the runner's backup path uses constrained filenames (ISO timestamps only, no user input), so quote-escaping isn't a practical concern. Still escapes defensively.
- **Concurrent startup:** `BEGIN IMMEDIATE` plus SQLite's `busy_timeout=5000` serialize concurrent `initDb()` calls. The first process applies migrations; subsequent processes see the ledger populated and skip.
- **Checksum drift warnings:** if you ever edit an applied migration (don't), you'll see `[Migrations] checksum drift for migration N` on startup. Fix the file to match what was originally applied, or (for disaster recovery) write a new migration that undoes/redoes the effect.

## Plan reference

Full design and rationale for the migration system: see `melodic-orbiting-sunbeam.md` (Batch 7 plan, if still around).
