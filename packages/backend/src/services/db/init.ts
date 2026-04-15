import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { setDb } from './state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function initDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  setDb(db);

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const migrationPath = join(__dirname, '../../../migrations/001_init.sql');
  const migrationSQL = readFileSync(migrationPath, 'utf-8');
  db.exec(migrationSQL);

  const ccMigrationPath = join(__dirname, '../../../migrations/002_command_center.sql');
  if (existsSync(ccMigrationPath)) {
    const ccMigrationSQL = readFileSync(ccMigrationPath, 'utf-8');
    db.exec(ccMigrationSQL);
  }

  const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  stmt.run('dnd_start', '23:00');
  stmt.run('dnd_end', '07:00');

  db.exec(`
    CREATE TABLE IF NOT EXISTS timers (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      context TEXT,
      fire_at TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      prompt TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      fired_at TEXT,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      conditions TEXT NOT NULL,
      prompt TEXT,
      thread_id TEXT,
      cooldown_minutes INTEGER DEFAULT 120,
      status TEXT NOT NULL DEFAULT 'pending',
      last_fired_at TEXT,
      fire_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      fired_at TEXT,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    )
  `);

  // Load-bearing behavior: keep startup migration logic behaviorally identical until Batch 7.
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN platform TEXT DEFAULT 'web'`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      console.warn('Migration warning:', msg);
    }
  }

  try {
    db.exec(`ALTER TABLE threads ADD COLUMN pinned_at TEXT DEFAULT NULL`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      console.warn('Migration warning:', msg);
    }
  }

  try {
    const hasSticker = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get() as { sql: string } | undefined;
    if (hasSticker?.sql && !hasSticker.sql.includes("'sticker'")) {
      db.exec('PRAGMA foreign_keys=OFF');
      db.exec(`
        CREATE TABLE messages_new (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('companion', 'user', 'system')),
          content TEXT NOT NULL,
          content_type TEXT DEFAULT 'text' CHECK(content_type IN ('text', 'image', 'audio', 'file', 'sticker')),
          platform TEXT DEFAULT 'web',
          metadata TEXT,
          reply_to_id TEXT,
          edited_at TEXT,
          deleted_at TEXT,
          original_content TEXT,
          created_at TEXT NOT NULL,
          delivered_at TEXT,
          read_at TEXT,
          FOREIGN KEY (thread_id) REFERENCES threads(id),
          FOREIGN KEY (reply_to_id) REFERENCES messages(id)
        )
      `);
      db.exec('INSERT INTO messages_new SELECT * FROM messages');
      db.exec('DROP TABLE messages');
      db.exec('ALTER TABLE messages_new RENAME TO messages');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_thread_seq ON messages(thread_id, sequence)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at)');
      db.exec('PRAGMA foreign_keys=ON');
      console.log('[Migration] Updated messages table to support sticker content_type');
    }
  } catch (err) {
    console.warn('Messages sticker migration warning:', err);
  }

  try {
    db.exec(`ALTER TABLE canvases ADD COLUMN tags TEXT DEFAULT '[]'`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      console.warn('Migration warning:', msg);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sticker_packs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      entity_id TEXT DEFAULT NULL,
      user_only INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS stickers (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      aliases TEXT DEFAULT '[]',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (pack_id) REFERENCES sticker_packs(id),
      UNIQUE(pack_id, name)
    )
  `);

  try {
    db.exec(`ALTER TABLE sticker_packs ADD COLUMN user_only INTEGER DEFAULT 0`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      console.warn('Migration warning:', msg);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_pairings (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT,
      channel_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      approved_by TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_embeddings (
      message_id TEXT PRIMARY KEY,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS digest_embeddings (
      digest_id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      block_index INTEGER NOT NULL,
      vector BLOB NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  const shCount = (db.prepare('SELECT COUNT(*) as c FROM session_history').get() as { c: number }).c;
  if (shCount === 0) {
    const sessionHistorySchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_history'"
    ).get() as { sql?: string } | undefined;
    const sessionHistorySql = sessionHistorySchema?.sql ?? '';
    const needsRecreate =
      !sessionHistorySql.includes('session_id TEXT NOT NULL UNIQUE') ||
      !sessionHistorySql.includes("'resumed'");

    if (needsRecreate) {
      db.exec('DROP TABLE session_history');
      db.exec(`
        CREATE TABLE session_history (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          session_type TEXT NOT NULL CHECK(session_type IN ('v1', 'v2')),
          started_at TEXT NOT NULL,
          ended_at TEXT,
          end_reason TEXT CHECK(end_reason IN ('compaction', 'reaper', 'daily_rotation', 'error', 'manual', 'resumed')),
          tokens_used INTEGER,
          cost_usd REAL,
          peak_memory_mb INTEGER,
          FOREIGN KEY (thread_id) REFERENCES threads(id)
        )
      `);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_history_thread_id ON session_history(thread_id)');

  return db;
}
