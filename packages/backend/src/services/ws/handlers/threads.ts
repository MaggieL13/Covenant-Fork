import type { ClientMessage } from '@resonant/shared';
import { registry } from '../../registry.js';
import { getThread, pinThread, unpinThread } from '../../db.js';
import { threadToSummary } from '../shared.js';

export function handlePinThread(
  msg: Extract<ClientMessage, { type: 'pin_thread' }>
): void {
  pinThread(msg.threadId);
  const thread = getThread(msg.threadId);
  if (thread) {
    registry.broadcast({
      type: 'thread_updated',
      thread: threadToSummary(thread),
    });
  }
}

export function handleUnpinThread(
  msg: Extract<ClientMessage, { type: 'unpin_thread' }>
): void {
  unpinThread(msg.threadId);
  const thread = getThread(msg.threadId);
  if (thread) {
    registry.broadcast({
      type: 'thread_updated',
      thread: {
        ...threadToSummary(thread),
        pinned_at: null,
      },
    });
  }
}
