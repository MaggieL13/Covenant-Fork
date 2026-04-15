import type { WebSession } from '@resonant/shared';
import { getDb } from './state.js';

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
