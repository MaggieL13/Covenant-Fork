import type { ClientMessage } from '@resonant/shared';
import { registry, type ExtendedWebSocket } from '../../registry.js';
import { addReaction, removeReaction } from '../../db.js';

export function handleAddReaction(
  msg: Extract<ClientMessage, { type: 'add_reaction' }>,
  _ws: ExtendedWebSocket
): void {
  addReaction(msg.messageId, msg.emoji, 'user');
  const now = new Date().toISOString();
  registry.broadcast({
    type: 'message_reaction_added',
    messageId: msg.messageId,
    emoji: msg.emoji,
    user: 'user',
    createdAt: now,
  });
}

export function handleRemoveReaction(
  msg: Extract<ClientMessage, { type: 'remove_reaction' }>,
  _ws: ExtendedWebSocket
): void {
  removeReaction(msg.messageId, msg.emoji, 'user');
  registry.broadcast({
    type: 'message_reaction_removed',
    messageId: msg.messageId,
    emoji: msg.emoji,
    user: 'user',
  });
}
