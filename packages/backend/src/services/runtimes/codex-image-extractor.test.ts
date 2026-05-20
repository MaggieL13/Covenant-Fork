import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Message } from '@resonant/shared';

// ─────────────────────────────────────────────────────────────────────────
// Mocks
//
// `getFile` returns whatever this test sets per fileId. `statSync` /
// `readFileSync` are wired through a per-test fixture map keyed by the
// resolved file path that `getFile` would have produced.
// ─────────────────────────────────────────────────────────────────────────

interface FsFixture {
  /** Resolved file path -> { size, bytes }. */
  files: Map<string, { size: number; bytes: Buffer }>;
}
const fsFixture: FsFixture = { files: new Map() };

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    statSync: (p: string) => {
      const entry = fsFixture.files.get(p);
      if (!entry) {
        const err = new Error(`ENOENT: no such file ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      return { size: entry.size } as ReturnType<typeof actual.statSync>;
    },
    readFileSync: ((p: string) => {
      const entry = fsFixture.files.get(p);
      if (!entry) {
        const err = new Error(`ENOENT: no such file ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      return entry.bytes;
    }) as typeof actual.readFileSync,
  };
});

interface FileFixtureEntry {
  path: string;
  mimeType: string;
  filename: string;
}
const getFileFixture = new Map<string, FileFixtureEntry | null>();
vi.mock('../files.js', () => ({
  getFile: (fileId: string) => getFileFixture.get(fileId) ?? null,
}));

// Import AFTER mocks so the module under test sees the mocked deps.
const { extractImagesFromMessages, __TEST_INTERNALS__ } = await import(
  './codex-image-extractor.js'
);

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function makeMessage(partial: Partial<Message> & { id: string }): Message {
  return {
    id: partial.id,
    thread_id: partial.thread_id ?? 'thread-1',
    sequence: partial.sequence ?? 0,
    role: partial.role ?? 'user',
    content: partial.content ?? '',
    content_type: partial.content_type ?? 'text',
    platform: partial.platform ?? 'web',
    metadata: partial.metadata ?? null,
    reply_to_id: partial.reply_to_id ?? null,
    reply_to_preview: partial.reply_to_preview ?? null,
    edited_at: partial.edited_at ?? null,
    deleted_at: partial.deleted_at ?? null,
    original_content: partial.original_content ?? null,
    created_at: partial.created_at ?? '2026-05-20T00:00:00.000Z',
    delivered_at: partial.delivered_at ?? null,
  } as Message;
}

function registerFile(
  fileId: string,
  opts: { binarySize: number; mimeType?: string; path?: string },
): { path: string; mimeType: string } {
  const path = opts.path ?? `/data/files/${fileId}.bin`;
  const mimeType = opts.mimeType ?? 'image/png';
  getFileFixture.set(fileId, { path, mimeType, filename: `${fileId}.bin` });
  fsFixture.files.set(path, {
    size: opts.binarySize,
    // The bytes themselves don't matter for these tests — base64 length
    // grows linearly with binary size (~+33%), which is the budget
    // signal we exercise. Allocate a buffer so encoding succeeds.
    bytes: Buffer.alloc(opts.binarySize, 0xab),
  });
  return { path, mimeType };
}

beforeEach(() => {
  fsFixture.files.clear();
  getFileFixture.clear();
});

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('extractImagesFromMessages — shape 1 (batched upload)', () => {
  it('claims attachments on the parent message and dedupes the child', () => {
    registerFile('img-1', { binarySize: 1024, mimeType: 'image/png' });

    const messages: Message[] = [
      makeMessage({
        id: 'parent-msg',
        content_type: 'text',
        content: 'Maggie sent an image (cat.png).',
        metadata: {
          attachments: [
            { fileId: 'img-1', filename: 'cat.png', mimeType: 'image/png', contentType: 'image', size: 1024 },
          ],
        },
      }),
      // Child file message the handler writes alongside the parent.
      makeMessage({
        id: 'child-msg',
        content_type: 'image',
        content: '/api/files/img-1',
        metadata: { fileId: 'img-1', filename: 'cat.png', size: 1024, mimeType: 'image/png' },
      }),
    ];

    const result = extractImagesFromMessages(messages);

    expect(result.imagesByMessageId.size).toBe(1);
    const onParent = result.imagesByMessageId.get('parent-msg');
    expect(onParent).toHaveLength(1);
    expect(onParent![0].mimeType).toBe('image/png');
    // Base64 of 1024 zero-ish bytes = 1368 chars (ceil(1024 / 3) * 4 = 1368).
    expect(onParent![0].base64.length).toBe(1368);
    // Child must not appear as a separate owner.
    expect(result.imagesByMessageId.has('child-msg')).toBe(false);
    expect(result.fallbackNotices).toHaveLength(0);
  });

  it('keeps multiple images on the parent in declared order', () => {
    registerFile('img-a', { binarySize: 600, mimeType: 'image/png' });
    registerFile('img-b', { binarySize: 900, mimeType: 'image/jpeg' });

    const messages: Message[] = [
      makeMessage({
        id: 'parent',
        content_type: 'text',
        metadata: {
          attachments: [
            { fileId: 'img-a', contentType: 'image', mimeType: 'image/png' },
            { fileId: 'img-b', contentType: 'image', mimeType: 'image/jpeg' },
          ],
        },
      }),
    ];

    const result = extractImagesFromMessages(messages);
    const onParent = result.imagesByMessageId.get('parent')!;
    expect(onParent.map(i => i.mimeType)).toEqual(['image/png', 'image/jpeg']);
  });

  it('ignores non-image attachments inside the batch', () => {
    registerFile('img', { binarySize: 100, mimeType: 'image/png' });

    const messages: Message[] = [
      makeMessage({
        id: 'parent',
        content_type: 'text',
        metadata: {
          attachments: [
            { fileId: 'pdf', contentType: 'file', mimeType: 'application/pdf' },
            { fileId: 'img', contentType: 'image', mimeType: 'image/png' },
          ],
        },
      }),
    ];

    const result = extractImagesFromMessages(messages);
    const onParent = result.imagesByMessageId.get('parent')!;
    expect(onParent).toHaveLength(1);
    expect(onParent[0].mimeType).toBe('image/png');
  });
});

describe('extractImagesFromMessages — shape 2 (single attachment / Telegram)', () => {
  it('treats metadata.photoFileId equivalently to metadata.fileId', () => {
    registerFile('tg-photo', { binarySize: 2048, mimeType: 'image/jpeg' });

    const messages: Message[] = [
      makeMessage({
        id: 'tg-msg',
        content_type: 'image',
        content: '[Photo from Maggie] caption text',
        metadata: { photoFileId: 'tg-photo', mimeType: 'image/jpeg' },
      }),
    ];

    const result = extractImagesFromMessages(messages);
    const onTg = result.imagesByMessageId.get('tg-msg')!;
    expect(onTg).toHaveLength(1);
    expect(onTg[0].mimeType).toBe('image/jpeg');
  });

  it('attaches via metadata.fileId when both fileId and photoFileId are present (Telegram pairs them)', () => {
    registerFile('tg-photo', { binarySize: 512, mimeType: 'image/jpeg' });

    const messages: Message[] = [
      makeMessage({
        id: 'tg-msg',
        content_type: 'image',
        metadata: { fileId: 'tg-photo', photoFileId: 'tg-photo', mimeType: 'image/jpeg' },
      }),
    ];

    const result = extractImagesFromMessages(messages);
    expect(result.imagesByMessageId.get('tg-msg')).toHaveLength(1);
  });

  it('skips image-content messages with no fileId in metadata', () => {
    const messages: Message[] = [
      makeMessage({
        id: 'broken',
        content_type: 'image',
        metadata: { mimeType: 'image/png' },
      }),
    ];

    const result = extractImagesFromMessages(messages);
    expect(result.imagesByMessageId.size).toBe(0);
    // No fileId to record against, no fallback notice either (the ref
    // never existed).
    expect(result.fallbackNotices).toHaveLength(0);
  });
});

describe('extractImagesFromMessages — budgets', () => {
  it('falls back when a single image exceeds the 5MB binary cap', () => {
    const oversize = __TEST_INTERNALS__.MAX_BINARY_BYTES_PER_IMAGE + 1;
    registerFile('big', { binarySize: oversize, mimeType: 'image/png' });

    const messages: Message[] = [
      makeMessage({
        id: 'parent',
        content_type: 'text',
        metadata: {
          attachments: [{ fileId: 'big', contentType: 'image', mimeType: 'image/png' }],
        },
      }),
    ];

    const result = extractImagesFromMessages(messages);
    expect(result.imagesByMessageId.size).toBe(0);
    expect(result.fallbackNotices).toHaveLength(1);
    expect(result.fallbackNotices[0]).toMatchObject({
      fileId: 'big',
      reason: expect.stringContaining('per-image cap'),
    });
  });

  it('falls back when adding an image would push past the per-turn encoded cap', () => {
    // Each image: ~4MB binary → ~5.33MB encoded. Three of them = ~16MB
    // encoded > 15MB cap. First two attach; third falls back.
    const fourMb = 4 * 1024 * 1024;
    registerFile('a', { binarySize: fourMb, mimeType: 'image/png' });
    registerFile('b', { binarySize: fourMb, mimeType: 'image/png' });
    registerFile('c', { binarySize: fourMb, mimeType: 'image/png' });

    const messages: Message[] = [
      makeMessage({
        id: 'parent',
        content_type: 'text',
        metadata: {
          attachments: [
            { fileId: 'a', contentType: 'image', mimeType: 'image/png' },
            { fileId: 'b', contentType: 'image', mimeType: 'image/png' },
            { fileId: 'c', contentType: 'image', mimeType: 'image/png' },
          ],
        },
      }),
    ];

    const result = extractImagesFromMessages(messages);
    const attached = result.imagesByMessageId.get('parent') ?? [];
    expect(attached).toHaveLength(2);
    expect(result.fallbackNotices).toHaveLength(1);
    expect(result.fallbackNotices[0]).toMatchObject({
      fileId: 'c',
      reason: expect.stringContaining('encoded cap'),
    });
  });

  it('rejects non-image MIME types loudly', () => {
    // File exists, but declared MIME is not image/*. We should NOT
    // attach it — even if it could be base64-encoded fine.
    getFileFixture.set('pdf', {
      path: '/data/files/pdf.pdf',
      mimeType: 'application/pdf',
      filename: 'pdf.pdf',
    });
    fsFixture.files.set('/data/files/pdf.pdf', { size: 1024, bytes: Buffer.alloc(1024) });

    const messages: Message[] = [
      makeMessage({
        id: 'msg',
        content_type: 'image',
        metadata: { fileId: 'pdf', mimeType: 'application/pdf' },
      }),
    ];

    const result = extractImagesFromMessages(messages);
    expect(result.imagesByMessageId.size).toBe(0);
    expect(result.fallbackNotices).toHaveLength(1);
    expect(result.fallbackNotices[0]).toMatchObject({
      fileId: 'pdf',
      reason: expect.stringContaining('non-image MIME type'),
    });
  });

  it('falls back with a clear reason when the referenced file is missing on disk', () => {
    // getFile returns null (no fixture registered).
    const messages: Message[] = [
      makeMessage({
        id: 'msg',
        content_type: 'image',
        metadata: { fileId: 'missing', mimeType: 'image/png' },
      }),
    ];

    const result = extractImagesFromMessages(messages);
    expect(result.imagesByMessageId.size).toBe(0);
    expect(result.fallbackNotices).toEqual([
      { fileId: 'missing', reason: 'file not found on disk' },
    ]);
  });
});

describe('extractImagesFromMessages — dedup across history', () => {
  it('dedupes the same fileId across multiple turns', () => {
    registerFile('shared', { binarySize: 256, mimeType: 'image/png' });

    const messages: Message[] = [
      makeMessage({
        id: 'turn-1',
        created_at: '2026-05-20T00:00:00.000Z',
        content_type: 'image',
        metadata: { fileId: 'shared', mimeType: 'image/png' },
      }),
      // Hypothetical re-reference (e.g. quoted reply). The image bytes
      // shouldn't be attached twice in the same turn.
      makeMessage({
        id: 'turn-2',
        created_at: '2026-05-20T00:01:00.000Z',
        content_type: 'image',
        metadata: { fileId: 'shared', mimeType: 'image/png' },
      }),
    ];

    const result = extractImagesFromMessages(messages);
    // First occurrence (chronologically earliest) owns it; the second
    // is silently dropped (no fallback — it's not an error, just dedup).
    expect(result.imagesByMessageId.size).toBe(1);
    expect(result.imagesByMessageId.has('turn-1')).toBe(true);
    expect(result.imagesByMessageId.has('turn-2')).toBe(false);
    expect(result.fallbackNotices).toHaveLength(0);
  });
});
