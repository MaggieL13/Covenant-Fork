// SQLite-backed pairing system for Discord user approval.
// SQL lives in services/db/discord-pairings.ts; this file is the domain
// surface — code generation, expiry windows, approver resolution, and
// the success/error contract for callers.

import {
  approvePairing,
  cleanExpiredPairings,
  createPairing,
  deletePairingsForUser,
  expirePairingByCode,
  findActivePendingPairingForUser,
  getPendingPairingByCode,
  isDiscordUserApproved,
  listApprovedPairings,
  listPendingPairings,
} from '../db/discord-pairings.js';
import { getResonantConfig } from '../../config.js';
import type { PairingCode } from './types.js';

const PAIRING_TTL_MS = 60 * 60 * 1000; // 1 hour

export class PairingService {
  private generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  createOrGet(userId: string, username: string, channelId: string): string {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);

    const existing = findActivePendingPairingForUser(userId, now.toISOString());
    if (existing) return existing.code;

    const code = this.generateCode();
    createPairing({
      code,
      userId,
      username,
      channelId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });

    return code;
  }

  isApproved(userId: string): boolean {
    return isDiscordUserApproved(userId);
  }

  approve(code: string, approvedBy?: string): { success: boolean; userId?: string; error?: string } {
    const config = getResonantConfig();
    const now = new Date().toISOString();
    const approver = approvedBy || config.identity.user_name;
    const normalized = code.toUpperCase();

    const pairing = getPendingPairingByCode(normalized);
    if (!pairing) {
      return { success: false, error: 'Invalid or already approved code' };
    }

    if (pairing.expiresAt < now) {
      expirePairingByCode(normalized);
      return { success: false, error: 'Code has expired' };
    }

    approvePairing({ code: normalized, approvedAt: now, approvedBy: approver });
    return { success: true, userId: pairing.userId };
  }

  revoke(userId: string): boolean {
    return deletePairingsForUser(userId) > 0;
  }

  listPending(): PairingCode[] {
    cleanExpiredPairings(new Date().toISOString());
    return listPendingPairings();
  }

  listApproved(): Array<{ userId: string; username: string | null; approvedAt: string }> {
    return listApprovedPairings();
  }
}
