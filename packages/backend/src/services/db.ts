import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  Thread,
  Message,
  Canvas,
  SessionRecord,
  WebSession,
} from '@resonant/shared';
import { getResonantConfig } from '../config.js';
import { embed, vectorToBuffer } from './embeddings.js';
import { cacheEmbedding } from './vector-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db: Database.Database | null = null;

export function initDb(dbPath: string): Database.Database {
  db = new Database(dbPath);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  // Busy timeout prevents SQLITE_BUSY errors under concurrent async access
  db.pragma('busy_timeout = 5000');

  // Run migrations
  const migrationPath = join(__dirname, '../../migrations/001_init.sql');
  const migrationSQL = readFileSync(migrationPath, 'utf-8');
  db.exec(migrationSQL);

  const ccMigrationPath = join(__dirname, '../../migrations/002_command_center.sql');
  if (existsSync(ccMigrationPath)) {
    const ccMigrationSQL = readFileSync(ccMigrationPath, 'utf-8');
    db.exec(ccMigrationSQL);
  }

  // Insert default config if not exists
  const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  stmt.run('dnd_start', '23:00');
  stmt.run('dnd_end', '07:00');

  // Timers table (created inline, no migration needed)
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

  // Triggers table (impulse queue + event watchers)
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

  // Discord integration migration — platform column + pairing table
  // Safe to run multiple times (uses IF NOT EXISTS / catches already-exists)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN platform TEXT DEFAULT 'web'`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      console.warn('Migration warning:', msg);
    }
  }

  // Thread pinning migration
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN pinned_at TEXT DEFAULT NULL`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      console.warn('Migration warning:', msg);
    }
  }

  // Migrate messages content_type CHECK constraint to include 'sticker'
  // SQLite doesn't support ALTER CHECK, so we recreate the table
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

  // Canvas tags migration
  try {
    db.exec(`ALTER TABLE canvases ADD COLUMN tags TEXT DEFAULT '[]'`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      console.warn('Migration warning:', msg);
    }
  }

  // Sticker pack user_only migration
  try {
    db.exec(`ALTER TABLE sticker_packs ADD COLUMN user_only INTEGER DEFAULT 0`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      console.warn('Migration warning:', msg);
    }
  }

  // Sticker system tables
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

  // Semantic embeddings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_embeddings (
      message_id TEXT PRIMARY KEY,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    )
  `);

  // Digest embeddings table — semantic search over Scribe digest blocks
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

  // Session history migration — add UNIQUE on session_id + 'resumed' end_reason
  const shCount = (db.prepare('SELECT COUNT(*) as c FROM session_history').get() as { c: number }).c;
  if (shCount === 0) {
    let needsRecreate = false;
    try {
      db.prepare("INSERT INTO session_history (id, thread_id, session_id, session_type, started_at, end_reason) VALUES ('__test', '__test', '__test', 'v1', '2026-01-01', 'resumed')").run();
      db.prepare("DELETE FROM session_history WHERE id = '__test'").run();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        console.warn('Migration warning:', msg);
      }
      needsRecreate = true;
    }
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

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

// Thread operations
export function createThread(params: {
  id: string;
  name: string;
  type: 'daily' | 'named';
  createdAt: string;
  sessionType?: 'v1' | 'v2';
}): Thread {
  const stmt = getDb().prepare(`
    INSERT INTO threads (id, name, type, created_at, session_type, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    params.id,
    params.name,
    params.type,
    params.createdAt,
    params.sessionType || 'v2',
    params.createdAt
  );

  return getThread(params.id)!;
}

export function getThread(id: string): Thread | null {
  const stmt = getDb().prepare('SELECT * FROM threads WHERE id = ?');
  const row = stmt.get(id);
  return row ? (row as unknown as Thread) : null;
}

function getLocalDateString(timezone?: string): string {
  try {
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    return new Date().toLocaleDateString('en-CA', { timeZone: tz }); // Returns YYYY-MM-DD
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

export function getTodayThread(): Thread | null {
  // Compute today's date in configured timezone using Intl (handles DST correctly)
  const config = getResonantConfig();
  const timezone = config.identity.timezone;
  const localDate = getLocalDateString(timezone);

  // Determine timezone's UTC offset using Intl for correct DST handling
  const now = new Date();
  const utcStr = now.toLocaleString('en-GB', { timeZone: 'UTC', hour: '2-digit', hour12: false, minute: '2-digit' });
  const localStr = now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false, minute: '2-digit' });
  const [utcH, utcM] = utcStr.split(':').map(Number);
  const [localH, localM] = localStr.split(':').map(Number);
  const utcMinutes = utcH * 60 + utcM;
  const localMinutes = localH * 60 + localM;
  let offsetMinutes = localMinutes - utcMinutes;
  // Normalize to [-720, +840] range
  if (offsetMinutes > 840) offsetMinutes -= 1440;
  if (offsetMinutes < -720) offsetMinutes += 1440;
  const offsetHours = Math.round(offsetMinutes / 60);

  // Query with offset applied to created_at so SQLite compares in local time
  // ORDER BY + LIMIT 1 ensures deterministic result if multiple daily threads exist
  const sign = offsetHours >= 0 ? '+' : '';
  const modifier = `${sign}${offsetHours} hours`;
  const stmt = getDb().prepare(`
    SELECT * FROM threads
    WHERE type = 'daily'
    AND date(created_at, ?) = ?
    AND archived_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const row = stmt.get(modifier, localDate);
  return row ? (row as unknown as Thread) : null;
}

export function listThreads(params: {
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}): Thread[] {
  const { includeArchived = false, limit = 50, offset = 0 } = params;

  let sql = 'SELECT * FROM threads';
  if (!includeArchived) {
    sql += ' WHERE archived_at IS NULL';
  }
  sql += ' ORDER BY last_activity_at DESC LIMIT ? OFFSET ?';

  const stmt = getDb().prepare(sql);
  const rows = stmt.all(limit, offset);
  return rows as unknown as Thread[];
}

export function getMostRecentActiveThread(): Thread | null {
  // Returns the most recently active non-archived thread with a session
  // Used to route user's messages into their active conversation
  const stmt = getDb().prepare(`
    SELECT * FROM threads
    WHERE archived_at IS NULL
    AND current_session_id IS NOT NULL
    ORDER BY last_activity_at DESC
    LIMIT 1
  `);
  const row = stmt.get();
  return row ? (row as unknown as Thread) : null;
}

export function updateThreadSession(threadId: string, sessionId: string | null): void {
  const stmt = getDb().prepare('UPDATE threads SET current_session_id = ? WHERE id = ?');
  stmt.run(sessionId, threadId);
}

export function clearAllThreadSessions(): void {
  getDb().prepare('UPDATE threads SET current_session_id = NULL').run();
}

export function updateThreadActivity(threadId: string, timestamp: string, incrementUnread = false): void {
  let sql = 'UPDATE threads SET last_activity_at = ?';
  if (incrementUnread) {
    sql += ', unread_count = unread_count + 1';
  }
  sql += ' WHERE id = ?';

  const stmt = getDb().prepare(sql);
  stmt.run(timestamp, threadId);
}

export function archiveThread(threadId: string, archivedAt: string | null): void {
  const stmt = getDb().prepare('UPDATE threads SET archived_at = ? WHERE id = ?');
  stmt.run(archivedAt, threadId);
}

export function deleteThread(threadId: string): string[] {
  const db = getDb();

  // Collect fileIds from message metadata before deleting
  const fileIds: string[] = [];
  const msgs = db.prepare('SELECT metadata FROM messages WHERE thread_id = ? AND metadata IS NOT NULL').all(threadId) as Array<{ metadata: string }>;
  for (const row of msgs) {
    try {
      const meta = JSON.parse(row.metadata);
      if (meta.fileId) fileIds.push(meta.fileId);
    } catch { /* skip unparseable */ }
  }

  // Cascading delete in a transaction
  // Order matters: delete children before parents (embeddings → messages → threads)
  const deleteAll = db.transaction(() => {
    db.prepare('DELETE FROM triggers WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM timers WHERE thread_id = ?').run(threadId);
    db.prepare('UPDATE canvases SET thread_id = NULL WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM outbound_queue WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM audit_log WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM session_history WHERE thread_id = ?').run(threadId);
    // Delete embeddings before messages (FK: message_embeddings.message_id → messages.id)
    db.prepare('DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)').run(threadId);
    db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
  });
  deleteAll();

  return fileIds;
}

/**
 * Async embedding helper — fire-and-forget from createMessage.
 *
 * Intentionally eventual-consistent: the message is created synchronously and
 * returned immediately, while the embedding is computed asynchronously (50-200ms
 * ML inference). If embedding fails, the message exists without a vector — this
 * is acceptable because semantic search degrades gracefully with missing vectors,
 * and making embedding synchronous would block the response path.
 */
async function embedMessageAsync(messageId: string, content: string, meta: {
  threadId: string; threadName: string; role: string; createdAt: string;
}): Promise<void> {
  try {
    const vector = await embed(content);
    saveEmbedding(messageId, vectorToBuffer(vector));
    cacheEmbedding(messageId, vector, meta);
  } catch (err) {
    console.error(`[embeddings] Failed to embed message ${messageId}:`, err);
  }
}

// Message operations
export function getNextSequence(threadId: string): number {
  const stmt = getDb().prepare('SELECT MAX(sequence) as max_seq FROM messages WHERE thread_id = ?');
  const row = stmt.get(threadId) as { max_seq: number | null };
  return (row.max_seq || 0) + 1;
}

export function createMessage(params: {
  id: string;
  threadId: string;
  role: 'companion' | 'user' | 'system';
  content: string;
  contentType?: 'text' | 'image' | 'audio' | 'file' | 'sticker';
  platform?: 'web' | 'discord' | 'telegram' | 'api';
  metadata?: Record<string, unknown>;
  replyToId?: string;
  createdAt: string;
}): Message {
  const sequence = getNextSequence(params.threadId);

  const stmt = getDb().prepare(`
    INSERT INTO messages (
      id, thread_id, sequence, role, content, content_type, platform, metadata, reply_to_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    params.id,
    params.threadId,
    sequence,
    params.role,
    params.content,
    params.contentType || 'text',
    params.platform || 'web',
    params.metadata ? JSON.stringify(params.metadata) : null,
    params.replyToId || null,
    params.createdAt
  );

  // Fire-and-forget embedding for text messages (non-system)
  if (params.role !== 'system' && (!params.contentType || params.contentType === 'text') && params.content.length > 10) {
    const thread = getThread(params.threadId);
    embedMessageAsync(params.id, params.content, {
      threadId: params.threadId,
      threadName: thread?.name || '',
      role: params.role,
      createdAt: params.createdAt,
    }).catch(() => {});
  }

  return getMessage(params.id)!;
}

export function getMessage(id: string): Message | null {
  const stmt = getDb().prepare('SELECT * FROM messages WHERE id = ?');
  const row = stmt.get(id);
  if (!row) return null;

  const message = row as unknown as Message;
  if (message.metadata && typeof message.metadata === 'string') {
    message.metadata = JSON.parse(message.metadata);
  }
  return message;
}

export function getMessages(params: {
  threadId: string;
  before?: string;
  limit?: number;
}): Message[] {
  const { threadId, before, limit = 50 } = params;

  let sql = 'SELECT * FROM messages WHERE thread_id = ? AND deleted_at IS NULL';
  const sqlParams: unknown[] = [threadId];

  if (before) {
    sql += ' AND sequence < (SELECT sequence FROM messages WHERE id = ?)';
    sqlParams.push(before);
  }

  sql += ' ORDER BY sequence DESC LIMIT ?';
  sqlParams.push(limit);

  const stmt = getDb().prepare(sql);
  const rows = stmt.all(...sqlParams);

  const messages = (rows as unknown as Message[]).map(msg => {
    if (msg.metadata && typeof msg.metadata === 'string') {
      msg.metadata = JSON.parse(msg.metadata);
    }
    return msg;
  });

  return messages.reverse(); // Return in chronological order
}

/** Get messages surrounding a specific message (N before + the message + N after). */
export function getMessageContext(messageId: string, windowSize: number = 2): Message[] {
  const target = getDb().prepare('SELECT thread_id, sequence FROM messages WHERE id = ?').get(messageId) as { thread_id: string; sequence: number } | undefined;
  if (!target) return [];

  const rows = getDb().prepare(`
    SELECT * FROM messages
    WHERE thread_id = ? AND deleted_at IS NULL
      AND sequence BETWEEN ? AND ?
    ORDER BY sequence ASC
  `).all(target.thread_id, target.sequence - windowSize, target.sequence + windowSize);

  return (rows as unknown as Message[]).map(msg => {
    if (msg.metadata && typeof msg.metadata === 'string') {
      msg.metadata = JSON.parse(msg.metadata);
    }
    return msg;
  });
}

export function editMessage(id: string, newContent: string, editedAt: string): void {
  const stmt = getDb().prepare(`
    UPDATE messages
    SET content = ?, edited_at = ?, original_content = COALESCE(original_content, content)
    WHERE id = ?
  `);
  stmt.run(newContent, editedAt, id);
}

export function softDeleteMessage(id: string, deletedAt: string): void {
  const stmt = getDb().prepare('UPDATE messages SET deleted_at = ? WHERE id = ?');
  stmt.run(deletedAt, id);
}

export function markMessagesRead(threadId: string, beforeId: string, readAt: string): void {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare(`
      UPDATE messages
      SET read_at = ?
      WHERE thread_id = ?
      AND sequence <= (SELECT sequence FROM messages WHERE id = ?)
      AND read_at IS NULL
    `).run(readAt, threadId, beforeId);

    db.prepare('UPDATE threads SET unread_count = 0 WHERE id = ?').run(threadId);
  });
  run();
}

// Reaction operations
export function addReaction(messageId: string, emoji: string, user: 'companion' | 'user'): void {
  const db = getDb();
  const run = db.transaction(() => {
    const msg = getMessage(messageId);
    if (!msg) return;

    const metadata = (msg.metadata && typeof msg.metadata === 'object') ? { ...msg.metadata } : {};
    const reactions: Array<{ emoji: string; user: string; created_at: string }> = Array.isArray(metadata.reactions) ? [...metadata.reactions] : [];

    if (reactions.some(r => r.emoji === emoji && r.user === user)) return;

    reactions.push({ emoji, user, created_at: new Date().toISOString() });
    metadata.reactions = reactions;

    db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), messageId);
  });
  run();
}

export function removeReaction(messageId: string, emoji: string, user: 'companion' | 'user'): void {
  const db = getDb();
  const run = db.transaction(() => {
    const msg = getMessage(messageId);
    if (!msg) return;

    const metadata = (msg.metadata && typeof msg.metadata === 'object') ? { ...msg.metadata } : {};
    const reactions: Array<{ emoji: string; user: string; created_at: string }> = Array.isArray(metadata.reactions) ? [...metadata.reactions] : [];

    const filtered = reactions.filter(r => !(r.emoji === emoji && r.user === user));
    if (filtered.length === reactions.length) return;

    metadata.reactions = filtered;

    db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), messageId);
  });
  run();
}

// Pin operations
export function pinThread(threadId: string): void {
  const stmt = getDb().prepare('UPDATE threads SET pinned_at = ? WHERE id = ?');
  stmt.run(new Date().toISOString(), threadId);
}

export function unpinThread(threadId: string): void {
  const stmt = getDb().prepare('UPDATE threads SET pinned_at = NULL WHERE id = ?');
  stmt.run(threadId);
}

// Search operations
export function searchMessages(params: {
  query: string;
  threadId?: string;
  limit?: number;
  offset?: number;
}): { messages: Array<{ id: string; thread_id: string; role: string; content: string; content_type: string; created_at: string; thread_name: string }>; total: number } {
  const { query, threadId, limit = 50, offset = 0 } = params;
  const escapedQuery = query.replace(/[%_]/g, '\\$&');
  const searchPattern = `%${escapedQuery}%`;

  let whereClause = "WHERE m.deleted_at IS NULL AND m.content LIKE ? ESCAPE '\\'";
  const countParams: unknown[] = [searchPattern];
  const selectParams: unknown[] = [searchPattern];

  if (threadId) {
    whereClause += ' AND m.thread_id = ?';
    countParams.push(threadId);
    selectParams.push(threadId);
  }

  const countStmt = getDb().prepare(`SELECT COUNT(*) as total FROM messages m ${whereClause}`);
  const { total } = countStmt.get(...countParams) as { total: number };

  const selectStmt = getDb().prepare(`
    SELECT m.id, m.thread_id, m.role, m.content, m.content_type, m.created_at, t.name as thread_name
    FROM messages m
    JOIN threads t ON t.id = m.thread_id
    ${whereClause}
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `);
  selectParams.push(limit, offset);

  const rows = selectStmt.all(...selectParams) as Array<{
    id: string; thread_id: string; role: string; content: string;
    content_type: string; created_at: string; thread_name: string;
  }>;

  return { messages: rows, total };
}

// Embedding operations
export function saveEmbedding(messageId: string, vector: Buffer): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO message_embeddings (message_id, vector, created_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(messageId, vector, new Date().toISOString());
}

export function getAllEmbeddings(threadId?: string): Array<{
  message_id: string; vector: Buffer; thread_id: string;
  role: string; content: string; created_at: string; thread_name: string;
}> {
  let query = `
    SELECT e.message_id, e.vector, m.thread_id, m.role, m.content, m.created_at, t.name as thread_name
    FROM message_embeddings e
    JOIN messages m ON m.id = e.message_id
    JOIN threads t ON t.id = m.thread_id
    WHERE m.deleted_at IS NULL
  `;
  const params: unknown[] = [];
  if (threadId) {
    query += ' AND m.thread_id = ?';
    params.push(threadId);
  }
  return getDb().prepare(query).all(...params) as Array<{
    message_id: string; vector: Buffer; thread_id: string;
    role: string; content: string; created_at: string; thread_name: string;
  }>;
}

export function getUnembeddedMessages(limit: number = 50): Array<{
  id: string; content: string; role: string; content_type: string;
}> {
  return getDb().prepare(`
    SELECT m.id, m.content, m.role, m.content_type
    FROM messages m
    LEFT JOIN message_embeddings e ON e.message_id = m.id
    WHERE e.message_id IS NULL
      AND m.deleted_at IS NULL
      AND m.role != 'system'
      AND m.content_type = 'text'
      AND length(m.content) > 10
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string; content: string; role: string; content_type: string;
  }>;
}

export function getEmbeddingCount(): { embedded: number; total: number } {
  const embedded = (getDb().prepare('SELECT COUNT(*) as c FROM message_embeddings').get() as { c: number }).c;
  const total = (getDb().prepare(
    "SELECT COUNT(*) as c FROM messages WHERE deleted_at IS NULL AND role != 'system' AND content_type = 'text' AND length(content) > 10"
  ).get() as { c: number }).c;
  return { embedded, total };
}

// Digest embedding operations
export function saveDigestEmbedding(digestId: string, date: string, blockIndex: number, vector: Buffer, content: string): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO digest_embeddings (digest_id, date, block_index, vector, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(digestId, date, blockIndex, vector, content, new Date().toISOString());
}

export function getAllDigestEmbeddings(): Array<{
  digest_id: string; date: string; block_index: number; vector: Buffer; content: string; created_at: string;
}> {
  return getDb().prepare('SELECT * FROM digest_embeddings ORDER BY date DESC, block_index ASC').all() as Array<{
    digest_id: string; date: string; block_index: number; vector: Buffer; content: string; created_at: string;
  }>;
}

// Session operations
export function createSessionRecord(params: {
  id: string;
  threadId: string;
  sessionId: string;
  sessionType: 'v1' | 'v2';
  startedAt: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT INTO session_history (id, thread_id, session_id, session_type, started_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(params.id, params.threadId, params.sessionId, params.sessionType, params.startedAt);
}

export function endSessionRecord(params: {
  sessionId: string;
  endedAt: string;
  endReason: 'compaction' | 'reaper' | 'daily_rotation' | 'error' | 'manual' | 'resumed';
}): void {
  const stmt = getDb().prepare(`
    UPDATE session_history
    SET ended_at = ?, end_reason = ?
    WHERE session_id = ?
  `);
  stmt.run(params.endedAt, params.endReason, params.sessionId);
}

export function updateSessionMemory(sessionId: string, peakMemoryMb: number): void {
  const stmt = getDb().prepare(`
    UPDATE session_history
    SET peak_memory_mb = ?
    WHERE session_id = ?
  `);
  stmt.run(peakMemoryMb, sessionId);
}

// Auth operations
export function createWebSession(params: {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}): WebSession {
  const stmt = getDb().prepare(`
    INSERT INTO web_sessions (id, token, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(params.id, params.token, params.createdAt, params.expiresAt);

  return {
    id: params.id,
    token: params.token,
    created_at: params.createdAt,
    expires_at: params.expiresAt,
  };
}

export function getWebSession(token: string): WebSession | null {
  const stmt = getDb().prepare('SELECT * FROM web_sessions WHERE token = ?');
  const row = stmt.get(token);
  return row ? (row as unknown as WebSession) : null;
}

export function deleteExpiredSessions(): void {
  const stmt = getDb().prepare('DELETE FROM web_sessions WHERE expires_at < ?');
  stmt.run(new Date().toISOString());
}

export function deleteWebSession(token: string): void {
  getDb().prepare('DELETE FROM web_sessions WHERE token = ?').run(token);
}

// Config operations
export function getConfig(key: string): string | null {
  const stmt = getDb().prepare('SELECT value FROM config WHERE key = ?');
  const row = stmt.get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setConfig(key: string, value: string): void {
  const stmt = getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  stmt.run(key, value);
}

export function getConfigBool(key: string, defaultValue: boolean): boolean {
  const val = getConfig(key);
  if (val === null) return defaultValue;
  return val === 'true' || val === '1';
}

export function getConfigNumber(key: string, defaultValue: number): number {
  const val = getConfig(key);
  if (val === null) return defaultValue;
  const num = parseFloat(val);
  return isNaN(num) ? defaultValue : num;
}

export function getConfigsByPrefix(prefix: string): Record<string, string> {
  const stmt = getDb().prepare("SELECT key, value FROM config WHERE key LIKE ?");
  const rows = stmt.all(`${prefix}%`) as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export function deleteConfig(key: string): void {
  const stmt = getDb().prepare('DELETE FROM config WHERE key = ?');
  stmt.run(key);
}

export function getAllConfig(): Record<string, string> {
  const stmt = getDb().prepare('SELECT key, value FROM config');
  const rows = stmt.all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// Push subscription operations
export interface PushSubscription {
  id: string;
  type: 'web_push' | 'apns';
  endpoint: string | null;
  keys_p256dh: string | null;
  keys_auth: string | null;
  device_token: string | null;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
}

export function addPushSubscription(params: {
  id: string;
  endpoint: string;
  keysP256dh: string;
  keysAuth: string;
  deviceName?: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO push_subscriptions (id, type, endpoint, keys_p256dh, keys_auth, device_name, created_at, last_used_at)
    VALUES (?, 'web_push', ?, ?, ?, ?, ?, NULL)
  `);
  stmt.run(params.id, params.endpoint, params.keysP256dh, params.keysAuth, params.deviceName || null, new Date().toISOString());
}

export function removePushSubscription(endpoint: string): boolean {
  const stmt = getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  const result = stmt.run(endpoint);
  return result.changes > 0;
}

export function listPushSubscriptions(): PushSubscription[] {
  const stmt = getDb().prepare("SELECT * FROM push_subscriptions WHERE type = 'web_push' ORDER BY created_at DESC");
  return stmt.all() as unknown as PushSubscription[];
}

export function touchPushSubscription(endpoint: string): void {
  const stmt = getDb().prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?');
  stmt.run(new Date().toISOString(), endpoint);
}

// Canvas operations
// Parse tags JSON from DB row, always returns string[]
function parseTags(row: any): string[] {
  if (!row?.tags) return [];
  try { return JSON.parse(row.tags); } catch { return []; }
}

// Convert DB row to Canvas with parsed tags
function rowToCanvas(row: any): Canvas {
  return { ...row, tags: parseTags(row) } as Canvas;
}

export function createCanvas(params: {
  id: string;
  threadId?: string;
  title: string;
  content?: string;
  contentType: 'markdown' | 'code' | 'text' | 'html';
  language?: string;
  tags?: string[];
  createdBy: 'companion' | 'user';
  createdAt: string;
}): Canvas {
  const stmt = getDb().prepare(`
    INSERT INTO canvases (id, thread_id, title, content, content_type, language, tags, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.id,
    params.threadId || null,
    params.title,
    params.content || '',
    params.contentType,
    params.language || null,
    JSON.stringify(params.tags || []),
    params.createdBy,
    params.createdAt,
    params.createdAt,
  );
  return getCanvas(params.id)!;
}

export function getCanvas(id: string): Canvas | null {
  const stmt = getDb().prepare('SELECT * FROM canvases WHERE id = ?');
  const row = stmt.get(id);
  return row ? rowToCanvas(row) : null;
}

export function listCanvases(opts?: { search?: string; tag?: string }): Canvas[] {
  let sql = 'SELECT * FROM canvases';
  const conditions: string[] = [];
  const params: string[] = [];

  if (opts?.search) {
    conditions.push('(title LIKE ? OR content LIKE ?)');
    const q = `%${opts.search}%`;
    params.push(q, q);
  }
  if (opts?.tag) {
    conditions.push('tags LIKE ?');
    params.push(`%"${opts.tag}"%`);
  }
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY updated_at DESC';

  const stmt = getDb().prepare(sql);
  const rows = stmt.all(...params);
  return rows.map(rowToCanvas);
}

export function getAllCanvasTags(): string[] {
  const rows = getDb().prepare('SELECT tags FROM canvases WHERE tags != \'[]\' AND tags IS NOT NULL').all() as Array<{ tags: string }>;
  const tagSet = new Set<string>();
  for (const row of rows) {
    for (const tag of parseTags(row)) tagSet.add(tag);
  }
  return [...tagSet].sort();
}

export function updateCanvasContent(id: string, content: string, updatedAt: string): void {
  const stmt = getDb().prepare('UPDATE canvases SET content = ?, updated_at = ? WHERE id = ?');
  stmt.run(content, updatedAt, id);
}

export function updateCanvasTitle(id: string, title: string, updatedAt: string): void {
  const stmt = getDb().prepare('UPDATE canvases SET title = ?, updated_at = ? WHERE id = ?');
  stmt.run(title, updatedAt, id);
}

export function updateCanvasTags(id: string, tags: string[], updatedAt: string): void {
  const stmt = getDb().prepare('UPDATE canvases SET tags = ?, updated_at = ? WHERE id = ?');
  stmt.run(JSON.stringify(tags), updatedAt, id);
}

export function deleteCanvas(id: string): boolean {
  const stmt = getDb().prepare('DELETE FROM canvases WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// Timer operations
export interface Timer {
  id: string;
  label: string;
  context: string | null;
  fire_at: string;
  thread_id: string;
  prompt: string | null;
  status: 'pending' | 'fired' | 'cancelled';
  created_at: string;
  fired_at: string | null;
}

export function createTimer(params: {
  id: string;
  label: string;
  context?: string;
  fireAt: string;
  threadId: string;
  prompt?: string;
  createdAt: string;
}): Timer {
  const stmt = getDb().prepare(`
    INSERT INTO timers (id, label, context, fire_at, thread_id, prompt, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  stmt.run(
    params.id,
    params.label,
    params.context || null,
    params.fireAt,
    params.threadId,
    params.prompt || null,
    params.createdAt,
  );
  return getDb().prepare('SELECT * FROM timers WHERE id = ?').get(params.id) as unknown as Timer;
}

export function listPendingTimers(): Timer[] {
  const stmt = getDb().prepare("SELECT * FROM timers WHERE status = 'pending' ORDER BY fire_at ASC");
  return stmt.all() as unknown as Timer[];
}

export function getDueTimers(now: string): Timer[] {
  const stmt = getDb().prepare("SELECT * FROM timers WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at ASC");
  return stmt.all(now) as unknown as Timer[];
}

export function markTimerFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE timers SET status = 'fired', fired_at = ? WHERE id = ?");
  stmt.run(firedAt, id);
}

export function cancelTimer(id: string): boolean {
  const stmt = getDb().prepare("UPDATE timers SET status = 'cancelled' WHERE id = ? AND status = 'pending'");
  const result = stmt.run(id);
  return result.changes > 0;
}

// Trigger types
export type TriggerCondition =
  | { type: 'presence_state'; state: 'active' | 'idle' | 'offline' }
  | { type: 'presence_transition'; from: string; to: string }
  | { type: 'agent_free' }
  | { type: 'time_window'; after: string; before?: string }
  | { type: 'routine_missing'; routine: string; after_hour: number };

export interface Trigger {
  id: string;
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: string; // JSON array of TriggerCondition
  prompt: string | null;
  thread_id: string | null;
  cooldown_minutes: number;
  status: 'pending' | 'waiting' | 'fired' | 'cancelled';
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  fired_at: string | null;
}

// Trigger operations
export function createTrigger(params: {
  id: string;
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: TriggerCondition[];
  prompt?: string;
  threadId?: string;
  cooldownMinutes?: number;
  createdAt: string;
}): Trigger {
  const stmt = getDb().prepare(`
    INSERT INTO triggers (id, kind, label, conditions, prompt, thread_id, cooldown_minutes, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  stmt.run(
    params.id,
    params.kind,
    params.label,
    JSON.stringify(params.conditions),
    params.prompt || null,
    params.threadId || null,
    params.cooldownMinutes ?? 120,
    params.createdAt,
  );
  return getDb().prepare('SELECT * FROM triggers WHERE id = ?').get(params.id) as unknown as Trigger;
}

export function getActiveTriggers(): Trigger[] {
  const stmt = getDb().prepare("SELECT * FROM triggers WHERE status IN ('pending', 'waiting') ORDER BY created_at ASC");
  return stmt.all() as unknown as Trigger[];
}

export function markTriggerWaiting(id: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'waiting' WHERE id = ?");
  stmt.run(id);
}

export function markTriggerFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'fired', fired_at = ?, fire_count = fire_count + 1 WHERE id = ?");
  stmt.run(firedAt, id);
}

export function markWatcherFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'pending', last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?");
  stmt.run(firedAt, id);
}

export function cancelTrigger(id: string): boolean {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'waiting')");
  const result = stmt.run(id);
  return result.changes > 0;
}

export function listTriggers(kind?: 'impulse' | 'watcher'): Trigger[] {
  if (kind) {
    const stmt = getDb().prepare("SELECT * FROM triggers WHERE kind = ? AND status != 'cancelled' ORDER BY created_at DESC");
    return stmt.all(kind) as unknown as Trigger[];
  }
  const stmt = getDb().prepare("SELECT * FROM triggers WHERE status != 'cancelled' ORDER BY created_at DESC");
  return stmt.all() as unknown as Trigger[];
}

// --- Sticker operations ---

import type { StickerPack, Sticker } from '@resonant/shared';

function parseAliases(row: any): string[] {
  if (!row?.aliases) return [];
  try { return JSON.parse(row.aliases); } catch { return []; }
}

function rowToSticker(row: any, packId?: string): Sticker {
  const pid = row.pack_id || packId;
  return {
    ...row,
    aliases: parseAliases(row),
    url: `/stickers/${pid}/${row.filename}`,
  } as Sticker;
}

export function createStickerPack(params: { id: string; name: string; description?: string; entityId?: string; userOnly?: boolean; createdAt: string }): StickerPack {
  const stmt = getDb().prepare('INSERT INTO sticker_packs (id, name, description, entity_id, user_only, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  stmt.run(params.id, params.name, params.description || '', params.entityId || null, params.userOnly ? 1 : 0, params.createdAt, params.createdAt);
  return getStickerPack(params.id)!;
}

function rowToPack(row: any): StickerPack {
  return { ...row, user_only: !!row.user_only } as StickerPack;
}

export function getStickerPack(id: string): StickerPack | null {
  const row = getDb().prepare('SELECT * FROM sticker_packs WHERE id = ?').get(id);
  return row ? rowToPack(row) : null;
}

export function listStickerPacks(): StickerPack[] {
  return getDb().prepare('SELECT * FROM sticker_packs ORDER BY name ASC').all().map(rowToPack);
}

export function updateStickerPack(id: string, fields: { name?: string; description?: string; userOnly?: boolean }): void {
  const updates: string[] = [];
  const params: unknown[] = [];
  if (fields.name !== undefined) { updates.push('name = ?'); params.push(fields.name); }
  if (fields.description !== undefined) { updates.push('description = ?'); params.push(fields.description); }
  if (fields.userOnly !== undefined) { updates.push('user_only = ?'); params.push(fields.userOnly ? 1 : 0); }
  if (updates.length === 0) return;
  updates.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  getDb().prepare(`UPDATE sticker_packs SET ${updates.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteStickerPack(id: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM stickers WHERE pack_id = ?').run(id);
    db.prepare('DELETE FROM sticker_packs WHERE id = ?').run(id);
  })();
}

export function createSticker(params: { id: string; packId: string; name: string; filename: string; aliases?: string[]; createdAt: string }): Sticker {
  const stmt = getDb().prepare('INSERT INTO stickers (id, pack_id, name, filename, aliases, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const maxOrder = getDb().prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 as next FROM stickers WHERE pack_id = ?').get(params.packId) as { next: number };
  stmt.run(params.id, params.packId, params.name, params.filename, JSON.stringify(params.aliases || []), maxOrder.next, params.createdAt);
  return getSticker(params.id)!;
}

export function getSticker(id: string): Sticker | null {
  const row = getDb().prepare('SELECT * FROM stickers WHERE id = ?').get(id);
  return row ? rowToSticker(row) : null;
}

export function getStickerByRef(packName: string, stickerName: string): Sticker | null {
  const row = getDb().prepare(`
    SELECT s.* FROM stickers s
    JOIN sticker_packs p ON p.id = s.pack_id
    WHERE LOWER(p.name) = LOWER(?) AND LOWER(s.name) = LOWER(?)
  `).get(packName, stickerName);
  return row ? rowToSticker(row) : null;
}

export function listStickers(packId?: string): Sticker[] {
  if (packId) {
    const rows = getDb().prepare('SELECT * FROM stickers WHERE pack_id = ? ORDER BY sort_order ASC').all(packId);
    return rows.map(r => rowToSticker(r));
  }
  const rows = getDb().prepare('SELECT * FROM stickers ORDER BY pack_id, sort_order ASC').all();
  return rows.map(r => rowToSticker(r));
}

export function updateSticker(id: string, fields: { name?: string; aliases?: string[]; sort_order?: number }): void {
  const updates: string[] = [];
  const params: unknown[] = [];
  if (fields.name !== undefined) { updates.push('name = ?'); params.push(fields.name); }
  if (fields.aliases !== undefined) { updates.push('aliases = ?'); params.push(JSON.stringify(fields.aliases)); }
  if (fields.sort_order !== undefined) { updates.push('sort_order = ?'); params.push(fields.sort_order); }
  if (updates.length === 0) return;
  params.push(id);
  getDb().prepare(`UPDATE stickers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteSticker(id: string): string | null {
  const sticker = getSticker(id);
  if (!sticker) return null;
  getDb().prepare('DELETE FROM stickers WHERE id = ?').run(id);
  return sticker.filename;
}

export function getAllStickersWithPacks(): Array<Sticker & { pack_name: string; user_only: boolean }> {
  const rows = getDb().prepare(`
    SELECT s.*, p.name as pack_name, p.user_only FROM stickers s
    JOIN sticker_packs p ON p.id = s.pack_id
    ORDER BY p.name ASC, s.sort_order ASC
  `).all();
  return rows.map(r => ({ ...rowToSticker(r), pack_name: (r as any).pack_name, user_only: !!(r as any).user_only }));
}
