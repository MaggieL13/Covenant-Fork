/**
 * CLI: run any pending migrations against the configured database.
 *
 * Usage: `npm run db:migrate`
 *
 * Exits non-zero on failure. Prints the applied version list on success.
 * Useful for production deployments where you want to run migrations as a
 * separate step before starting the server.
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';
import { runPendingMigrations } from '../services/db/migrate.js';

function main(): void {
  const config = loadConfig();
  const dbPath = config.server.db_path;

  console.log(`[db:migrate] Target database: ${dbPath}`);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  try {
    const summary = runPendingMigrations(db, { backup: true, dbPath });
    console.log(`[db:migrate] Applied: ${summary.applied.length === 0 ? 'none' : summary.applied.join(', ')}`);
    console.log(`[db:migrate] Bootstrapped: ${summary.bootstrapped.length === 0 ? 'none' : summary.bootstrapped.join(', ')}`);
    console.log(`[db:migrate] Skipped (already applied): ${summary.skipped.length === 0 ? 'none' : summary.skipped.join(', ')}`);
    if (summary.backupPath) {
      console.log(`[db:migrate] Backup created at: ${summary.backupPath}`);
    }
    console.log('[db:migrate] Done.');
  } catch (err) {
    console.error('[db:migrate] FAILED:', err instanceof Error ? err.message : err);
    db.close();
    process.exit(1);
  }

  db.close();
}

main();
