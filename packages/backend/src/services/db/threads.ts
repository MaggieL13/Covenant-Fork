import type { Thread } from '@resonant/shared';
import { getResonantConfig } from '../../config.js';
import { getDb } from './state.js';
import { todayLocal, offsetMinutes, systemTimezone } from '../time.js';

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
    return todayLocal(timezone || systemTimezone());
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

export function getTodayThread(): Thread | null {
  const config = getResonantConfig();
  const timezone = config.identity.timezone;
  const localDate = getLocalDateString(timezone);

  // Sovereignty layer: offset in minutes at THIS instant in the user's zone.
  // Node's ICU can lag IANA (Paraguay 2024 DST abolition is missing from
  // Node 22.14's tzdata 2024b), so everything routes through time.ts.
  const offMin = offsetMinutes(timezone);
  const sign = offMin >= 0 ? '+' : '-';
  const modifier = `${sign}${Math.abs(offMin)} minutes`;

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

  // Mirror the fallback set used by routes/files.ts and FilePanel.svelte
  // so historical Telegram voice/photo messages (which wrote
  // voiceFileId / photoFileId before the storage layer was normalized)
  // get cleaned up alongside the thread, not orphaned on disk.
  const FILE_ID_KEYS = ['fileId', 'voiceFileId', 'photoFileId'] as const;
  const fileIds: string[] = [];
  const msgs = db.prepare('SELECT metadata FROM messages WHERE thread_id = ? AND metadata IS NOT NULL').all(threadId) as Array<{ metadata: string }>;
  for (const row of msgs) {
    try {
      const meta = JSON.parse(row.metadata);
      for (const key of FILE_ID_KEYS) {
        const value = meta?.[key];
        if (typeof value === 'string' && value.length > 0) {
          fileIds.push(value);
        }
      }
    } catch { }
  }

  // Load-bearing behavior: canvases detach instead of being deleted with their thread.
  const deleteAll = db.transaction(() => {
    db.prepare('DELETE FROM triggers WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM timers WHERE thread_id = ?').run(threadId);
    db.prepare('UPDATE canvases SET thread_id = NULL WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM outbound_queue WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM audit_log WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM session_history WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)').run(threadId);
    db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
  });
  deleteAll();

  return fileIds;
}

export function renameThread(threadId: string, name: string): void {
  getDb().prepare('UPDATE threads SET name = ? WHERE id = ?').run(name, threadId);
}

export function pinThread(threadId: string): void {
  const stmt = getDb().prepare('UPDATE threads SET pinned_at = ? WHERE id = ?');
  stmt.run(new Date().toISOString(), threadId);
}

export function unpinThread(threadId: string): void {
  const stmt = getDb().prepare('UPDATE threads SET pinned_at = NULL WHERE id = ?');
  stmt.run(threadId);
}
