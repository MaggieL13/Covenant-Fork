// Preflight validation — layered auth pipeline

import type { Message } from 'discord.js';
import type { PreflightResult, MessageBatch } from './types.js';
import { DISCORD_CONFIG } from './config.js';
import { PairingService } from './pairing.js';
import {
  isChannelIgnored,
  requiresMention,
  getUserRule,
  getServerRule,
  isUserAllowedInServer,
} from './rules.js';

export function isUserAllowed(userId: string): boolean {
  return DISCORD_CONFIG.allowedUsers.has(userId);
}

export function isGuildAllowed(guildId: string | null): boolean {
  if (!guildId) return true;
  return DISCORD_CONFIG.allowedGuilds.has(guildId);
}

export function mentionsBot(message: Message): boolean {
  if (!message.client.user) return false;
  return message.mentions.users.has(message.client.user.id);
}

export async function preflight(batch: MessageBatch, pairingService: PairingService): Promise<PreflightResult> {
  const { firstMessage, userId, guildId, channelId } = batch;

  // Ignore bots — unless they have a UserRule
  if (firstMessage.author.bot) {
    const botRule = getUserRule(firstMessage.author.id);
    if (!botRule) {
      return { allowed: false, reason: 'Author is an unknown bot' };
    }
  }

  // Check if channel is ignored
  if (isChannelIgnored(channelId, guildId)) {
    return { allowed: false, reason: 'Channel is ignored' };
  }

  const userAllowed = isUserAllowed(userId);
  const userRule = getUserRule(userId);
  const serverRule = guildId ? getServerRule(guildId) : undefined;

  // Debug: trace muted state
  if (guildId) {
    console.log(`[Preflight] Guild ${guildId}: serverRule exists=${!!serverRule}, muted=${serverRule?.muted}`);
  }

  // Server mute check — blocks all auto-responses in muted guilds
  if (guildId && serverRule?.muted) {
    return { allowed: false, reason: 'Server is muted' };
  }

  // Guild message flow
  if (guildId) {
    if (!userAllowed && !isGuildAllowed(guildId)) {
      return { allowed: false, reason: 'Guild not on allowlist' };
    }

    if (userRule && !isUserAllowedInServer(userId, guildId)) {
      return { allowed: false, reason: 'User not allowed in this server by rules' };
    }

    if (serverRule?.ignoredUsers?.includes(userId)) {
      return { allowed: false, reason: 'User is ignored in this server' };
    }

    // Channel allowlist — if activeChannels has entries, only respond in those channels
    // Threads inherit from their parent channel
    const activeChannels = DISCORD_CONFIG.activeChannels;
    if (activeChannels.size > 0 && !activeChannels.has(channelId)) {
      const parentId = firstMessage.channel.isThread() ? firstMessage.channel.parentId : null;
      if (!parentId || !activeChannels.has(parentId)) {
        return { allowed: false, reason: 'Channel not enabled' };
      }
    }

    const needsMention = requiresMention(channelId, guildId, DISCORD_CONFIG.requireMentionInGuilds);
    if (needsMention && !mentionsBot(firstMessage)) {
      return { allowed: false, reason: 'Mention required in this channel' };
    }

    if (userAllowed || isGuildAllowed(guildId)) {
      return { allowed: true, reason: 'Guild message approved' };
    }

    if (serverRule?.allowPublicResponses && mentionsBot(firstMessage)) {
      return { allowed: true, reason: 'Public response allowed in this server' };
    }

    return { allowed: false, reason: 'User not allowed in this guild' };
  }

  // DM flow
  if (userAllowed) {
    return { allowed: true, reason: 'User is on allowlist' };
  }

  // Check SQLite-backed pairing
  if (pairingService.isApproved(userId)) {
    return { allowed: true, reason: 'User has approved pairing' };
  }

  // Need pairing
  const config = await import('../../config.js').then(m => m.getResonantConfig());
  const code = pairingService.createOrGet(userId, firstMessage.author.username, channelId);
  return {
    allowed: false,
    reason: 'Pairing required for DM',
    requiresPairing: true,
    pairingCode: code,
  };
}
