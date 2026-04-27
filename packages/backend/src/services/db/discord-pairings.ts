import { getDb } from './state.js';
import type { PairingCode } from '../discord/types.js';

// snake_case row shape from SQLite, mirrored from the discord_pairings schema
interface PairingRow {
  code: string;
  user_id: string;
  username: string | null;
  channel_id: string;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  approved_by: string | null;
}

// Single source of truth for snake_case → camelCase row mapping. Every
// read in this module funnels through here so the unsafe `SELECT * as
// PairingCode` cast that lived in the old PairingService is gone.
function rowToPairingCode(row: PairingRow): PairingCode {
  return {
    code: row.code,
    userId: row.user_id,
    username: row.username ?? undefined,
    channelId: row.channel_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export interface PendingPairingRecord extends PairingCode {
  approvedAt: string | null;
}

function rowToPendingRecord(row: PairingRow): PendingPairingRecord {
  return {
    ...rowToPairingCode(row),
    approvedAt: row.approved_at,
  };
}

// ---------- writes ----------

export function createPairing(params: {
  code: string;
  userId: string;
  username: string;
  channelId: string;
  createdAt: string;
  expiresAt: string;
}): void {
  getDb().prepare(`
    INSERT INTO discord_pairings (code, user_id, username, channel_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.code,
    params.userId,
    params.username,
    params.channelId,
    params.createdAt,
    params.expiresAt,
  );
}

export function expirePairingByCode(code: string): void {
  getDb().prepare('DELETE FROM discord_pairings WHERE code = ?').run(code);
}

export function approvePairing(params: {
  code: string;
  approvedAt: string;
  approvedBy: string;
}): void {
  getDb().prepare(`
    UPDATE discord_pairings SET approved_at = ?, approved_by = ?
    WHERE code = ?
  `).run(params.approvedAt, params.approvedBy, params.code);
}

export function deletePairingsForUser(userId: string): number {
  const result = getDb().prepare('DELETE FROM discord_pairings WHERE user_id = ?').run(userId);
  return result.changes;
}

export function cleanExpiredPairings(nowIso: string): void {
  getDb()
    .prepare('DELETE FROM discord_pairings WHERE approved_at IS NULL AND expires_at < ?')
    .run(nowIso);
}

// ---------- reads ----------

export function findActivePendingPairingForUser(
  userId: string,
  nowIso: string,
): { code: string } | null {
  const row = getDb().prepare(`
    SELECT code FROM discord_pairings
    WHERE user_id = ? AND approved_at IS NULL AND expires_at > ?
  `).get(userId, nowIso) as { code: string } | undefined;
  return row ?? null;
}

export function isDiscordUserApproved(userId: string): boolean {
  const row = getDb().prepare(`
    SELECT 1 FROM discord_pairings
    WHERE user_id = ? AND approved_at IS NOT NULL
    LIMIT 1
  `).get(userId);
  return !!row;
}

export function getPendingPairingByCode(code: string): PendingPairingRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM discord_pairings
    WHERE code = ? AND approved_at IS NULL
  `).get(code) as PairingRow | undefined;
  return row ? rowToPendingRecord(row) : null;
}

export function listPendingPairings(): PairingCode[] {
  const rows = getDb().prepare(`
    SELECT * FROM discord_pairings WHERE approved_at IS NULL ORDER BY created_at DESC
  `).all() as PairingRow[];
  return rows.map(rowToPairingCode);
}

export function listApprovedPairings(): Array<{
  userId: string;
  username: string | null;
  approvedAt: string;
}> {
  const rows = getDb().prepare(`
    SELECT user_id, username, approved_at
    FROM discord_pairings WHERE approved_at IS NOT NULL
  `).all() as Array<{ user_id: string; username: string | null; approved_at: string }>;
  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    approvedAt: r.approved_at,
  }));
}
