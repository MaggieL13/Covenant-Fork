import type { Reaction } from '@resonant/shared';
import { getDb } from './state.js';
import { getMessage } from './messages.js';

export function addReaction(messageId: string, emoji: string, user: 'companion' | 'user'): void {
  const db = getDb();
  const run = db.transaction(() => {
    const msg = getMessage(messageId);
    if (!msg) return;

    const metadata = (msg.metadata && typeof msg.metadata === 'object') ? { ...msg.metadata } : {};
    const reactions: Reaction[] = Array.isArray(metadata.reactions) ? [...metadata.reactions] as Reaction[] : [];

    if (reactions.some((reaction) => reaction.emoji === emoji && reaction.user === user)) return;

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
    const reactions: Reaction[] = Array.isArray(metadata.reactions) ? [...metadata.reactions] as Reaction[] : [];

    const filtered = reactions.filter((reaction) => !(reaction.emoji === emoji && reaction.user === user));
    if (filtered.length === reactions.length) return;

    metadata.reactions = filtered;

    db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), messageId);
  });
  run();
}
