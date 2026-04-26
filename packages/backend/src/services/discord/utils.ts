// Discord utility functions

import crypto from 'crypto';
import type { Message as DiscordMessage } from 'discord.js';
import { localTimeStr } from '../time.js';

/**
 * Split a response into Discord-safe chunks (max 1900 chars)
 */
export function splitResponse(text: string, maxLength = 1900): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph break
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt < maxLength * 0.5) {
      // Try single newline
      splitAt = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitAt < maxLength * 0.5) {
      // Try space
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt < maxLength * 0.5) {
      // Hard cut
      splitAt = maxLength;
    }

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Format Discord message history for agent context.
 *
 * Sovereignty: timezone formatting routes through services/time.ts so
 * the agent sees timestamps consistent with the rest of its context
 * (chat headers, daily-thread names) and immune to Node's stale ICU
 * for zones it hasn't shipped tzdata for.
 */
export function formatChannelHistory(messages: DiscordMessage[], timezone: string): string {
  return messages.map(msg => {
    const time = localTimeStr(timezone, msg.createdAt);
    const author = msg.author.bot ? `[BOT] ${msg.author.username}` : msg.author.username;
    const content = msg.content || (msg.attachments.size > 0 ? '[attachment]' : '[embed]');
    return `[${time}] ${author}: ${content}`;
  }).join('\n');
}

/**
 * Generate a deterministic UUID v4 from a Discord channel ID.
 * This maps each Discord channel to a stable Resonant thread.
 */
export function getDiscordThreadId(channelId: string): string {
  const hash = crypto.createHash('sha256').update(`discord:${channelId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
