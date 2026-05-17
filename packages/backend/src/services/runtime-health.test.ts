import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock embeddings/vector cache to avoid loading HuggingFace at test time
vi.mock('./embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)),
}));
vi.mock('./vector-cache.js', () => ({
  cacheEmbedding: vi.fn(),
  cacheDigestEmbedding: vi.fn(),
}));
// Mock config (computeMinRequirement reads tier defaults via the resolver,
// which falls back to YAML when DB is empty)
vi.mock('../config.js', () => ({
  getResonantConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Test', user_name: 'User', timezone: 'UTC' },
    server: { port: 3002, host: 'localhost', db_path: ':memory:' },
    hooks: { context_injection: false, safe_write_prefixes: [] },
    agent: {},
  }),
  PROJECT_ROOT: '/tmp/test',
}));

import { compareVersions, computeMinRequirement } from './runtime-health.js';
import { initDb, setConfig, deleteConfig } from './db.js';

/**
 * Regression suite for runtime-health version comparison and helpers.
 *
 * The critical invariant: `compareVersions("2.1.98", "2.1.111")` must
 * return -1, not 1. String/lexicographic comparison gets this wrong
 * (because '9' > '1' at position 4) — the helper splits on '.' and
 * compares numerically per component to fix this. If this test ever
 * starts reporting a positive number for "2.1.98" vs "2.1.111", the
 * helper has regressed to lex comparison and any model with a
 * minimum-CC-version requirement past 2.1.99 will be wrongly judged
 * "satisfied" by older bundled runtimes.
 */

describe('compareVersions', () => {
  it('returns -1 when a < b at the patch level (multi-digit critical case)', () => {
    // The headline case. Lexically '9' > '1', but 98 < 111 numerically.
    expect(compareVersions('2.1.98', '2.1.111')).toBe(-1);
  });

  it('returns 1 when a > b at the patch level (multi-digit critical case)', () => {
    expect(compareVersions('2.1.111', '2.1.98')).toBe(1);
  });

  it('returns 0 for identical versions', () => {
    expect(compareVersions('2.1.111', '2.1.111')).toBe(0);
  });

  it('compares minor versions correctly', () => {
    expect(compareVersions('2.0.0', '2.1.0')).toBe(-1);
    expect(compareVersions('2.1.0', '2.0.0')).toBe(1);
  });

  it('compares major versions correctly (and dominates over lower components)', () => {
    expect(compareVersions('3.0.0', '2.99.99')).toBe(1);
    expect(compareVersions('2.99.99', '3.0.0')).toBe(-1);
  });

  it('treats missing components as 0', () => {
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
    expect(compareVersions('2.1', '2.1.5')).toBe(-1);
    expect(compareVersions('2.1.5', '2.1')).toBe(1);
  });

  it('handles zero-padded-looking components numerically', () => {
    // No actual zero-padding in practice (Anthropic uses plain integers),
    // but this confirms the Number() conversion does the right thing.
    expect(compareVersions('2.1.10', '2.1.9')).toBe(1);
    expect(compareVersions('2.1.9', '2.1.10')).toBe(-1);
  });

  it('compares Opus 4.7 minimum (2.1.111) against bundled (2.1.98) — the actual real-world case', () => {
    // This is the comparison the panel makes for an Opus 4.7 user with
    // the current bundled SDK. Active < required → status 'outdated'.
    const active = '2.1.98';
    const required = '2.1.111';
    expect(compareVersions(active, required)).toBeLessThan(0);
  });
});

describe('computeMinRequirement — non-Claude tier safety (regression for PR A boundary leak)', () => {
  // The bug Codex bot caught on PR #15: resolveConfiguredAgentModel
  // threw on non-Claude refs everywhere it was called, including the
  // /runtime/health endpoint. A user setting `agent.model` to
  // `openai-codex/gpt-5-1` would 500 the health endpoint instead of
  // surfacing the friendly in-chat error path. Fix: runtime-health
  // uses the safe (non-throwing) resolver and skips non-claude-sdk refs
  // since they have no Claude Code minimum to enforce.

  beforeEach(() => {
    initDb(':memory:');
    // Clear any tier overrides from previous test runs
    deleteConfig('agent.model');
    deleteConfig('agent.model_autonomous');
    deleteConfig('agent.model_pulse');
  });

  it('returns Opus 4.7 minimum when interactive tier is configured to claude-opus-4-7', () => {
    setConfig('agent.model', 'claude-opus-4-7');
    const result = computeMinRequirement();
    expect(result).not.toBeNull();
    expect(result?.version).toBe('2.1.111');
    expect(result?.reason).toContain('claude-opus-4-7');
    expect(result?.reason).toContain('interactive');
  });

  it('returns null and does NOT throw when interactive tier is a non-Claude ref', () => {
    setConfig('agent.model', 'openai-codex/gpt-5-1');
    // Default autonomous/pulse fall back to claude-sonnet-4-6 / claude-haiku-4-5
    // which have no minimum declared, so the whole call returns null without
    // any tier throwing.
    expect(() => computeMinRequirement()).not.toThrow();
    expect(computeMinRequirement()).toBeNull();
  });

  it('returns null and does NOT throw when ALL three tiers are non-Claude refs', () => {
    setConfig('agent.model', 'openai-codex/gpt-5-1');
    setConfig('agent.model_autonomous', 'openrouter/openai/gpt-5-1');
    setConfig('agent.model_pulse', 'ollama/qwen3:latest');
    expect(() => computeMinRequirement()).not.toThrow();
    expect(computeMinRequirement()).toBeNull();
  });

  it('finds Claude minimums from other tiers when some tiers are non-Claude', () => {
    // Interactive points at a non-Claude runtime; autonomous still hits Opus 4.7.
    // The health panel should surface autonomous as the bottleneck (correct
    // behavior: chat won't actually run on the non-Claude tier because the SDK
    // boundary throws, but autonomous wakes need Opus 4.7's min CC version).
    setConfig('agent.model', 'openai-codex/gpt-5-1');
    setConfig('agent.model_autonomous', 'claude-opus-4-7');
    const result = computeMinRequirement();
    expect(result?.version).toBe('2.1.111');
    expect(result?.reason).toContain('autonomous');
  });

  it('does not throw on a malformed ref (unknown provider prefix)', () => {
    // normalizeModelRef throws on `mistral/large` (unknown provider).
    // computeMinRequirement should swallow that and continue — the SDK
    // boundary surfaces the real error when the tier actually runs.
    setConfig('agent.model', 'mistral/large');
    expect(() => computeMinRequirement()).not.toThrow();
  });
});
