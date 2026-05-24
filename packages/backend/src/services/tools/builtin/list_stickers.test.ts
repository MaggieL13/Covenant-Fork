import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, realpath, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock embeddings + vector cache so the test doesn't load HuggingFace.
// Mirrors `db/attachment-warnings.test.ts` — the DB module pulls in
// embeddings transitively via message-related code paths.
vi.mock('../../embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)),
}));
vi.mock('../../vector-cache.js', () => ({
  cacheEmbedding: vi.fn(),
  cacheDigestEmbedding: vi.fn(),
}));
vi.mock('../../../config.js', () => ({
  getResonantConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Test', user_name: 'User', timezone: 'UTC' },
    server: { port: 3002, host: 'localhost', db_path: ':memory:' },
    hooks: { context_injection: false, safe_write_prefixes: [] },
    agent: {},
  }),
  PROJECT_ROOT: '/tmp/test',
}));

import { initDb, createStickerPack, createSticker } from '../../db/index.js';
import { listStickersTool, buildStickerCatalog } from './list_stickers.js';
import { readFileTool } from './read_file.js';
import { listFilesTool } from './list_files.js';
import { searchTextTool } from './search_text.js';
import { isSensitivePath } from '../sensitive-paths.js';
import type { ToolContext } from '../registry.js';

function seedStickers(): void {
  initDb(':memory:');
  // A normal pack for the companion.
  createStickerPack({
    id: 'pack-moods',
    name: 'Moods',
    createdAt: new Date().toISOString(),
  });
  createSticker({
    id: 'st-happy',
    packId: 'pack-moods',
    name: 'happy',
    filename: 'happy.webp',
    aliases: ['joy', 'smile'],
    createdAt: new Date().toISOString(),
  });
  createSticker({
    id: 'st-sad',
    packId: 'pack-moods',
    name: 'sad',
    filename: 'sad.webp',
    aliases: [],
    createdAt: new Date().toISOString(),
  });
  // A user-only pack — must be filtered out of the catalog.
  createStickerPack({
    id: 'pack-private',
    name: 'PrivateMaggie',
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

describe('list_stickers — Cleanup-3 catalog visibility', () => {
  beforeEach(() => {
    // Each test seeds its own fresh in-memory DB.
  });

  it('returns flat catalog with pack/name/ref/aliases shape', async () => {
    seedStickers();
    const raw = await listStickersTool.execute({}, { scopeRoot: '/tmp' });
    const parsed = JSON.parse(raw) as {
      stickers: Array<{
        pack: string;
        name: string;
        ref: string;
        aliases: string[];
      }>;
    };
    expect(Array.isArray(parsed.stickers)).toBe(true);
    // Find by name so test order doesn't depend on DB row order.
    const happy = parsed.stickers.find((s) => s.name === 'happy');
    expect(happy).toBeDefined();
    expect(happy!.pack).toBe('moods');
    expect(happy!.ref).toBe(':moods_happy:');
  });

  it('filters out user_only packs entirely (not even as a flag)', async () => {
    seedStickers();
    const raw = await listStickersTool.execute({}, { scopeRoot: '/tmp' });
    const parsed = JSON.parse(raw) as {
      stickers: Array<{ pack: string; name: string }>;
    };
    // PrivateMaggie pack must be invisible to the catalog.
    expect(parsed.stickers.find((s) => s.pack === 'privatemaggie')).toBeUndefined();
    expect(parsed.stickers.find((s) => s.name === 'secret')).toBeUndefined();
  });

  it('returns aliases as full ref strings, not raw alias names', async () => {
    seedStickers();
    const raw = await listStickersTool.execute({}, { scopeRoot: '/tmp' });
    const parsed = JSON.parse(raw) as {
      stickers: Array<{ name: string; aliases: string[] }>;
    };
    const happy = parsed.stickers.find((s) => s.name === 'happy');
    expect(happy?.aliases).toEqual([':moods_joy:', ':moods_smile:']);
    // No-alias sticker returns an empty array, not undefined.
    const sad = parsed.stickers.find((s) => s.name === 'sad');
    expect(sad?.aliases).toEqual([]);
  });

  it('declares zero arguments (no path / pattern / pack filter)', () => {
    const params = listStickersTool.parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(params.properties)).toEqual([]);
    expect(params.required ?? []).toEqual([]);
  });

  it('buildStickerCatalog is the pure transformation (no IO at the seam)', () => {
    seedStickers();
    const catalog = buildStickerCatalog();
    // Same filtering rules apply — handy for downstream consumers
    // (e.g. a future search/filter wrapper) that want the typed
    // array without re-parsing JSON.
    expect(catalog.find((s) => s.pack === 'privatemaggie')).toBeUndefined();
    expect(catalog.find((s) => s.name === 'happy')?.ref).toBe(':moods_happy:');
  });
});

describe('sticker binary opacity — Cleanup-3 deny-list', () => {
  let scopeRoot: string;

  beforeEach(async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'cov-stickers-deny-'));
    scopeRoot = await realpath(tmpRoot);
    // Create the sticker subtree so resolved paths actually exist.
    // sensitive-path checks are path-shape only, but having a real
    // tree means tool tests work against the same fs we're denying.
    await mkdir(join(scopeRoot, 'data', 'stickers', 'moods'), {
      recursive: true,
    });
  });

  it('isSensitivePath flags data/stickers/<pack>/<file>.webp', async () => {
    const target = join(scopeRoot, 'data', 'stickers', 'moods', 'happy.webp');
    const match = isSensitivePath(target, scopeRoot);
    expect(match).not.toBeNull();
    // The matching pattern's source should reference data/stickers.
    expect(match).toContain('data');
    expect(match).toContain('stickers');
  });

  it('isSensitivePath flags the data/stickers directory itself', () => {
    const target = join(scopeRoot, 'data', 'stickers');
    expect(isSensitivePath(target, scopeRoot)).not.toBeNull();
  });

  it('does NOT flag unrelated files under data/', () => {
    const target = join(scopeRoot, 'data', 'something-else.txt');
    expect(isSensitivePath(target, scopeRoot)).toBeNull();
  });

  it('read_file refuses sticker binaries with sensitive_path error', async () => {
    const { writeFile } = await import('fs/promises');
    await writeFile(
      join(scopeRoot, 'data', 'stickers', 'moods', 'happy.webp'),
      Buffer.from([0x52, 0x49, 0x46, 0x46]), // tiny fake webp header
    );
    const ctx: ToolContext = { scopeRoot };
    const raw = await readFileTool.execute(
      { path: 'data/stickers/moods/happy.webp' },
      ctx,
    );
    const parsed = JSON.parse(raw);
    expect(parsed.error?.code).toBe('sensitive_path');
    // Message must route the model to the right alternative.
    expect(parsed.error?.message).toContain('list_stickers');
  });

  it('search_text skips the data/stickers subtree (no content leak)', async () => {
    const { writeFile } = await import('fs/promises');
    // Plant a text marker INSIDE a "sticker" file. Real stickers are
    // binary, but if the walker ever descended into data/stickers and
    // scanned files for matches, this marker would surface in the
    // output. The deny-list must prevent that — search_text should
    // treat the whole subtree the same way it treats `node_modules`
    // / `.git` (skip + count in the notice).
    //
    // Pattern and value are DELIBERATELY DIFFERENT — search_text
    // echoes the pattern in its "no matches" header, so testing the
    // leak means checking that the VALUE bytes never appear, not the
    // pattern string. (Mirrors the `.ssh/config` no-bypass test.)
    await writeFile(
      join(scopeRoot, 'data', 'stickers', 'moods', 'happy.webp'),
      'PRIVATE_STICKER=sssp-leak-marker-7392\n',
    );
    const ctx: ToolContext = { scopeRoot };
    const out = await searchTextTool.execute(
      { pattern: 'PRIVATE_STICKER', path: '.' },
      ctx,
    );
    // The marker MUST NOT appear — if it does, the walker descended
    // into data/stickers and matched the planted text.
    expect(out).not.toContain('sssp-leak-marker-7392');
    // The skip-notice should surface, confirming the deny-list fired
    // (rather than the search simply finding nothing for another reason).
    expect(out).toContain('tool-layer deny-list');
  });

  it('list_files redacts sticker files inside data/stickers', async () => {
    const { writeFile } = await import('fs/promises');
    await writeFile(
      join(scopeRoot, 'data', 'stickers', 'moods', 'happy.webp'),
      Buffer.from([0x52, 0x49, 0x46, 0x46]),
    );
    await writeFile(
      join(scopeRoot, 'data', 'stickers', 'moods', 'sad.webp'),
      Buffer.from([0x52, 0x49, 0x46, 0x46]),
    );
    const ctx: ToolContext = { scopeRoot };
    const out = await listFilesTool.execute(
      { path: 'data/stickers/moods' },
      ctx,
    );
    expect(out).toContain('happy.webp [redacted');
    expect(out).toContain('sad.webp [redacted');
    expect(out).toContain('tool-layer deny-list');
  });
});
