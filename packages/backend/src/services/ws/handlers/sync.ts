import crypto from 'crypto';
import type { ClientMessage, ServerMessage } from '@resonant/shared';
import { registry, type ExtendedWebSocket } from '../../registry.js';
import { getMessages, markMessagesRead, createThread } from '../../db.js';

export function handleSync(
  msg: Extract<ClientMessage, { type: 'sync' }>,
  ws: ExtendedWebSocket
): void {
  const messages = getMessages({
    threadId: msg.threadId,
    limit: 200,
  });

  const missed = messages.filter(m => m.sequence > msg.lastSeenSequence);
  const response: ServerMessage = {
    type: 'sync_response',
    messages: missed,
  };
  ws.send(JSON.stringify(response));
}

export function handleRead(
  msg: Extract<ClientMessage, { type: 'read' }>
): void {
  markMessagesRead(msg.threadId, msg.beforeId, new Date().toISOString());

  registry.broadcast({
    type: 'unread_update',
    threadId: msg.threadId,
    count: 0,
  });
}

export function handleSwitchThread(
  msg: Extract<ClientMessage, { type: 'switch_thread' }>,
  ws: ExtendedWebSocket
): void {
  const messages = getMessages({ threadId: msg.threadId, limit: 50 });

  const response: ServerMessage = {
    type: 'sync_response',
    messages,
  };
  ws.send(JSON.stringify(response));
}

export function handleCreateThread(
  msg: Extract<ClientMessage, { type: 'create_thread' }>
): void {
  const thread = createThread({
    id: crypto.randomUUID(),
    name: msg.name,
    type: 'named',
    createdAt: new Date().toISOString(),
    sessionType: 'v2',
  });

  registry.broadcast({ type: 'thread_created', thread });
}
