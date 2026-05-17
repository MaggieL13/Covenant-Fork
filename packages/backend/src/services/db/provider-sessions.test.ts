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
  hasProviderSessionsForThread,
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

  describe('hasProviderSessionsForThread — gates the legacy current_session_id fallback', () => {
    // Regression suite for the Codex bot catch on PR #16. The original
    // AgentService._processQuery fallback was gated on
    // `runtime === 'claude-sdk' && thread.current_session_id` alone,
    // which fired whenever the exact (runtime, provider, model_ref)
    // lookup missed — including normal model switches. A thread
    // mid-Sonnet-session that switched to Opus would have NO Opus
    // sidecar row, fall through to `thread.current_session_id`, and
    // resume the Sonnet session under Opus — defeating per-model
    // isolation. The fix added a `!hasProviderSessionsForThread()`
    // gate so the fallback only fires for truly pre-PR-C threads.

    it('returns false when the thread has no sidecar rows (pre-PR-C state)', () => {
      expect(hasProviderSessionsForThread('thread-1')).toBe(false);
    });

    it('returns true after a single sidecar row is written', () => {
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-sonnet',
      });
      expect(hasProviderSessionsForThread('thread-1')).toBe(true);
    });

    it('scopes to the requested thread only', () => {
      setProviderSession({
        threadId: 'thread-2',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-elsewhere',
      });
      expect(hasProviderSessionsForThread('thread-1')).toBe(false);
      expect(hasProviderSessionsForThread('thread-2')).toBe(true);
    });

    it('returns false again after all rows for the thread are cleared', () => {
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-sonnet',
      });
      expect(hasProviderSessionsForThread('thread-1')).toBe(true);
      clearProviderSessionsForThread('thread-1');
      expect(hasProviderSessionsForThread('thread-1')).toBe(false);
    });

    // The headline scenario the Codex bot called out. This documents
    // the bug the gate prevents — pinning the exact conditions that
    // would have produced an incorrect cross-model resume before the
    // fix. Not testing the AgentService resolver directly (lives
    // inside `_processQuery`, would need heavy mocking), but verifies
    // the gate predicate this case turns on.
    it('Sonnet sidecar row exists + Opus lookup → gate engaged → legacy fallback MUST NOT fire', () => {
      // Setup: thread has a Sonnet sidecar row (after one prior turn).
      setProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
        sessionId: 'session-sonnet',
      });

      // Resolver step-by-step (mirrors `_processQuery` logic):
      // 1. Exact-key lookup for Opus → null
      const opusLookup = getProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-opus-4-7',
      });
      expect(opusLookup).toBeNull();

      // 2. Gate check — thread HAS sidecar rows → fallback blocked.
      expect(hasProviderSessionsForThread('thread-1')).toBe(true);

      // 3. Resolver returns undefined → Opus starts fresh. The Sonnet
      //    session row remains intact for when the user switches back.
    });

    it('legacy thread (zero sidecar rows) → gate disengaged → fallback DOES fire', () => {
      // Setup: pre-PR-C thread. Never touched after the migration ran.
      // Its `threads.current_session_id` is the only resume pointer.
      // (No sidecar setup — this thread is genuinely empty in the table.)

      // Resolver step-by-step:
      // 1. Exact-key lookup → null
      const claudeLookup = getProviderSession({
        threadId: 'thread-1',
        runtimeId: 'claude-sdk',
        provider: 'claude',
        modelRef: 'claude/claude-sonnet-4-6',
      });
      expect(claudeLookup).toBeNull();

      // 2. Gate check — thread has NO sidecar rows → fallback allowed.
      expect(hasProviderSessionsForThread('thread-1')).toBe(false);

      // 3. Resolver returns thread.current_session_id (the legacy pointer).
      //    Pre-PR-C session resumes cleanly. The finally block then
      //    writes the first sidecar row, and subsequent turns on this
      //    thread hit the sidecar path directly (gate flips to true).
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
