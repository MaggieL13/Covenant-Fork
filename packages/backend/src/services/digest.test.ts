import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock embeddings to avoid loading the HuggingFace model
vi.mock('./embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)),
}));

// Mock vector cache
vi.mock('./vector-cache.js', () => ({
  cacheEmbedding: vi.fn(),
  cacheDigestEmbedding: vi.fn(),
}));

// Mock config module (digest.ts reads identity.timezone via getResonantConfig)
vi.mock('../config.js', () => ({
  getResonantConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Test', user_name: 'User', timezone: 'UTC' },
    server: { port: 3002, host: 'localhost', db_path: ':memory:' },
    hooks: { context_injection: false, safe_write_prefixes: [] },
  }),
  PROJECT_ROOT: '/tmp/test',
}));

import { initDb, createThread, createMessage, getDb } from './db.js';
import { getDigestCursor, setDigestCursor } from './digest.js';

describe('digest — per-thread cursor (regression for cross-thread sequence rollover)', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  it('defaults to 0 for a thread that has never been digested', () => {
    const thread = createThread({
      id: 'thread-fresh',
      name: 'fresh',
      type: 'daily',
      createdAt: new Date().toISOString(),
    });
    expect(getDigestCursor(thread.id)).toBe(0);
  });

  it('round-trips a cursor value per thread', () => {
    const t1 = createThread({
      id: 'thread-1',
      name: 'one',
      type: 'daily',
      createdAt: new Date().toISOString(),
    });
    const t2 = createThread({
      id: 'thread-2',
      name: 'two',
      type: 'daily',
      createdAt: new Date().toISOString(),
    });

    setDigestCursor(t1.id, 42);
    setDigestCursor(t2.id, 7);

    expect(getDigestCursor(t1.id)).toBe(42);
    expect(getDigestCursor(t2.id)).toBe(7);
  });

  it('isolates cursors across threads — advancing one does not leak to another', () => {
    const t1 = createThread({
      id: 'thread-a',
      name: 'a',
      type: 'daily',
      createdAt: new Date().toISOString(),
    });
    const t2 = createThread({
      id: 'thread-b',
      name: 'b',
      type: 'daily',
      createdAt: new Date().toISOString(),
    });

    setDigestCursor(t1.id, 200);
    // t2 has never been touched — must still read 0, not leak from t1
    expect(getDigestCursor(t2.id)).toBe(0);
  });

  it('legacy global digest.last_sequence key is ignored (no migration, no backfill)', () => {
    const thread = createThread({
      id: 'thread-legacy-ignored',
      name: 'legacy',
      type: 'daily',
      createdAt: new Date().toISOString(),
    });
    // Seed the old global key as if a pre-fix run left it behind
    getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('digest.last_sequence', '999')").run();
    // New per-thread cursor should start fresh at 0
    expect(getDigestCursor(thread.id)).toBe(0);
  });

  // Regression for the exact reported failure mode: the previous thread
  // accumulated sequence 200; today's new thread has sequences 1..3; under
  // the old single-global cursor the query `sequence > 200 AND thread_id =
  // <today>` returned zero messages and digests were silently skipped
  // every run.
  it('a new thread with low sequence numbers is digestable even after an older thread cursor went high', () => {
    const oldThread = createThread({
      id: 'thread-yesterday',
      name: 'yesterday',
      type: 'daily',
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const newThread = createThread({
      id: 'thread-today',
      name: 'today',
      type: 'daily',
      createdAt: '2026-04-20T00:00:00.000Z',
    });

    // Seed the old thread with a large digest cursor (simulate many past messages)
    setDigestCursor(oldThread.id, 200);

    // Seed the new thread with fresh messages — these naturally get
    // sequences 1, 2, 3 because sequence is per-thread.
    for (let i = 0; i < 3; i++) {
      createMessage({
        id: `msg-${i}`,
        threadId: newThread.id,
        role: 'user',
        content: `message ${i}`,
        createdAt: new Date().toISOString(),
      });
    }

    // Under the new per-thread cursor the new thread's cursor is 0, so
    // the same query runDigest uses returns all 3 messages.
    const cursor = getDigestCursor(newThread.id);
    expect(cursor).toBe(0);

    const rows = getDb()
      .prepare(
        "SELECT sequence FROM messages WHERE thread_id = ? AND sequence > ? AND deleted_at IS NULL AND content_type = 'text' ORDER BY sequence ASC",
      )
      .all(newThread.id, cursor) as Array<{ sequence: number }>;

    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3]);

    // And advancing the new thread's cursor doesn't leak back to the old one
    setDigestCursor(newThread.id, 3);
    expect(getDigestCursor(oldThread.id)).toBe(200);
    expect(getDigestCursor(newThread.id)).toBe(3);
  });
});
