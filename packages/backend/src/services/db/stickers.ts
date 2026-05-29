import type { Sticker, StickerPack } from '@resonant/shared';
import { getDb } from './state.js';

function parseAliases(row: any): string[] {
  if (!row?.aliases) return [];
  try { return JSON.parse(row.aliases); } catch { return []; }
}

function rowToSticker(row: any, packId?: string): Sticker {
  const pid = row.pack_id || packId;
  return {
    ...row,
    aliases: parseAliases(row),
    url: `/stickers/${pid}/${row.filename}`,
  } as Sticker;
}

function rowToPack(row: any): StickerPack {
  return { ...row, user_only: !!row.user_only } as StickerPack;
}

export function createStickerPack(params: { id: string; name: string; description?: string; entityId?: string; userOnly?: boolean; createdAt: string }): StickerPack {
  const stmt = getDb().prepare('INSERT INTO sticker_packs (id, name, description, entity_id, user_only, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  stmt.run(params.id, params.name, params.description || '', params.entityId || null, params.userOnly ? 1 : 0, params.createdAt, params.createdAt);
  return getStickerPack(params.id)!;
}

export function getStickerPack(id: string): StickerPack | null {
  const row = getDb().prepare('SELECT * FROM sticker_packs WHERE id = ?').get(id);
  return row ? rowToPack(row) : null;
}

export function listStickerPacks(): StickerPack[] {
  return getDb().prepare('SELECT * FROM sticker_packs ORDER BY name ASC').all().map(rowToPack);
}

export function updateStickerPack(id: string, fields: { name?: string; description?: string; userOnly?: boolean }): void {
  const updates: string[] = [];
  const params: unknown[] = [];
  if (fields.name !== undefined) { updates.push('name = ?'); params.push(fields.name); }
  if (fields.description !== undefined) { updates.push('description = ?'); params.push(fields.description); }
  if (fields.userOnly !== undefined) { updates.push('user_only = ?'); params.push(fields.userOnly ? 1 : 0); }
  if (updates.length === 0) return;
  updates.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  getDb().prepare(`UPDATE sticker_packs SET ${updates.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteStickerPack(id: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM stickers WHERE pack_id = ?').run(id);
    db.prepare('DELETE FROM sticker_packs WHERE id = ?').run(id);
  })();
}

export function createSticker(params: { id: string; packId: string; name: string; filename: string; aliases?: string[]; createdAt: string }): Sticker {
  const stmt = getDb().prepare('INSERT INTO stickers (id, pack_id, name, filename, aliases, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const maxOrder = getDb().prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 as next FROM stickers WHERE pack_id = ?').get(params.packId) as { next: number };
  stmt.run(params.id, params.packId, params.name, params.filename, JSON.stringify(params.aliases || []), maxOrder.next, params.createdAt);
  return getSticker(params.id)!;
}

export function getSticker(id: string): Sticker | null {
  const row = getDb().prepare('SELECT * FROM stickers WHERE id = ?').get(id);
  return row ? rowToSticker(row) : null;
}

export function getStickerByRef(packName: string, stickerName: string): Sticker | null {
  const row = getDb().prepare(`
    SELECT s.* FROM stickers s
    JOIN sticker_packs p ON p.id = s.pack_id
    WHERE LOWER(p.name) = LOWER(?) AND LOWER(s.name) = LOWER(?)
  `).get(packName, stickerName);
  return row ? rowToSticker(row) : null;
}

/**
 * Companion-scoped variant of `getStickerByRef`. Returns `null` when
 * the referenced sticker belongs to a `user_only` pack — those are
 * the human's private stickers and must never be sendable by the
 * companion, regardless of which path requests them (Codex tool, hook
 * catalog, `sc sticker send`).
 *
 * The `user_only` filter lives in SQL (`AND p.user_only = 0`) so the
 * private row never leaves the DB on a companion path — defense in
 * depth over a JS-side `.filter`. The user-facing HTTP routes keep
 * using the unfiltered `getStickerByRef` / `getAllStickersWithPacks`
 * because Maggie's own surface legitimately manages private packs.
 */
export function getCompanionStickerByRef(packName: string, stickerName: string): Sticker | null {
  const row = getDb().prepare(`
    SELECT s.* FROM stickers s
    JOIN sticker_packs p ON p.id = s.pack_id
    WHERE LOWER(p.name) = LOWER(?) AND LOWER(s.name) = LOWER(?)
      AND p.user_only = 0
  `).get(packName, stickerName);
  return row ? rowToSticker(row) : null;
}

export function listStickers(packId?: string): Sticker[] {
  if (packId) {
    const rows = getDb().prepare('SELECT * FROM stickers WHERE pack_id = ? ORDER BY sort_order ASC').all(packId);
    return rows.map((row) => rowToSticker(row));
  }
  const rows = getDb().prepare('SELECT * FROM stickers ORDER BY pack_id, sort_order ASC').all();
  return rows.map((row) => rowToSticker(row));
}

export function updateSticker(id: string, fields: { name?: string; aliases?: string[]; sort_order?: number }): void {
  const updates: string[] = [];
  const params: unknown[] = [];
  if (fields.name !== undefined) { updates.push('name = ?'); params.push(fields.name); }
  if (fields.aliases !== undefined) { updates.push('aliases = ?'); params.push(JSON.stringify(fields.aliases)); }
  if (fields.sort_order !== undefined) { updates.push('sort_order = ?'); params.push(fields.sort_order); }
  if (updates.length === 0) return;
  params.push(id);
  getDb().prepare(`UPDATE stickers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteSticker(id: string): string | null {
  const sticker = getSticker(id);
  if (!sticker) return null;
  getDb().prepare('DELETE FROM stickers WHERE id = ?').run(id);
  return sticker.filename;
}

export function getAllStickersWithPacks(): Array<Sticker & { pack_name: string; user_only: boolean }> {
  const rows = getDb().prepare(`
    SELECT s.*, p.name as pack_name, p.user_only FROM stickers s
    JOIN sticker_packs p ON p.id = s.pack_id
    ORDER BY p.name ASC, s.sort_order ASC
  `).all();
  return rows.map((row) => ({
    ...rowToSticker(row),
    pack_name: (row as any).pack_name,
    user_only: !!(row as any).user_only,
  }));
}

/**
 * Companion-visible sticker catalog — `getAllStickersWithPacks` minus
 * every `user_only` pack. This is the SINGLE source of truth for
 * "what stickers may a companion see or reference." Every
 * companion-facing surface (the `list_stickers` Codex tool, the hook
 * catalog injection, `sc sticker list`) reads from here, so a future
 * caller is filtered by default rather than re-deriving the rule and
 * drifting (which is exactly how the legacy paths leaked before this
 * fix).
 *
 * The `user_only` rows are excluded in SQL so they never leave the
 * DB on a companion path. User-facing HTTP routes deliberately keep
 * the unfiltered `getAllStickersWithPacks` — the human manages their
 * own private packs there.
 *
 * The returned rows still carry `user_only` (always `false` here) so
 * the shape matches `getAllStickersWithPacks` and callers can be
 * swapped without further changes.
 */
export function getCompanionStickersWithPacks(): Array<Sticker & { pack_name: string; user_only: boolean }> {
  const rows = getDb().prepare(`
    SELECT s.*, p.name as pack_name, p.user_only FROM stickers s
    JOIN sticker_packs p ON p.id = s.pack_id
    WHERE p.user_only = 0
    ORDER BY p.name ASC, s.sort_order ASC
  `).all();
  return rows.map((row) => ({
    ...rowToSticker(row),
    pack_name: (row as any).pack_name,
    user_only: !!(row as any).user_only,
  }));
}
