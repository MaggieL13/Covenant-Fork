import Database from 'better-sqlite3';
import { setDb } from './state.js';
import { runPendingMigrations } from './migrate.js';

export function initDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  setDb(db);

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Batch 7.D cutover: all schema DDL now lives in packages/backend/migrations/*.sql
  // and is applied via the versioned migration runner. Bootstrap detection in the
  // runner marks historical schema as already-applied on legacy DBs without
  // re-executing DDL. See melodic-orbiting-sunbeam.md plan for full design.
  runPendingMigrations(db, { backup: true, dbPath });

  // Runtime seed values for config table (data, not schema).
  const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  stmt.run('dnd_start', '23:00');
  stmt.run('dnd_end', '07:00');

  return db;
}
