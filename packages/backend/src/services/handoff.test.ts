import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock embeddings + vector cache to avoid loading HuggingFace
vi.mock('./embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)),
}));
vi.mock('./vector-cache.js', () => ({
  cacheEmbedding: vi.fn(),
  cacheDigestEmbedding: vi.fn(),
}));
vi.mock('../config.js', () => ({
  getResonantConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Zephyr', user_name: 'Maggie', timezone: 'UTC' },
    server: { port: 3002, host: 'localhost', db_path: ':memory:' },
    hooks: { context_injection: false, safe_write_prefixes: [] },
    agent: {},
  }),
  PROJECT_ROOT: '/tmp/test',
}));

import { initDb, createThread, createMessage, getThread } from './db.js';
import {
  buildProviderHandoff,
  renderProviderHandoffAsPrompt,
  DEFAULT_HANDOFF_BUDGET,
  type SummarizeFn,
  type ProviderHandoff,
} from './handoff.js';

const COMMON = {
  targetRuntime: 'claude-sdk',
  targetProvider: 'claude',
  targetModelRef: 'claude/claude-opus-4-7',
  memoryTierModel: 'claude-haiku-4-5',
  identityCompanionName: 'Zephyr',
  identityUserName: 'Maggie',
} as const;

/** Default mock summarizer — returns a fixed memory-tier-style summary. */
const okSummarize: SummarizeFn = vi.fn(async () => 'Maggie and Zephyr discussed the multi-provider runtime arc, decided to split B-series into smaller PRs, and are now working on PR D handoff packets.');

/** Failing summarizer — returns empty (triggers extractive fallback). */
const emptySummarize: SummarizeFn = vi.fn(async () => '');

/** Throwing summarizer — wrapped by handoff in try/catch, also falls back. */
const throwingSummarize: SummarizeFn = vi.fn(async () => {
  throw new Error('memory tier broken');
});

function seedConversation(threadId: string, messages: Array<{ role: 'user' | 'companion'; content: string }>) {
  let i = 0;
  for (const m of messages) {
    createMessage({
      id: `msg-${threadId}-${i}`,
      threadId,
      role: m.role,
      content: m.content,
      contentType: 'text',
      platform: 'web',
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
    });
    i++;
  }
}

describe('buildProviderHandoff — PR D cross-provider continuity', () => {
  beforeEach(() => {
    initDb(':memory:');
    createThread({
      id: 'thread-1',
      name: 'multi-provider arc planning',
      type: 'named',
      createdAt: new Date().toISOString(),
    });
    vi.clearAllMocks();
  });

  describe('skip conditions', () => {
    it('returns null when the thread has no messages at all', async () => {
      const thread = getThread('thread-1')!;
      const handoff = await buildProviderHandoff({
        ...COMMON,
        thread,
        summarize: okSummarize,
      });
      expect(handoff).toBeNull();
      expect(okSummarize).not.toHaveBeenCalled();  // never even attempted
    });

    it('returns null when the thread has user messages but no assistant turn', async () => {
      // Thread with only a user message (e.g. they typed and the agent
      // hasn't replied yet). Nothing to hand off — no prior assistant
      // context for the new combo to inherit.
      seedConversation('thread-1', [{ role: 'user', content: 'hello' }]);
      const thread = getThread('thread-1')!;
      const handoff = await buildProviderHandoff({
        ...COMMON,
        thread,
        summarize: okSummarize,
      });
      expect(handoff).toBeNull();
    });
  });

  describe('memory-tier summary path', () => {
    it('builds a handoff with the memory-tier summary when the summarizer returns content', async () => {
      seedConversation('thread-1', [
        { role: 'user', content: 'help me plan PR D' },
        { role: 'companion', content: 'okay, the handoff packet has three pieces: summary, last-N messages, and metadata' },
        { role: 'user', content: 'what about the budget?' },
        { role: 'companion', content: '400 tokens summary, 1600 tokens recent, 2000 total cap' },
      ]);
      const thread = getThread('thread-1')!;
      const handoff = await buildProviderHandoff({
        ...COMMON,
        thread,
        summarize: okSummarize,
      });

      expect(handoff).not.toBeNull();
      expect(handoff!.handoffVersion).toBe(1);
      expect(handoff!.summarySource).toBe('memory-tier');
      expect(handoff!.summary).toContain('multi-provider runtime arc');
      expect(handoff!.toModelRef).toBe('claude/claude-opus-4-7');
      expect(handoff!.threadTitle).toBe('multi-provider arc planning');
      expect(handoff!.recentMessages).toHaveLength(4);  // all 4 fit comfortably
      expect(okSummarize).toHaveBeenCalledOnce();
    });

    it('truncates an over-long memory-tier summary to the budget', async () => {
      seedConversation('thread-1', [
        { role: 'user', content: 'hi' },
        { role: 'companion', content: 'hi back' },
      ]);
      const longSummarize: SummarizeFn = async () => 'x'.repeat(5000);
      const thread = getThread('thread-1')!;

      const handoff = await buildProviderHandoff({
        ...COMMON,
        thread,
        summarize: longSummarize,
      });

      // budget.summaryTokens (400) * CHARS_PER_TOKEN (4) = 1600 chars max
      expect(handoff!.summary.length).toBeLessThanOrEqual(1600);
      expect(handoff!.summary.endsWith('...')).toBe(true);
      expect(handoff!.summarySource).toBe('memory-tier');
    });
  });

  describe('extractive fallback path', () => {
    it('falls back to extractive when the summarizer returns empty', async () => {
      seedConversation('thread-1', [
        { role: 'user', content: 'How does Codex OAuth work?' },
        { role: 'companion', content: 'It uses device-code flow with PKCE.' },
        { role: 'user', content: 'Does it need the Codex CLI?' },
        { role: 'companion', content: 'No, the pi-ai package handles it in pure Node.' },
      ]);
      const thread = getThread('thread-1')!;
      const handoff = await buildProviderHandoff({
        ...COMMON,
        thread,
        summarize: emptySummarize,
      });

      expect(handoff).not.toBeNull();
      expect(handoff!.summarySource).toBe('extractive-fallback');
      // Extractive summary should mention both early-user content + late-assistant content
      expect(handoff!.summary).toContain('Maggie');
      expect(handoff!.summary).toContain('Zephyr');
      expect(handoff!.summary).toContain('Codex OAuth');  // first user turn captured
    });

    it('falls back to extractive when the summarizer throws', async () => {
      seedConversation('thread-1', [
        { role: 'user', content: 'plan check?' },
        { role: 'companion', content: 'all good' },
      ]);
      const thread = getThread('thread-1')!;
      const handoff = await buildProviderHandoff({
        ...COMMON,
        thread,
        summarize: throwingSummarize,
      });

      expect(handoff).not.toBeNull();
      expect(handoff!.summarySource).toBe('extractive-fallback');
      expect(handoff!.summary.length).toBeGreaterThan(0);
    });
  });

  describe('recent-messages assembly + budget enforcement', () => {
    it('includes all messages when total content fits within the budget', async () => {
      seedConversation('thread-1', [
        { role: 'user', content: 'short' },
        { role: 'companion', content: 'reply' },
        { role: 'user', content: 'another' },
        { role: 'companion', content: 'response' },
      ]);
      const thread = getThread('thread-1')!;
      const handoff = await buildProviderHandoff({
        ...COMMON,
        thread,
        summarize: okSummarize,
      });
      expect(handoff!.recentMessages).toHaveLength(4);
    });

    it('trims oldest messages when total content exceeds the recent-tokens budget', async () => {
      // Each message ~1500 chars; budget.recentTokens (1600) * CHARS_PER_TOKEN (4) = 6400 chars.
      // So roughly 4 messages fit, with the oldest getting dropped first.
      const longMsg = 'x'.repeat(1500);
      seedConversation('thread-1', [
        { role: 'user', content: longMsg },
        { role: 'companion', content: longMsg },
        { role: 'user', content: longMsg },
        { role: 'companion', content: longMsg },
        { role: 'user', content: longMsg },
        { role: 'companion', content: longMsg },
      ]);
      const thread = getThread('thread-1')!;
      const handoff = await buildProviderHandoff({
        ...COMMON,
        thread,
        summarize: okSummarize,
      });

      // Should have fewer than 6 (some got trimmed) but at least 1
      expect(handoff!.recentMessages.length).toBeGreaterThan(0);
      expect(handoff!.recentMessages.length).toBeLessThan(6);
    });

    it('preserves chronological order in recentMessages (oldest of the kept window first)', async () => {
      seedConversation('thread-1', [
        { role: 'user', content: 'first' },
        { role: 'companion', content: 'second' },
        { role: 'user', content: 'third' },
        { role: 'companion', content: 'fourth' },
      ]);
      const thread = getThread('thread-1')!;
      const handoff = await buildProviderHandoff({
        ...COMMON,
        thread,
        summarize: okSummarize,
      });
      expect(handoff!.recentMessages.map((m) => m.content)).toEqual(['first', 'second', 'third', 'fourth']);
    });
  });

  describe('budget hole regressions (Codex bot catch on PR #17)', () => {
    // Pre-fix, the trimming loop included the newest message even when
    // it was larger than the entire recent-message budget (because of
    // the `recentMessages.length > 0` guard). One huge message could
    // blow the whole 2k-token "cheap handoff" promise. These tests pin
    // the fixed behavior — newest oversized message gets truncated to
    // fit, totalCap is enforced across summary + recent together.

    it('truncates a single huge newest message rather than blowing the budget', async () => {
      // One enormous assistant message (50KB) — way bigger than the
      // recent budget (6400 chars default). Pre-fix would include all
      // 50KB. Post-fix truncates to fit.
      const hugeMsg = 'x'.repeat(50_000);
      seedConversation('thread-1', [
        { role: 'user', content: 'short setup' },
        { role: 'companion', content: hugeMsg },
      ]);
      const thread = getThread('thread-1')!;
      const handoff = await buildProviderHandoff({
        ...COMMON,
        thread,
        summarize: okSummarize,
      });

      expect(handoff).not.toBeNull();
      // recentMessages should contain the truncated message (tail kept)
      expect(handoff!.recentMessages).toHaveLength(1);
      expect(handoff!.recentMessages[0].content.length).toBeLessThan(50_000);
      // Should have the obvious truncation suffix
      expect(handoff!.recentMessages[0].content).toContain('[...truncated for handoff budget]');
      // Total approx tokens should respect the cap
      expect(handoff!.totalTokensApprox).toBeLessThanOrEqual(DEFAULT_HANDOFF_BUDGET.totalCap);
    });

    it('truncated message preserves the tail (most-recent content) rather than the head', async () => {
      // Use a message where head vs tail differ identifiably so we can
      // verify the truncation kept the right end.
      const headMarker = 'HEAD_MARKER_FIRST_CONTENT ';
      const tailMarker = ' TAIL_MARKER_LAST_CONTENT';
      const filler = 'x'.repeat(50_000);
      const longMsg = headMarker + filler + tailMarker;
      seedConversation('thread-1', [
        { role: 'user', content: 'setup' },
        { role: 'companion', content: longMsg },
      ]);
      const thread = getThread('thread-1')!;
      const handoff = await buildProviderHandoff({
        ...COMMON,
        thread,
        summarize: okSummarize,
      });

      expect(handoff!.recentMessages).toHaveLength(1);
      const truncated = handoff!.recentMessages[0].content;
      // Tail preserved (the most recent content of the message — what
      // the new combo most needs for continuation)
      expect(truncated).toContain(tailMarker);
      // Head dropped
      expect(truncated).not.toContain(headMarker);
    });

    it('enforces totalCap even when summaryTokens + recentTokens would individually fit but together exceed', async () => {
      // Custom budget where individual lanes (50 + 100 = 150) would
      // each accept content but the combined cap is small (60).
      // Pre-fix would let summary + recent independently fill their
      // lanes; post-fix enforces totalCap across the sum.
      seedConversation('thread-1', [
        { role: 'user', content: 'this is some content that takes space' },
        { role: 'companion', content: 'and this is the response content' },
      ]);
      const thread = getThread('thread-1')!;
      const customBudget = { summaryTokens: 30, recentTokens: 100, totalCap: 30 };
      // ↑ summary alone could be 120 chars (30*4), recent alone could be
      // 400 chars (100*4), but total can't exceed 120 chars (30*4).
      const handoff = await buildProviderHandoff({
        ...COMMON,
        thread,
        summarize: okSummarize,
        budget: customBudget,
      });

      // After trimming, summary.length + recentCharsApprox should
      // respect totalCap. The summary itself is bounded by summaryTokens
      // (30 * 4 = 120 chars); recent messages get progressively dropped/
      // truncated until total fits.
      const totalCharsCap = customBudget.totalCap * 4;  // CHARS_PER_TOKEN
      expect(handoff!.totalTokensApprox).toBeLessThanOrEqual(customBudget.totalCap);
      // Effective total chars
      const recentChars = handoff!.recentMessages.reduce(
        (sum, m) => sum + m.content.length + 32 /* PER_MESSAGE_OVERHEAD_CHARS */,
        0,
      );
      expect(handoff!.summary.length + recentChars).toBeLessThanOrEqual(totalCharsCap);
    });
  });

  describe('budget reporting', () => {
    it('reports the budget that produced the packet + an approximate token count', async () => {
      seedConversation('thread-1', [
        { role: 'user', content: 'hi' },
        { role: 'companion', content: 'hi back' },
      ]);
      const thread = getThread('thread-1')!;
      const handoff = await buildProviderHandoff({
        ...COMMON,
        thread,
        summarize: okSummarize,
      });
      expect(handoff!.budget).toEqual(DEFAULT_HANDOFF_BUDGET);
      expect(handoff!.totalTokensApprox).toBeGreaterThan(0);
    });

    it('honors a custom budget when provided', async () => {
      seedConversation('thread-1', [
        { role: 'user', content: 'hi' },
        { role: 'companion', content: 'hi back' },
      ]);
      const thread = getThread('thread-1')!;
      const customBudget = { summaryTokens: 50, recentTokens: 100, totalCap: 150 };
      const handoff = await buildProviderHandoff({
        ...COMMON,
        thread,
        summarize: okSummarize,
        budget: customBudget,
      });
      expect(handoff!.budget).toEqual(customBudget);
      // summary capped at 50 tokens * 4 chars/token = 200 chars
      expect(handoff!.summary.length).toBeLessThanOrEqual(200);
    });
  });
});

describe('renderProviderHandoffAsPrompt', () => {
  function makeHandoff(overrides: Partial<ProviderHandoff> = {}): ProviderHandoff {
    return {
      handoffVersion: 1,
      toRuntime: 'codex',
      toProvider: 'openai-codex',
      toModelRef: 'openai-codex/gpt-5-1',
      fromModelRef: 'claude/claude-sonnet-4-6',
      threadTitle: 'arc planning',
      summary: 'Maggie and Zephyr planned the multi-provider arc.',
      summarySource: 'memory-tier',
      recentMessages: [
        { role: 'user', content: 'what next?', createdAt: '2026-05-17T12:00:00Z' },
        { role: 'assistant', content: 'PR D next', createdAt: '2026-05-17T12:00:01Z' },
      ],
      budget: DEFAULT_HANDOFF_BUDGET,
      totalTokensApprox: 50,
      ...overrides,
    };
  }

  it('renders summary + thread title + recent exchanges + the do-not-acknowledge instruction', () => {
    const text = renderProviderHandoffAsPrompt(makeHandoff());
    expect(text).toContain('Thread: arc planning');
    expect(text).toContain('Summary so far:');
    expect(text).toContain('Maggie and Zephyr');
    expect(text).toContain('Recent exchanges:');
    expect(text).toContain('User: what next?');
    expect(text).toContain('Companion: PR D next');
    expect(text).toContain('Do not acknowledge');
  });

  it('renders the fromModelRef hint when present', () => {
    const text = renderProviderHandoffAsPrompt(makeHandoff());
    expect(text).toContain('handoff from claude/claude-sonnet-4-6');
  });

  it('omits the from-hint cleanly when fromModelRef is undefined (pre-PR-C legacy thread case)', () => {
    const text = renderProviderHandoffAsPrompt(makeHandoff({ fromModelRef: undefined }));
    expect(text).not.toContain('from undefined');
    expect(text).toContain('[Conversation context — handoff to');
  });

  it('omits the recent-exchanges block when recentMessages is empty', () => {
    const text = renderProviderHandoffAsPrompt(makeHandoff({ recentMessages: [] }));
    expect(text).not.toContain('Recent exchanges:');
    // summary + thread + instruction still present
    expect(text).toContain('Summary so far:');
    expect(text).toContain('Do not acknowledge');
  });
});
