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

/** Full footprint of 002_command_center.sql. Predicate 2 requires all. */
const COMMAND_CENTER_TABLES = [
  'care_entries',
  'projects',
  'tasks',
  'events',
  'cycles',
  'cycle_daily_logs',
  'cycle_settings',
  'pets',
  'pet_events',
  'pet_medications',
  'lists',
  'list_items',
  'expenses',
  'countdowns',
  'daily_wins',
  'scratchpad_notes',
] as const;

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

  // 002 — Command Center schema. The 002 file is conditionally loaded in
  // current init.ts, so a legacy DB may have it or not. Check the full
  // 16-table footprint so a partial/manual state can't falsely satisfy
  // this predicate.
  2: (db) =>
    COMMAND_CENTER_TABLES.every((t) => tableExists(db, t)),

  // 003 — canvases.tags (ALTER ADD COLUMN)
  3: (db) => columnExists(db, 'canvases', 'tags'),

  // 004 — sticker_packs + stickers (both tables must be present)
  4: (db) => tableExists(db, 'sticker_packs') && tableExists(db, 'stickers'),

  // 005 — sticker_packs.user_only (ALTER ADD COLUMN)
  5: (db) => columnExists(db, 'sticker_packs', 'user_only'),

  // 006 — discord_pairings
  6: (db) => tableExists(db, 'discord_pairings'),

  // 007 — message_embeddings
  7: (db) => tableExists(db, 'message_embeddings'),

  // 008 — digest_embeddings
  8: (db) => tableExists(db, 'digest_embeddings'),

  // 009 — idx_session_history_thread_id
  9: (db) => indexExists(db, 'idx_session_history_thread_id'),
};

/**
 * Behavioral probe for migration 007 (messages content_type widened to include
 * 'sticker'). Registered separately so the import is explicit about the
 * savepoint usage. Called by predicates[7] when that migration is added in a
 * later sub-batch.
 *
 * Kept exported so tests can exercise it directly against controlled schemas.
 *
 * FK safety: the probe inserts a row with a fake `thread_id` that has no
 * matching parent in `threads`. If foreign keys are ON, that insert fails for
 * FK reasons BEFORE the CHECK constraint is evaluated, giving a false negative.
 * We turn foreign_keys OFF for the probe (which can only happen outside a
 * transaction, so we do it before opening the savepoint) and restore it after.
 */
export function messagesAllowsStickerContentType(db: Db): boolean {
  if (!tableExists(db, 'messages')) return false;

  // Capture and disable FK enforcement for the duration of the probe.
  // better-sqlite3 returns a number here; fall back defensively.
  const fkState = db.pragma('foreign_keys', { simple: true });
  const fkWasOn = fkState === 1 || fkState === true;
  if (fkWasOn) db.pragma('foreign_keys = OFF');

  try {
    db.exec('SAVEPOINT predicate_007');
    let result = false;
    try {
      db.prepare(
        "INSERT INTO messages (id, thread_id, sequence, role, content, content_type, created_at) " +
          "VALUES ('__predicate_probe_007__', '__probe_thread__', 0, 'system', '', 'sticker', '1970-01-01T00:00:00Z')",
      ).run();
      // Success with FK off means the CHECK constraint allowed 'sticker'.
      result = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Explicit CHECK constraint violation → migration not applied
      if (/CHECK constraint/i.test(msg)) {
        result = false;
      } else {
        // Any other failure (unique violation on sentinel id, NOT NULL, etc.)
        // → be conservative and report not-applied so the runner will try to
        // apply migration 7. If the migration is already applied, re-applying
        // is not a safe no-op (it rebuilds the table), so false here is only
        // a last resort — the 'sticker' CHECK case is the one we really care
        // about.
        result = false;
      }
    } finally {
      db.exec('ROLLBACK TO SAVEPOINT predicate_007');
      db.exec('RELEASE SAVEPOINT predicate_007');
    }
    return result;
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}

export const helpers = { tableExists, indexExists, columnExists, messagesAllowsStickerContentType };
