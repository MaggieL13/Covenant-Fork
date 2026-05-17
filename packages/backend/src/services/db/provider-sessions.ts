/**
 * Per-(thread, runtime, provider, model_ref) session sidecar table helpers.
 *
 * Backs the multi-provider runtime arc: each thread can hold an
 * independent in-flight session per (runtime, provider, model_ref)
 * combo. AgentService consults this table when resolving the resume id
 * for a turn, and writes back when a session is captured.
 *
 * `threads.current_session_id` stays alongside as a fast-path for the
 * Claude case. Read path prefers this table; falls back to
 * `threads.current_session_id` for threads that existed before the
 * migration (no backfill — they fill in as they're touched).
 *
 * See migration `010_thread_provider_sessions.sql` for the schema +
 * design rationale.
 */

import { getDb } from './state.js';

export interface ProviderSession {
  thread_id: string;
  runtime_id: string;
  provider: string;
  model_ref: string;
  session_id: string;
  last_used_at: string;
  metadata_json: string | null;
}

export interface ProviderSessionKey {
  threadId: string;
  runtimeId: string;
  provider: string;
  modelRef: string;
}

/**
 * Look up the provider-native session id for an exact compatibility
 * key. Returns `null` if no row matches — caller decides whether to
 * fall back (Claude legacy fast-path via `threads.current_session_id`)
 * or treat as a fresh session.
 */
export function getProviderSession(key: ProviderSessionKey): ProviderSession | null {
  const stmt = getDb().prepare(`
    SELECT thread_id, runtime_id, provider, model_ref, session_id, last_used_at, metadata_json
    FROM thread_provider_sessions
    WHERE thread_id = ? AND runtime_id = ? AND provider = ? AND model_ref = ?
  `);
  const row = stmt.get(key.threadId, key.runtimeId, key.provider, key.modelRef);
  return row ? (row as unknown as ProviderSession) : null;
}

/**
 * Upsert a session pointer for the given compatibility key. `last_used_at`
 * is always overwritten with `now`; `metadata_json` is **always
 * overwritten** to reflect the current call — `params.metadata` is
 * serialized when provided, set to `NULL` when omitted. (If metadata
 * preservation across upserts becomes a need later, add a separate
 * `setProviderSessionMetadata` helper rather than special-casing the
 * upsert path.)
 *
 * Uses `INSERT ... ON CONFLICT(...) DO UPDATE` so callers don't have to
 * branch on existence — both fresh-session capture and same-combo
 * session-id rotation hit the same path.
 */
export function setProviderSession(params: {
  threadId: string;
  runtimeId: string;
  provider: string;
  modelRef: string;
  sessionId: string;
  metadata?: Record<string, unknown>;
}): void {
  const now = new Date().toISOString();
  const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;
  // ON CONFLICT updates only session_id + last_used_at + metadata_json so
  // the composite-PK columns (thread/runtime/provider/model_ref) stay
  // identical — that's the invariant we're keyed on, and an excluded
  // mutation there would be incoherent.
  const stmt = getDb().prepare(`
    INSERT INTO thread_provider_sessions
      (thread_id, runtime_id, provider, model_ref, session_id, last_used_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id, runtime_id, provider, model_ref) DO UPDATE SET
      session_id = excluded.session_id,
      last_used_at = excluded.last_used_at,
      metadata_json = excluded.metadata_json
  `);
  stmt.run(
    params.threadId,
    params.runtimeId,
    params.provider,
    params.modelRef,
    params.sessionId,
    now,
    metadataJson,
  );
}

/**
 * Cheap existence check — true iff the thread has at least one sidecar
 * row, regardless of which runtime/provider/model it points at.
 *
 * Gates the legacy `threads.current_session_id` fallback in
 * `AgentService._processQuery`: once a thread has ANY sidecar row, the
 * sidecar is authoritative — a missing exact-key lookup means "this
 * particular combo has no session yet" (so the turn starts fresh),
 * NOT "fall back to whatever the old single pointer said" (which would
 * incorrectly resume e.g. a Sonnet session under Opus). The legacy
 * fallback only applies to pre-PR-C threads that have never been
 * touched after the migration ran.
 *
 * Uses `SELECT 1 ... LIMIT 1` so the query is index-only and stops at
 * the first match — this gate runs on every turn, no point loading
 * actual row data.
 */
export function hasProviderSessionsForThread(threadId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM thread_provider_sessions WHERE thread_id = ? LIMIT 1')
    .get(threadId);
  return !!row;
}

/**
 * List every session row for a thread, most-recently-used first.
 * Used by `/clear` for the audit log line ("cleared N provider sessions")
 * and by future debug surfaces that want to enumerate "which providers
 * has this thread talked to?".
 */
export function listProviderSessionsForThread(threadId: string): ProviderSession[] {
  const stmt = getDb().prepare(`
    SELECT thread_id, runtime_id, provider, model_ref, session_id, last_used_at, metadata_json
    FROM thread_provider_sessions
    WHERE thread_id = ?
    ORDER BY last_used_at DESC
  `);
  const rows = stmt.all(threadId);
  return rows as unknown as ProviderSession[];
}

/**
 * Delete all session rows for a thread. Called from `/clear` so the
 * "next reply starts a fresh session" promise applies to every
 * provider the thread has touched, not just Claude.
 *
 * Returns the number of rows deleted so the caller can include it
 * in the audit log line.
 */
export function clearProviderSessionsForThread(threadId: string): number {
  const stmt = getDb().prepare(`
    DELETE FROM thread_provider_sessions WHERE thread_id = ?
  `);
  const result = stmt.run(threadId);
  return result.changes;
}

/**
 * Delete every session row in the table. Used by config-admin's
 * "Force MCP reconnect" path (`clearAllThreadSessions` companion) so
 * non-Claude sessions also get the fresh-start treatment when the user
 * deliberately resets all sessions.
 */
export function clearAllProviderSessions(): number {
  const stmt = getDb().prepare(`DELETE FROM thread_provider_sessions`);
  const result = stmt.run();
  return result.changes;
}
