import { getDb } from './state.js';

export interface AuditEventRow {
  id: string;
  sessionId: string;
  threadId: string;
  toolName: string;
  toolInput: string | null;
  toolOutput: string | null;
  triggeringMessageId: string | null;
  createdAt: string;
}

export function insertAuditEvent(event: AuditEventRow): void {
  getDb().prepare(`
    INSERT INTO audit_log (id, session_id, thread_id, tool_name, tool_input, tool_output, triggering_message_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.sessionId,
    event.threadId,
    event.toolName,
    event.toolInput,
    event.toolOutput,
    event.triggeringMessageId,
    event.createdAt,
  );
}

export function listRecentAuditEntries(limit = 50): Array<Record<string, unknown>> {
  return getDb().prepare(`
    SELECT * FROM audit_log
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
}
