/**
 * CLI: take an immediate backup of the configured database.
 *
 * Usage: `npm run db:backup`
 *
 * Uses VACUUM INTO for an atomic, consistent snapshot. Backups land in
 * {dataDir}/backups/resonant-{iso-timestamp}.db. Retention pruning keeps the
 * most recent 10 backups (configurable via RESONANT_BACKUP_RETENTION).
 *
 * Recommended as a manual step before first-time startup under the new
 * migration system, or any time you want a known-good snapshot.
 */
import 'dotenv/config';
import { loadConfig } from '../config.js';
import { DEFAULT_BACKUP_RETENTION, backupDb } from '../services/db/migrate.js';

function main(): void {
  const config = loadConfig();
  const dbPath = config.server.db_path;

  const retentionEnv = process.env.RESONANT_BACKUP_RETENTION;
  const retention = retentionEnv !== undefined ? Number(retentionEnv) : DEFAULT_BACKUP_RETENTION;
  if (!Number.isFinite(retention) || retention < 0) {
    console.error(`[db:backup] Invalid RESONANT_BACKUP_RETENTION value: ${retentionEnv}. Must be a non-negative integer.`);
    process.exit(1);
  }

  console.log(`[db:backup] Source database: ${dbPath}`);
  console.log(`[db:backup] Retention: ${retention === 0 ? 'disabled (keep all)' : `keep ${retention} most recent`}`);

  try {
    const backupPath = backupDb(dbPath, retention);
    if (backupPath) {
      console.log(`[db:backup] Backup created: ${backupPath}`);
    } else {
      console.log('[db:backup] Skipped (source is :memory: or empty path).');
    }
  } catch (err) {
    console.error('[db:backup] FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
