/**
 * CLI: print the current migration status for the configured database.
 *
 * Usage: `npm run db:status`
 *
 * Shows:
 * - which migrations are applied vs pending
 * - which were bootstrapped (legacy schema marked applied without running)
 * - timestamp of each application
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';
import {
  getAppliedVersions,
  listMigrationFiles,
} from '../services/db/migrate.js';

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function main(): void {
  const config = loadConfig();
  const dbPath = config.server.db_path;

  console.log(`[db:status] Target database: ${dbPath}`);

  // Non-mutating: readonly open, no ensureMigrationsTable. If the ledger
  // doesn't exist yet, report that and exit cleanly rather than creating it.
  const db = new Database(dbPath, { readonly: true });
  try {
    const hasLedger = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .get();

    const files = listMigrationFiles();

    if (!hasLedger) {
      console.log('');
      console.log('[db:status] No _migrations ledger table yet.');
      console.log('[db:status] Run `npm run db:migrate` to initialize the migration system on this database.');
      console.log('');
      console.log(`[db:status] Discovered ${files.length} migration file(s) on disk:`);
      for (const f of files) {
        console.log(`  ${pad(String(f.version).padStart(3, '0'), 6)}${f.name}`);
      }
      return;
    }

    const applied = getAppliedVersions(db);

    console.log('');
    console.log(pad('Version', 10) + pad('Status', 16) + pad('Bootstrapped', 14) + pad('Applied at', 30) + 'Name');
    console.log('-'.repeat(100));

    for (const f of files) {
      const row = applied.get(f.version);
      const status = row ? 'applied' : 'PENDING';
      const bootstrapped = row ? (row.bootstrapped ? 'yes' : 'no') : '—';
      const appliedAt = row?.applied_at ?? '—';
      console.log(
        pad(String(f.version).padStart(3, '0'), 10) +
          pad(status, 16) +
          pad(bootstrapped, 14) +
          pad(appliedAt, 30) +
          f.name,
      );
    }

    // Surface any ledger rows whose file is missing (partial-ledger signal).
    const fileVersions = new Set(files.map((f) => f.version));
    for (const [v, row] of applied) {
      if (!fileVersions.has(v)) {
        console.log(
          pad(String(v).padStart(3, '0'), 10) +
            pad('ORPHAN', 16) +
            pad(row.bootstrapped ? 'yes' : 'no', 14) +
            pad(row.applied_at, 30) +
            `${row.name} (no matching .sql file)`,
        );
      }
    }

    const pending = files.filter((f) => !applied.has(f.version));
    console.log('');
    console.log(`[db:status] Total: ${files.length} files, ${applied.size} applied, ${pending.length} pending`);
  } finally {
    db.close();
  }
}

main();
