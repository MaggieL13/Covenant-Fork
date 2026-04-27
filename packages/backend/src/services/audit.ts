import crypto from 'crypto';
import { insertAuditEvent, listRecentAuditEntries } from './db/audit.js';

const TOOL_INPUT_MAX = 5000;
const TOOL_OUTPUT_MAX = 1000;

export function logToolUse(params: {
  sessionId: string;
  threadId: string;
  toolName: string;
  toolInput?: string;
  toolOutput?: string;
  triggeringMessageId?: string;
}): void {
  insertAuditEvent({
    id: crypto.randomUUID(),
    sessionId: params.sessionId,
    threadId: params.threadId,
    toolName: params.toolName,
    toolInput: params.toolInput ? params.toolInput.substring(0, TOOL_INPUT_MAX) : null,
    toolOutput: params.toolOutput ? params.toolOutput.substring(0, TOOL_OUTPUT_MAX) : null,
    triggeringMessageId: params.triggeringMessageId || null,
    createdAt: new Date().toISOString(),
  });
}

export function getRecentAuditEntries(limit = 50): Array<Record<string, unknown>> {
  return listRecentAuditEntries(limit);
}
