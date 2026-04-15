import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Reaction } from '@resonant/shared';

// Mock embeddings to avoid loading HuggingFace ML model
vi.mock('./embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)),
}));

// Mock vector cache
vi.mock('./vector-cache.js', () => ({
  cacheEmbedding: vi.fn(),
}));

// Mock config
vi.mock('../config.js', () => ({
  getResonantConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Test', user_name: 'User', timezone: 'UTC' },
    server: { port: 3002, host: 'localhost', db_path: ':memory:' },
    hooks: { context_injection: false, safe_write_prefixes: [] },
  }),
  PROJECT_ROOT: '/tmp/test',
}));

import {
  initDb,
  getDb,
  createThread,
  getThread,
  listThreads,
  archiveThread,
  deleteThread,
  createMessage,
  getMessage,
  getMessages,
  markMessagesRead,
  addReaction,
  removeReaction,
  saveEmbedding,
  createCanvas,
  getCanvas,
  listCanvases,
  deleteCanvas,
  createTimer,
  listPendingTimers,
  cancelTimer,
  getConfig,
  setConfig,
  getConfigBool,
  pinThread,
  unpinThread,
  getTodayThread,
  saveDigestEmbedding,
  getAllDigestEmbeddings,
} from './db.js';

beforeEach(() => {
  initDb(':memory:');
});

function makeThread(overrides: Partial<{ id: string; name: string; type: 'daily' | 'named' }> = {}) {
  const id = overrides.id || `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return createThread({
    id,
    name: overrides.name || 'Test Thread',
    type: overrides.type || 'daily',
    createdAt: new Date().toISOString(),
  });
}

function makeMessage(threadId: string, overrides: Partial<{ id: string; role: 'companion' | 'user' | 'system'; content: string }> = {}) {
  const id = overrides.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return createMessage({
    id,
    threadId,
    role: overrides.role || 'user',
    content: overrides.content || 'short',  // Keep short to avoid triggering embeddings
    createdAt: new Date().toISOString(),
  });
}

describe('Thread operations', () => {
  it('creates and retrieves a thread', () => {
    const thread = makeThread({ id: 'th-1', name: 'My Thread' });
    expect(thread.id).toBe('th-1');
    expect(thread.name).toBe('My Thread');
    expect(thread.type).toBe('daily');
    expect(thread.archived_at).toBeNull();

    const fetched = getThread('th-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('My Thread');
  });

  it('returns null for non-existent thread', () => {
    expect(getThread('nope')).toBeNull();
  });

  it('lists threads excluding archived', () => {
    makeThread({ id: 'th-a', name: 'Active' });
    makeThread({ id: 'th-b', name: 'Archived' });
    archiveThread('th-b', new Date().toISOString());

    const threads = listThreads({});
    expect(threads.length).toBe(1);
    expect(threads[0].id).toBe('th-a');
  });

  it('lists threads including archived', () => {
    makeThread({ id: 'th-a' });
    makeThread({ id: 'th-b' });
    archiveThread('th-b', new Date().toISOString());

    const threads = listThreads({ includeArchived: true });
    expect(threads.length).toBe(2);
  });

  it('archives a thread', () => {
    makeThread({ id: 'th-1' });
    archiveThread('th-1', '2026-01-01T00:00:00Z');

    const thread = getThread('th-1');
    expect(thread!.archived_at).toBe('2026-01-01T00:00:00Z');
  });

  it('deletes thread data but keeps detached canvases', () => {
    makeThread({ id: 'th-del' });
    makeMessage('th-del', { id: 'msg-1' });
    makeMessage('th-del', { id: 'msg-2' });
    createCanvas({
      id: 'canvas-1', threadId: 'th-del', title: 'Test',
      contentType: 'text', createdBy: 'user', createdAt: new Date().toISOString(),
    });

    const fileIds = deleteThread('th-del');
    expect(Array.isArray(fileIds)).toBe(true);
    expect(getThread('th-del')).toBeNull();
    expect(getMessage('msg-1')).toBeNull();
    expect(getMessage('msg-2')).toBeNull();
    expect(getCanvas('canvas-1')).toMatchObject({
      id: 'canvas-1',
      thread_id: null,
      title: 'Test',
    });
  });
});

describe('Message operations', () => {
  it('creates and retrieves a message', () => {
    const thread = makeThread({ id: 'th-msg' });
    const msg = makeMessage('th-msg', { id: 'msg-1', content: 'hello', role: 'user' });

    expect(msg.id).toBe('msg-1');
    expect(msg.content).toBe('hello');
    expect(msg.role).toBe('user');
    expect(msg.sequence).toBe(1);

    const fetched = getMessage('msg-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe('hello');
  });

  it('returns null for non-existent message', () => {
    expect(getMessage('nope')).toBeNull();
  });

  it('auto-increments sequence numbers', () => {
    makeThread({ id: 'th-seq' });
    const msg1 = makeMessage('th-seq', { id: 'msg-s1' });
    const msg2 = makeMessage('th-seq', { id: 'msg-s2' });
    const msg3 = makeMessage('th-seq', { id: 'msg-s3' });

    expect(msg1.sequence).toBe(1);
    expect(msg2.sequence).toBe(2);
    expect(msg3.sequence).toBe(3);
  });

  it('getMessages returns in chronological order', () => {
    makeThread({ id: 'th-order' });
    makeMessage('th-order', { id: 'msg-a', content: 'first' });
    makeMessage('th-order', { id: 'msg-b', content: 'second' });
    makeMessage('th-order', { id: 'msg-c', content: 'third' });

    const messages = getMessages({ threadId: 'th-order' });
    expect(messages.length).toBe(3);
    expect(messages[0].content).toBe('first');
    expect(messages[2].content).toBe('third');
  });

  it('getMessages respects limit', () => {
    makeThread({ id: 'th-lim' });
    for (let i = 0; i < 10; i++) {
      makeMessage('th-lim', { id: `msg-l${i}` });
    }

    const messages = getMessages({ threadId: 'th-lim', limit: 3 });
    expect(messages.length).toBe(3);
  });

  it('creates message with metadata', () => {
    makeThread({ id: 'th-meta' });
    const msg = createMessage({
      id: 'msg-meta',
      threadId: 'th-meta',
      role: 'companion',
      content: 'hi',
      metadata: { tool: 'test', count: 42 },
      createdAt: new Date().toISOString(),
    });

    const fetched = getMessage('msg-meta');
    expect(fetched!.metadata).toEqual({ tool: 'test', count: 42 });
  });
});

describe('markMessagesRead', () => {
  it('marks messages read and resets thread unread count', () => {
    makeThread({ id: 'th-read' });
    makeMessage('th-read', { id: 'msg-r1', role: 'companion' });
    makeMessage('th-read', { id: 'msg-r2', role: 'companion' });

    // Simulate unread count being incremented
    getDb().prepare('UPDATE threads SET unread_count = 2 WHERE id = ?').run('th-read');

    const readAt = new Date().toISOString();
    markMessagesRead('th-read', 'msg-r2', readAt);

    // Both messages should have read_at set
    const msg1 = getMessage('msg-r1');
    const msg2 = getMessage('msg-r2');
    expect(msg1!.read_at).toBe(readAt);
    expect(msg2!.read_at).toBe(readAt);

    // Thread unread count should be reset
    const thread = getThread('th-read');
    expect(thread!.unread_count).toBe(0);
  });
});

describe('Reaction operations', () => {
  it('adds a reaction to a message', () => {
    makeThread({ id: 'th-react' });
    makeMessage('th-react', { id: 'msg-react' });

    addReaction('msg-react', '👍', 'user');

    const msg = getMessage('msg-react');
    const reactions = (msg!.metadata as Record<string, unknown>)?.reactions as Reaction[];
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe('👍');
    expect(reactions[0].user).toBe('user');
  });

  it('deduplicates same user + emoji', () => {
    makeThread({ id: 'th-dedup' });
    makeMessage('th-dedup', { id: 'msg-dedup' });

    addReaction('msg-dedup', '👍', 'user');
    addReaction('msg-dedup', '👍', 'user');

    const msg = getMessage('msg-dedup');
    const reactions = (msg!.metadata as Record<string, unknown>)?.reactions as Reaction[];
    expect(reactions).toHaveLength(1);
  });

  it('allows different users same emoji', () => {
    makeThread({ id: 'th-diff' });
    makeMessage('th-diff', { id: 'msg-diff' });

    addReaction('msg-diff', '👍', 'user');
    addReaction('msg-diff', '👍', 'companion');

    const msg = getMessage('msg-diff');
    const reactions = (msg!.metadata as Record<string, unknown>)?.reactions as Reaction[];
    expect(reactions).toHaveLength(2);
  });

  it('removes a reaction', () => {
    makeThread({ id: 'th-rm' });
    makeMessage('th-rm', { id: 'msg-rm' });

    addReaction('msg-rm', '👍', 'user');
    addReaction('msg-rm', '❤️', 'companion');
    removeReaction('msg-rm', '👍', 'user');

    const msg = getMessage('msg-rm');
    const reactions = (msg!.metadata as Record<string, unknown>)?.reactions as Reaction[];
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe('❤️');
  });

  it('no-ops when removing non-existent reaction', () => {
    makeThread({ id: 'th-noop' });
    makeMessage('th-noop', { id: 'msg-noop' });

    addReaction('msg-noop', '👍', 'user');
    removeReaction('msg-noop', '❤️', 'user');

    const msg = getMessage('msg-noop');
    const reactions = (msg!.metadata as Record<string, unknown>)?.reactions as Reaction[];
    expect(reactions).toHaveLength(1);
  });

  it('no-ops for non-existent message', () => {
    addReaction('nope', '👍', 'user');
    removeReaction('nope', '👍', 'user');
    // Should not throw
  });
});

describe('Canvas operations', () => {
  it('creates and retrieves a canvas', () => {
    const canvas = createCanvas({
      id: 'cv-1', title: 'Test Canvas', content: '# Hello',
      contentType: 'markdown', createdBy: 'companion', createdAt: new Date().toISOString(),
    });

    expect(canvas.id).toBe('cv-1');
    expect(canvas.title).toBe('Test Canvas');

    const fetched = getCanvas('cv-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe('# Hello');
  });

  it('lists canvases', () => {
    createCanvas({ id: 'cv-a', title: 'A', contentType: 'text', createdBy: 'user', createdAt: new Date().toISOString() });
    createCanvas({ id: 'cv-b', title: 'B', contentType: 'text', createdBy: 'user', createdAt: new Date().toISOString() });

    const canvases = listCanvases();
    expect(canvases.length).toBe(2);
  });

  it('deletes a canvas', () => {
    createCanvas({ id: 'cv-del', title: 'Del', contentType: 'text', createdBy: 'user', createdAt: new Date().toISOString() });
    const deleted = deleteCanvas('cv-del');
    expect(deleted).toBe(true);
    expect(getCanvas('cv-del')).toBeNull();
  });

  it('returns false deleting non-existent canvas', () => {
    expect(deleteCanvas('nope')).toBe(false);
  });
});

describe('Timer operations', () => {
  it('creates and lists pending timers', () => {
    makeThread({ id: 'th-timer' });
    createTimer({
      id: 'timer-1', label: 'Test Timer', fireAt: '2026-12-01T00:00:00Z',
      threadId: 'th-timer', createdAt: new Date().toISOString(),
    });

    const pending = listPendingTimers();
    expect(pending.length).toBe(1);
    expect(pending[0].label).toBe('Test Timer');
  });

  it('cancels a timer', () => {
    makeThread({ id: 'th-cancel' });
    createTimer({
      id: 'timer-c', label: 'Cancel Me', fireAt: '2026-12-01T00:00:00Z',
      threadId: 'th-cancel', createdAt: new Date().toISOString(),
    });

    const cancelled = cancelTimer('timer-c');
    expect(cancelled).toBe(true);

    const pending = listPendingTimers();
    expect(pending.length).toBe(0);
  });
});

describe('Config operations', () => {
  it('gets default config values', () => {
    // initDb sets dnd_start and dnd_end defaults
    expect(getConfig('dnd_start')).toBe('23:00');
    expect(getConfig('dnd_end')).toBe('07:00');
  });

  it('sets and gets config', () => {
    setConfig('test_key', 'test_value');
    expect(getConfig('test_key')).toBe('test_value');
  });

  it('returns null for missing config', () => {
    expect(getConfig('nonexistent')).toBeNull();
  });

  it('getConfigBool returns boolean', () => {
    setConfig('flag_true', 'true');
    setConfig('flag_one', '1');
    setConfig('flag_false', 'false');

    expect(getConfigBool('flag_true', false)).toBe(true);
    expect(getConfigBool('flag_one', false)).toBe(true);
    expect(getConfigBool('flag_false', true)).toBe(false);
    expect(getConfigBool('nonexistent', true)).toBe(true);
  });
});

describe('Embedding operations', () => {
  it('saves and replaces embedding', () => {
    makeThread({ id: 'th-emb' });
    makeMessage('th-emb', { id: 'msg-emb' });

    const vector1 = Buffer.alloc(384 * 4);
    saveEmbedding('msg-emb', vector1);

    // Save again — INSERT OR REPLACE should work
    const vector2 = Buffer.alloc(384 * 4, 1);
    saveEmbedding('msg-emb', vector2);

    // Should not throw — if it does, the OR REPLACE is broken
  });
});

describe('Pin/unpin behavior', () => {
  it('pins a thread', () => {
    makeThread({ id: 'th-pin' });
    pinThread('th-pin');

    const thread = getThread('th-pin');
    expect(thread!.pinned_at).not.toBeNull();
    expect(typeof thread!.pinned_at).toBe('string');
  });

  it('unpins a thread', () => {
    makeThread({ id: 'th-unpin' });
    pinThread('th-unpin');
    unpinThread('th-unpin');

    const thread = getThread('th-unpin');
    expect(thread!.pinned_at).toBeNull();
  });

  it('pin is idempotent (multiple pins ok)', () => {
    makeThread({ id: 'th-idem' });
    pinThread('th-idem');
    const firstPin = getThread('th-idem')!.pinned_at;
    pinThread('th-idem');
    // Should still be pinned (timestamp may update, but it stays pinned)
    expect(getThread('th-idem')!.pinned_at).not.toBeNull();
    expect(typeof firstPin).toBe('string');
  });

  it('unpin is safe on unpinned thread', () => {
    makeThread({ id: 'th-safe' });
    unpinThread('th-safe'); // Should not throw
    expect(getThread('th-safe')!.pinned_at).toBeNull();
  });
});

describe('Unarchive behavior', () => {
  it('archives then unarchives a thread', () => {
    makeThread({ id: 'th-unarch' });

    // Archive
    archiveThread('th-unarch', '2026-01-01T00:00:00Z');
    expect(getThread('th-unarch')!.archived_at).toBe('2026-01-01T00:00:00Z');

    // Unarchive by passing null
    archiveThread('th-unarch', null);
    expect(getThread('th-unarch')!.archived_at).toBeNull();
  });

  it('unarchived thread reappears in default list', () => {
    makeThread({ id: 'th-a' });
    makeThread({ id: 'th-b' });
    archiveThread('th-b', new Date().toISOString());

    // Only 'th-a' shows by default
    expect(listThreads({}).length).toBe(1);

    // Unarchive 'th-b'
    archiveThread('th-b', null);

    // Now both show
    expect(listThreads({}).length).toBe(2);
  });
});

describe('Scribe digest data pipeline', () => {
  it('getTodayThread returns null when no thread exists for today', () => {
    // Fresh DB, no threads — Scribe has nothing to digest yet
    expect(getTodayThread()).toBeNull();
  });

  it('getTodayThread returns a thread created today', () => {
    createThread({
      id: 'th-today',
      name: 'Today',
      type: 'daily',
      createdAt: new Date().toISOString(),
    });

    const today = getTodayThread();
    expect(today).not.toBeNull();
    expect(today!.id).toBe('th-today');
  });

  it('saveDigestEmbedding persists and can be read back', () => {
    const vector = Buffer.alloc(384 * 4);
    saveDigestEmbedding('digest-1', '2026-04-14', 0, vector, 'Test block content');

    const all = getAllDigestEmbeddings();
    expect(all.length).toBe(1);
    expect(all[0].digest_id).toBe('digest-1');
    expect(all[0].date).toBe('2026-04-14');
    expect(all[0].block_index).toBe(0);
    expect(all[0].content).toBe('Test block content');
  });

  it('stores multiple digests (one row per digest_id)', () => {
    const vector = Buffer.alloc(384 * 4);
    saveDigestEmbedding('digest-2a', '2026-04-14', 0, vector, 'Block 0');
    saveDigestEmbedding('digest-2b', '2026-04-14', 1, vector, 'Block 1');
    saveDigestEmbedding('digest-2c', '2026-04-14', 2, vector, 'Block 2');

    const all = getAllDigestEmbeddings();
    expect(all.length).toBe(3);
    expect(all.map(d => d.digest_id).sort()).toEqual(['digest-2a', 'digest-2b', 'digest-2c']);
  });

  // NOTE: digest_id is the primary key, so re-saving with the same digest_id
  // replaces the previous row. Block-per-digest is not supported by the current schema.
  // Flagged for review in a future batch (schema design is out of scope for Batch 0).
  it('INSERT OR REPLACE on same digest_id overwrites previous row', () => {
    const vector = Buffer.alloc(384 * 4);
    saveDigestEmbedding('digest-3', '2026-04-14', 0, vector, 'First version');
    saveDigestEmbedding('digest-3', '2026-04-14', 0, vector, 'Second version');

    const all = getAllDigestEmbeddings();
    const match = all.filter(d => d.digest_id === 'digest-3');
    expect(match.length).toBe(1);
    expect(match[0].content).toBe('Second version');
  });
});
