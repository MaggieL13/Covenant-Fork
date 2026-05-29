import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock embeddings + vector cache so the test doesn't load HuggingFace
// (db/index.js pulls them in transitively via message code paths).
vi.mock('../embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)),
}));
vi.mock('../vector-cache.js', () => ({
  cacheEmbedding: vi.fn(),
  cacheDigestEmbedding: vi.fn(),
}));
vi.mock('../../config.js', () => ({
  getResonantConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Test', user_name: 'User', timezone: 'UTC' },
    server: { port: 3002, host: 'localhost', db_path: ':memory:' },
    hooks: { context_injection: false, safe_write_prefixes: [] },
    agent: {},
  }),
  PROJECT_ROOT: '/tmp/test',
}));

import {
  initDb,
  createStickerPack,
  createSticker,
  getStickerByRef,
  getCompanionStickerByRef,
  getAllStickersWithPacks,
  getCompanionStickersWithPacks,
} from './index.js';

/**
 * Seed one public pack (`moods`) and one private/user-only pack
 * (`private`). The companion-scoped queries must surface `moods` and
 * never `private`; the unfiltered base queries must surface both
 * (that's the human-facing HTTP surface and stays unchanged).
 */
function seed(): void {
  initDb(':memory:');
  createStickerPack({
    id: 'pack-moods',
    name: 'moods',
    createdAt: new Date().toISOString(),
  });
  createSticker({
    id: 'st-happy',
    packId: 'pack-moods',
    name: 'happy',
    filename: 'happy.webp',
    aliases: ['joy'],
    createdAt: new Date().toISOString(),
  });
  createStickerPack({
    id: 'pack-private',
    name: 'private',
    userOnly: true,
    createdAt: new Date().toISOString(),
  });
  createSticker({
    id: 'st-secret',
    packId: 'pack-private',
    name: 'secret',
    filename: 'secret.webp',
    createdAt: new Date().toISOString(),
  });
}

describe('companion-scoped sticker queries — Cleanup-3 followup', () => {
  beforeEach(() => {
    // Each test seeds a fresh in-memory DB.
  });

  describe('getCompanionStickersWithPacks', () => {
    it('includes public packs', () => {
      seed();
      const rows = getCompanionStickersWithPacks();
      expect(rows.find((r) => r.pack_name === 'moods')).toBeDefined();
      expect(rows.find((r) => r.name === 'happy')).toBeDefined();
    });

    it('excludes user_only packs entirely', () => {
      seed();
      const rows = getCompanionStickersWithPacks();
      expect(rows.find((r) => r.pack_name === 'private')).toBeUndefined();
      expect(rows.find((r) => r.name === 'secret')).toBeUndefined();
    });

    it('every returned row has user_only === false (shape parity with base query)', () => {
      seed();
      const rows = getCompanionStickersWithPacks();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.user_only === false)).toBe(true);
    });

    it('base getAllStickersWithPacks STILL returns user_only packs (user-facing surface unchanged)', () => {
      seed();
      const all = getAllStickersWithPacks();
      // The human-facing HTTP routes rely on this — the private pack
      // MUST remain visible through the unfiltered query.
      expect(all.find((r) => r.pack_name === 'private')).toBeDefined();
    });
  });

  describe('getCompanionStickerByRef', () => {
    it('resolves a sticker in a public pack', () => {
      seed();
      const s = getCompanionStickerByRef('moods', 'happy');
      expect(s).not.toBeNull();
      expect(s?.name).toBe('happy');
    });

    it('returns null for a sticker in a user_only pack', () => {
      seed();
      const s = getCompanionStickerByRef('private', 'secret');
      expect(s).toBeNull();
    });

    it('is case-insensitive on pack + sticker name (parity with getStickerByRef)', () => {
      seed();
      expect(getCompanionStickerByRef('MOODS', 'HAPPY')).not.toBeNull();
    });

    it('base getStickerByRef STILL resolves user_only stickers (user-facing surface unchanged)', () => {
      seed();
      // The unfiltered ref lookup must still work for the human surface.
      expect(getStickerByRef('private', 'secret')).not.toBeNull();
    });
  });
});
