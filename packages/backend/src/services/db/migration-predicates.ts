/**
 * Bootstrap predicates for detecting whether a legacy database already has the
 * effect of a given migration applied. Used ONLY for first-run bootstrap on a
 * database that was initialized under the pre-Batch-7 inline DDL regime.
 *
 * Each predicate must be:
 * - structural (behavioral where string matching is too fragile)
 * - side-effect-free (read-only or use savepoints that roll back)
 * - exact — weak predicates risk silent DDL execution against a schema that
 *   already has the migration's effect, which is the #1 bootstrap failure mode.
 *
 * See `melodic-orbiting-sunbeam.md` (Batch 7 plan) for the design rationale.
 */
import type Database from 'better-sqlite3';

type Db = Database.Database;

function tableExists(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function indexExists(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name) != null;
}

function columnExists(db: Db, table: string, col: string): boolean {
  if (!tableExists(db, table)) return false;
  // table_info can't use parameters for table names; the caller controls `table`.
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === col);
}

/**
 * Predicate map keyed by migration version number. If a migration file exists
 * but no predicate is registered for its version, bootstrap cannot safely
 * assume the migration is already applied and will NOT include it — the
 * migration runs normally on the next pass.
 */
export const predicates: Record<number, (db: Db) => boolean> = {
  // 001 — core schema (threads, messages, config, canvases, plus supporting tables)
  1: (db) =>
    tableExists(db, 'threads') &&
    tableExists(db, 'messages') &&
    tableExists(db, 'config') &&
    tableExists(db, 'canvases'),

  // 002 — Command Center schema. The 002 file is conditionally loaded in current
  // init.ts, so a legacy DB may have it or not. `tasks` is a distinctive table.
  2: (db) => tableExists(db, 'tasks') && tableExists(db, 'care_entries'),

  // 003-016 will be registered in subsequent sub-batches as their .sql files
  // are extracted from init.ts. Keep this section empty for 7.A — the runner
  // will simply not bootstrap-mark any version without a registered predicate.
};

/**
 * Behavioral probe for migration 007 (messages content_type widened to include
 * 'sticker'). Registered separately so the import is explicit about the
 * savepoint usage. Called by predicates[7] when that migration is added in a
 * later sub-batch.
 *
 * Kept exported so tests can exercise it directly against controlled schemas.
 */
export function messagesAllowsStickerContentType(db: Db): boolean {
  if (!tableExists(db, 'messages')) return false;
  db.exec('SAVEPOINT predicate_007');
  try {
    db.prepare(
      "INSERT INTO messages (id, thread_id, sequence, role, content, content_type, created_at) " +
        "VALUES ('__predicate_probe_007__', '__probe__', 0, 'system', '', 'sticker', '1970-01-01T00:00:00Z')",
    ).run();
    db.exec('ROLLBACK TO SAVEPOINT predicate_007');
    db.exec('RELEASE SAVEPOINT predicate_007');
    return true;
  } catch {
    db.exec('ROLLBACK TO SAVEPOINT predicate_007');
    db.exec('RELEASE SAVEPOINT predicate_007');
    return false;
  }
}

export const helpers = { tableExists, indexExists, columnExists, messagesAllowsStickerContentType };
