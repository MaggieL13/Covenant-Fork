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

import { initDb, createThread } from './index.js';
import {
  getProviderSession,
  setProviderSession,
  listProviderSessionsForThread,
  clearProviderSessionsForThread,
  clearAllProviderSessions,
} from './provider-sessions.js';

describe('thread_provider_sessions — per-(thread, runtime, provider, model) session sidecar (PR C)', () => {
  beforeEach(() => {
    initDb(':memory:');
    createThread({
      id: 'thread-1',
      name: 'test thread',
      type: 'named',
      createdAt: new Date().toISOString(),
    });
    createThread({
      id: 'thread-2',
      name: 'other thread',
      type: 'named',
      createdAt: new Date().toISOString(),
    });
  });

  describe('setProviderSession + getProviderSession', () => {
    it('round-trips a single session row', () => {
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-abc',
      });

      const got = getProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
      });
      expect(got?.session_id).toBe('session-abc');
      expect(got?.runtime_id).toBe('claude-sdk');
      expect(got?.provider).toBe('claude');
      expect(got?.model_ref).toBe('claude/claude-sonnet-4-6');
      expect(got?.last_used_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns null when no row matches the exact key', () => {
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-abc',
      });

      // Different model → no match (model_ref is part of the PK)
      expect(getProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-opus-4-7',
      })).toBeNull();

      // Different thread → no match
      expect(getProviderSession({
        threadId: 'thread-2',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
      })).toBeNull();

      // Different runtime → no match
      expect(getProviderSession({
        threadId: 'thread-1',
        runtimeId: 'codex',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
      })).toBeNull();
    });

    it('upserts on conflict: same key + new sessionId overwrites', () => {
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-original',
      });
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-rotated',
      });

      const got = getProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
      });
      expect(got?.session_id).toBe('session-rotated');
      // Still exactly one row per key
      expect(listProviderSessionsForThread('thread-1')).toHaveLength(1);
    });

    it('a single thread can hold sessions for multiple model_refs simultaneously', () => {
      // This is THE point of the sidecar — switching Claude models
      // mid-thread doesn't stomp the previous model's session.
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-sonnet',
      });
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-opus-4-7',
        sessionId: 'session-opus',
      });

      expect(getProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
      })?.session_id).toBe('session-sonnet');

      expect(getProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-opus-4-7',
      })?.session_id).toBe('session-opus');

      expect(listProviderSessionsForThread('thread-1')).toHaveLength(2);
    });

    it('a single thread can hold sessions for multiple runtimes simultaneously', () => {
      // The future-multi-provider case: thread chatted on Claude, then
      // chatted on Codex; each keeps its own session pointer.
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-claude',
      });
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'codex',
        provider: 'openai-codex',
        modelRef: 'openai-codex/gpt-5-1',
        sessionId: 'session-codex',
      });

      expect(getProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
      })?.session_id).toBe('session-claude');

      expect(getProviderSession({
        threadId: 'thread-1',
        runtimeId: 'codex',
        provider: 'openai-codex',
        modelRef: 'openai-codex/gpt-5-1',
      })?.session_id).toBe('session-codex');

      expect(listProviderSessionsForThread('thread-1')).toHaveLength(2);
    });

    it('persists optional metadata as JSON', () => {
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-abc',
        metadata: { reasoning: 'high', notes: 'first turn' },
      });
      const got = getProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
      });
      expect(got?.metadata_json).toBeTruthy();
      expect(JSON.parse(got!.metadata_json!)).toEqual({ reasoning: 'high', notes: 'first turn' });
    });
  });

  describe('listProviderSessionsForThread', () => {
    it('returns empty array for a thread with no sessions', () => {
      expect(listProviderSessionsForThread('thread-1')).toEqual([]);
    });

    it('lists multiple sessions ordered by last_used_at DESC', async () => {
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-first',
      });
      // Sleep 10ms to ensure distinct ISO timestamps
      await new Promise((r) => setTimeout(r, 10));
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-opus-4-7',
        sessionId: 'session-second',
      });

      const rows = listProviderSessionsForThread('thread-1');
      expect(rows).toHaveLength(2);
      expect(rows[0].session_id).toBe('session-second');  // most recent first
      expect(rows[1].session_id).toBe('session-first');
    });

    it('scopes to the requested thread only', () => {
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-t1',
      });
      setProviderSession({
        threadId: 'thread-2',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-t2',
      });

      expect(listProviderSessionsForThread('thread-1')).toHaveLength(1);
      expect(listProviderSessionsForThread('thread-1')[0].session_id).toBe('session-t1');
      expect(listProviderSessionsForThread('thread-2')).toHaveLength(1);
      expect(listProviderSessionsForThread('thread-2')[0].session_id).toBe('session-t2');
    });
  });

  describe('clearProviderSessionsForThread', () => {
    it('deletes all rows for the requested thread and returns the count', () => {
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-a',
      });
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'codex',
        provider: 'openai-codex',
        modelRef: 'openai-codex/gpt-5-1',
        sessionId: 'session-b',
      });
      setProviderSession({
        threadId: 'thread-2',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-c',
      });

      const cleared = clearProviderSessionsForThread('thread-1');
      expect(cleared).toBe(2);
      expect(listProviderSessionsForThread('thread-1')).toHaveLength(0);
      // Other thread untouched
      expect(listProviderSessionsForThread('thread-2')).toHaveLength(1);
    });

    it('returns 0 when no rows match (no-op safe)', () => {
      expect(clearProviderSessionsForThread('thread-1')).toBe(0);
      expect(clearProviderSessionsForThread('nonexistent-thread')).toBe(0);
    });
  });

  describe('clearAllProviderSessions', () => {
    it('deletes every row across all threads and returns the total count', () => {
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-a',
      });
      setProviderSession({
        threadId: 'thread-2',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-b',
      });

      expect(clearAllProviderSessions()).toBe(2);
      expect(listProviderSessionsForThread('thread-1')).toHaveLength(0);
      expect(listProviderSessionsForThread('thread-2')).toHaveLength(0);
    });
  });

  describe('FK cascade on thread delete', () => {
    it('removes provider session rows when the parent thread is deleted', async () => {
      const { deleteThread } = await import('./threads.js');
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-a',
      });
      expect(listProviderSessionsForThread('thread-1')).toHaveLength(1);

      deleteThread('thread-1');

      expect(listProviderSessionsForThread('thread-1')).toHaveLength(0);
    });
  });
});
