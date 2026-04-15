import { WebSocket } from 'ws';
import type { ServerMessage, Thread, ThreadSummary } from '@resonant/shared';

export function threadToSummary(thread: Thread): ThreadSummary {
  return {
    id: thread.id,
    name: thread.name,
    type: thread.type,
    unread_count: thread.unread_count,
    last_activity_at: thread.last_activity_at,
    last_message_preview: null,
    pinned_at: thread.pinned_at ?? null,
  };
}

export function threadsToSummaries(threads: Thread[]): ThreadSummary[] {
  return threads.map(threadToSummary);
}

export function sendError(ws: WebSocket, code: string, message: string): void {
  const msg: ServerMessage = { type: 'error', code, message };
  ws.send(JSON.stringify(msg));
}
