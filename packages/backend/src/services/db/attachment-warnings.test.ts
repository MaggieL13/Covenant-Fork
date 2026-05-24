import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock embeddings + vector cache so the test doesn't load HuggingFace
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

import { initDb, createThread, createMessage, getMessage } from './index.js';
import { appendAttachmentWarning } from './attachment-warnings.js';

function withMessage(): string {
  initDb(':memory:');
  createThread({
    id: 'thread-1',
    name: 'test thread',
    type: 'named',
    createdAt: new Date().toISOString(),
  });
  createMessage({
    id: 'msg-1',
    threadId: 'thread-1',
    role: 'user',
    content: 'hello',
    contentType: 'text',
    createdAt: new Date().toISOString(),
  });
  return 'msg-1';
}

describe('appendAttachmentWarning — Cleanup-2 persistence', () => {
  beforeEach(() => {
    // Each test gets a fresh in-memory db via withMessage().
  });

  it('appends a warning to messages.metadata.attachmentWarnings on a fresh message', () => {
    const id = withMessage();
    appendAttachmentWarning(id, {
      fileId: 'file-1',
      filename: 'huge.png',
      reason: 'over 5MB',
    });
    const m = getMessage(id);
    const warnings = (m?.metadata as { attachmentWarnings?: unknown })
      ?.attachmentWarnings;
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect((warnings as Array<{ fileId: string }>)[0].fileId).toBe('file-1');
  });

  it('records receivedAt timestamp automatically when not provided', () => {
    const id = withMessage();
    appendAttachmentWarning(id, {
      fileId: 'file-1',
      filename: 'x.png',
      reason: 'r',
    });
    const m = getMessage(id);
    const w = (m?.metadata as { attachmentWarnings: Array<{ receivedAt: string }> })
      .attachmentWarnings[0];
    expect(typeof w.receivedAt).toBe('string');
    expect(w.receivedAt.length).toBeGreaterThan(0);
  });

  it('preserves caller-supplied receivedAt when provided', () => {
    const id = withMessage();
    const explicit = '2026-05-23T12:00:00.000Z';
    appendAttachmentWarning(id, {
      fileId: 'file-1',
      filename: 'x.png',
      reason: 'r',
      receivedAt: explicit,
    });
    const m = getMessage(id);
    const w = (m?.metadata as { attachmentWarnings: Array<{ receivedAt: string }> })
      .attachmentWarnings[0];
    expect(w.receivedAt).toBe(explicit);
  });

  it('appends a SECOND warning with a different fileId', () => {
    const id = withMessage();
    appendAttachmentWarning(id, {
      fileId: 'file-1',
      filename: 'a.png',
      reason: 'r1',
    });
    appendAttachmentWarning(id, {
      fileId: 'file-2',
      filename: 'b.png',
      reason: 'r2',
    });
    const m = getMessage(id);
    const warnings = (m?.metadata as { attachmentWarnings: Array<{ fileId: string }> })
      .attachmentWarnings;
    expect(warnings.map((w) => w.fileId)).toEqual(['file-1', 'file-2']);
  });

  it('dedupes by fileId — second call with same fileId is a no-op', () => {
    const id = withMessage();
    appendAttachmentWarning(id, {
      fileId: 'file-1',
      filename: 'a.png',
      reason: 'first',
    });
    appendAttachmentWarning(id, {
      fileId: 'file-1',
      filename: 'a.png',
      reason: 'second (would be a retry — should be ignored)',
    });
    const m = getMessage(id);
    const warnings = (m?.metadata as { attachmentWarnings: Array<{ fileId: string; reason: string }> })
      .attachmentWarnings;
    expect(warnings).toHaveLength(1);
    // First writer wins — the original reason is preserved.
    expect(warnings[0].reason).toBe('first');
  });

  it('silently no-ops on unknown messageId (no throw, no row created)', () => {
    initDb(':memory:');
    expect(() =>
      appendAttachmentWarning('nonexistent-id', {
        fileId: 'file-1',
        filename: 'x.png',
        reason: 'r',
      }),
    ).not.toThrow();
  });

  it('preserves other metadata fields when appending (e.g. reactions)', () => {
    const id = withMessage();
    // Stub other metadata first by calling createMessage with metadata
    initDb(':memory:');
    createThread({
      id: 'thread-2',
      name: 't',
      type: 'named',
      createdAt: new Date().toISOString(),
    });
    createMessage({
      id: 'msg-2',
      threadId: 'thread-2',
      role: 'user',
      content: 'hi',
      contentType: 'text',
      metadata: { reactions: [{ emoji: '❤️', user: 'user', created_at: '2026-01-01T00:00:00.000Z' }] },
      createdAt: new Date().toISOString(),
    });
    appendAttachmentWarning('msg-2', {
      fileId: 'file-1',
      filename: 'x.png',
      reason: 'r',
    });
    const m = getMessage('msg-2');
    const meta = m?.metadata as { reactions?: unknown; attachmentWarnings?: unknown };
    expect(Array.isArray(meta?.reactions)).toBe(true);
    expect(Array.isArray(meta?.attachmentWarnings)).toBe(true);
  });
});
