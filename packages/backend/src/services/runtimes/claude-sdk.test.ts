import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock embeddings/vector cache to avoid loading HuggingFace at test time
vi.mock('../embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)),
}));
vi.mock('../vector-cache.js', () => ({
  cacheEmbedding: vi.fn(),
  cacheDigestEmbedding: vi.fn(),
}));
// Mock config — the resolver reads agent.* defaults via getResonantConfig
vi.mock('../../config.js', () => ({
  getResonantConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Test', user_name: 'User', timezone: 'UTC' },
    server: { port: 3002, host: 'localhost', db_path: ':memory:' },
    hooks: { context_injection: false, safe_write_prefixes: [] },
    agent: {},
  }),
  PROJECT_ROOT: '/tmp/test',
}));

import { ClaudeAgentRuntime } from './claude-sdk.js';
import { resolveConfiguredRuntime } from '../agent.js';
import { initDb, setConfig, deleteConfig } from '../db.js';

describe('ClaudeAgentRuntime — stub for PR B1', () => {
  it('exposes the expected runtime + provider identity', () => {
    const runtime = new ClaudeAgentRuntime();
    expect(runtime.id).toBe('claude-sdk');
    expect(runtime.providerId).toBe('claude');
  });

  it('runTurn throws the "not yet wired" stub error pointing at the AgentTurnInput migration', async () => {
    // PR B3 added the normalized event stream via `runClaudeTurn`
    // (Claude-specific input). The abstract `runTurn(AgentTurnInput)`
    // remains stubbed because AgentService doesn't construct
    // `AgentTurnInput` yet — that migration lands in a later PR
    // (likely folded into the C-series session work). Stub stays
    // throwing in the meantime to flag any accidental caller.
    const runtime = new ClaudeAgentRuntime();
    // Async generators don't throw until iterated. The first .next() call
    // runs the generator body up to the throw.
    const iter = runtime.runTurn({} as never)[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/not wired up yet/);
    await expect(
      runtime.runTurn({} as never)[Symbol.asyncIterator]().next(),
    ).rejects.toThrow(/AgentTurnInput migration/);
    await expect(
      runtime.runTurn({} as never)[Symbol.asyncIterator]().next(),
    ).rejects.toThrow(/runClaudeTurn/);
  });

  it('resumeSessionId returns undefined (no-op stub)', () => {
    const runtime = new ClaudeAgentRuntime();
    expect(runtime.resumeSessionId()).toBeUndefined();
  });

  it('persistSessionId is a no-op (does not throw)', () => {
    const runtime = new ClaudeAgentRuntime();
    expect(() => runtime.persistSessionId()).not.toThrow();
  });

  it('getCapabilityProvider returns undefined for any cap (no-op stub)', () => {
    const runtime = new ClaudeAgentRuntime();
    expect(runtime.getCapabilityProvider('mcp')).toBeUndefined();
    expect(runtime.getCapabilityProvider('rewindFiles')).toBeUndefined();
    expect(runtime.getCapabilityProvider('arbitrary-cap-key')).toBeUndefined();
  });

  it('abort is a no-op (does not throw)', () => {
    const runtime = new ClaudeAgentRuntime();
    expect(() => runtime.abort()).not.toThrow();
  });
});

describe('resolveConfiguredRuntime — runtime dispatch packet (PR B1)', () => {
  beforeEach(() => {
    initDb(':memory:');
    deleteConfig('agent.model');
    deleteConfig('agent.model_autonomous');
    deleteConfig('agent.model_pulse');
  });

  it('returns ClaudeAgentRuntime + parsed ref + capabilities for a Claude tier', () => {
    setConfig('agent.model', 'claude-sonnet-4-6');
    const resolved = resolveConfiguredRuntime('interactive');

    expect(resolved.runtime.id).toBe('claude-sdk');
    expect(resolved.runtime.providerId).toBe('claude');
    expect(resolved.modelRef.canonical).toBe('claude/claude-sonnet-4-6');
    expect(resolved.modelRef.model).toBe('claude-sonnet-4-6');
    expect(resolved.capabilities.tools).toBe(true);
    expect(resolved.capabilities.mcp).toBe(true);
    expect(resolved.capabilities.sessionResume).toBe(true);
  });

  it('returns same runtime instance across calls (singleton)', () => {
    setConfig('agent.model', 'claude-sonnet-4-6');
    const a = resolveConfiguredRuntime('interactive');
    const b = resolveConfiguredRuntime('interactive');
    expect(a.runtime).toBe(b.runtime);
  });

  it('accepts canonical refs from config (claude/claude-sonnet-4-6)', () => {
    setConfig('agent.model', 'claude/claude-sonnet-4-6');
    const resolved = resolveConfiguredRuntime('interactive');
    expect(resolved.runtime.id).toBe('claude-sdk');
    expect(resolved.modelRef.model).toBe('claude-sonnet-4-6');
  });

  it('resolves a Codex ref to the wired CodexRuntime (PR E2)', () => {
    // PR E0 placed Codex entries in the manifest; PR E1 added the OAuth
    // surface; PR E2 wires the runtime. Selecting a Codex ref now
    // resolves cleanly to a runtime with id='codex'. Auth gating
    // happens INSIDE the runtime's runTurn (emits auth_required event
    // when not logged in), not at resolve time.
    setConfig('agent.model', 'openai-codex/gpt-5.1');
    const resolved = resolveConfiguredRuntime('interactive');
    expect(resolved.runtime.id).toBe('codex');
    expect(resolved.runtime.providerId).toBe('openai-codex');
    expect(resolved.modelRef.canonical).toBe('openai-codex/gpt-5.1');
  });

  it('throws friendly error for an OpenRouter ref', () => {
    setConfig('agent.model', 'openrouter/openai/gpt-5-1');
    expect(() => resolveConfiguredRuntime('interactive')).toThrow(/openai-compat runtime/);
  });

  it('throws friendly error for an Ollama ref', () => {
    setConfig('agent.model', 'ollama/qwen3:latest');
    expect(() => resolveConfiguredRuntime('interactive')).toThrow(/ollama-native runtime/);
  });

  it('falls back to all-false capabilities when model is not in manifest (e.g. typoed id)', () => {
    setConfig('agent.model', 'claude-opus-99');
    const resolved = resolveConfiguredRuntime('interactive');
    // Runtime resolves (claude-opus-99 normalizes to Claude provider) but the
    // model isn't in the manifest — capabilities fall back to conservative
    // all-false so UI hides controls rather than offering features the model
    // may not support.
    expect(resolved.runtime.id).toBe('claude-sdk');
    expect(resolved.capabilities.tools).toBe(false);
    expect(resolved.capabilities.mcp).toBe(false);
    expect(resolved.capabilities.sessionResume).toBe(false);
  });

  it('per-tier resolution: autonomous tier uses agent.model_autonomous, pulse uses agent.model_pulse', () => {
    setConfig('agent.model', 'claude-sonnet-4-6');
    setConfig('agent.model_autonomous', 'claude-opus-4-7');
    setConfig('agent.model_pulse', 'claude-haiku-4-5');

    expect(resolveConfiguredRuntime('interactive').modelRef.model).toBe('claude-sonnet-4-6');
    expect(resolveConfiguredRuntime('autonomous').modelRef.model).toBe('claude-opus-4-7');
    expect(resolveConfiguredRuntime('pulse').modelRef.model).toBe('claude-haiku-4-5');
  });
});
