import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────
// Test scope
//
// CodexRuntime has two main surfaces:
//   1) `translatePiEvent` — pure function, the most fragile thing in the
//      module (any drift in pi-ai's event shape silently breaks streaming).
//      We pin every branch of the translation table here.
//   2) `runTurn` — the orchestrator. The high-risk paths are auth gating
//      and unknown-model-id handling, both of which terminate before any
//      pi-ai call. We test those without mocking pi-ai itself. The
//      successful-stream path is exercised in the PR's live smoke (no
//      reasonable way to mock a full pi-ai stream without re-implementing
//      half of it).
// ─────────────────────────────────────────────────────────────────────────

// Mock the OAuth surface so we can flip "logged in" / "not logged in"
// independent of the on-disk credentials file.
const codexAuthMock = {
  loggedIn: false,
};
vi.mock('../auth/codex-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../auth/codex-oauth.js')>(
    '../auth/codex-oauth.js',
  );
  return {
    ...actual,
    getCodexAccessToken: vi.fn(async () => {
      if (!codexAuthMock.loggedIn) {
        throw new actual.CodexAuthRequiredError('not logged in (test)');
      }
      return 'test-access-token';
    }),
  };
});

// Mock the sidecar so we don't need a real DB initialized.
const setProviderSessionSpy = vi.fn();
vi.mock('../db/provider-sessions.js', () => ({
  getProviderSession: vi.fn(() => null),
  setProviderSession: (...args: unknown[]) => setProviderSessionSpy(...args),
}));

// Mock pi-ai's stream + getModel so we can simulate a full success path
// without a real OpenAI request. The stream factory returns a value that
// behaves like pi-ai's AssistantMessageEventStream: an async-iterable
// over events plus a `result()` promise that resolves with the final
// AssistantMessage.
type FakeStream = AsyncIterable<unknown> & {
  result(): Promise<unknown>;
};
const streamFactory: { value: ((...args: unknown[]) => FakeStream) | null } = { value: null };
vi.mock('@earendil-works/pi-ai/openai-codex-responses', () => ({
  streamOpenAICodexResponses: (...args: unknown[]) => {
    if (!streamFactory.value) {
      throw new Error('streamOpenAICodexResponses called but no fake stream is set in test');
    }
    return streamFactory.value(...args);
  },
}));

// Mock getModel to return a synthetic Model when the id is one of our
// known test ids. Unknown ids return undefined (matching pi-ai behavior),
// which exercises the "model not in registry" branch.
vi.mock('@earendil-works/pi-ai', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-ai')>(
    '@earendil-works/pi-ai',
  );
  return {
    ...actual,
    getModel: (provider: string, modelId: string) => {
      if (provider === 'openai-codex' && (modelId === 'gpt-5.5' || modelId === 'test-model')) {
        return {
          id: modelId,
          name: modelId,
          api: 'openai-codex-responses',
          provider: 'openai-codex',
          baseUrl: 'https://chatgpt.com/backend-api',
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 100000,
        };
      }
      return undefined;
    },
  };
});

import { translatePiEvent, CodexRuntime } from './codex.js';
import type { AssistantMessageEvent, AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentRuntimeEvent, AgentTurnInput, NormalizedMessage } from './types.js';
import { normalizeModelRef } from '@resonant/shared';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function fakeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-5.5',
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
    ...overrides,
  };
}

async function collectEvents(iter: AsyncIterable<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const out: AgentRuntimeEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

function fakeTurnInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  const modelRef = normalizeModelRef('openai-codex/gpt-5.5');
  return {
    thread: { id: 'thread-1', name: 't', type: 'daily', current_session_id: null },
    tier: 'interactive',
    modelRef,
    platform: 'web',
    isAutonomous: false,
    orientation: '[Context]\n[/Context]',
    systemPrompt: { kind: 'text', value: 'you are a test companion' },
    messages: [
      { role: 'user', content: 'hello', createdAt: new Date().toISOString() },
    ] as NormalizedMessage[],
    ...overrides,
  };
}

beforeEach(() => {
  codexAuthMock.loggedIn = false;
  streamFactory.value = null;
  setProviderSessionSpy.mockReset();
});

/**
 * Build a fake pi-ai AssistantMessageEventStream that emits the given
 * events in order, then resolves `result()` with `finalMessage`. Used
 * by the successful-stream test to drive CodexRuntime end-to-end.
 */
function makeFakeStream(events: AssistantMessageEvent[], finalMessage: AssistantMessage): FakeStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) {
        yield e;
      }
    },
    result: async () => finalMessage,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// translatePiEvent — the pure event translation table
// ─────────────────────────────────────────────────────────────────────────

describe('translatePiEvent — pi-ai → AgentRuntimeEvent', () => {
  const fakePartial = fakeAssistantMessage();

  it('drops start (structural; payload comes via deltas)', () => {
    const event: AssistantMessageEvent = { type: 'start', partial: fakePartial };
    expect(translatePiEvent(event)).toBeNull();
  });

  it('drops text_start / text_end (structural)', () => {
    expect(translatePiEvent({ type: 'text_start', contentIndex: 0, partial: fakePartial })).toBeNull();
    expect(translatePiEvent({ type: 'text_end', contentIndex: 0, content: 'hi', partial: fakePartial })).toBeNull();
  });

  it('drops thinking_start / thinking_end (structural)', () => {
    expect(translatePiEvent({ type: 'thinking_start', contentIndex: 0, partial: fakePartial })).toBeNull();
    expect(translatePiEvent({ type: 'thinking_end', contentIndex: 0, content: 'think', partial: fakePartial })).toBeNull();
  });

  it('translates text_delta → text_delta with the new chunk only (true delta, not cumulative)', () => {
    const translated = translatePiEvent({
      type: 'text_delta',
      contentIndex: 0,
      delta: 'hello',
      partial: fakePartial,
    });
    expect(translated).toEqual({ type: 'text_delta', text: 'hello' });
  });

  it('translates thinking_delta → thinking_delta', () => {
    const translated = translatePiEvent({
      type: 'thinking_delta',
      contentIndex: 0,
      delta: 'reasoning...',
      partial: fakePartial,
    });
    expect(translated).toEqual({ type: 'thinking_delta', text: 'reasoning...' });
  });

  it('surfaces unexpected tool events as provider_diagnostic (E2 ships no tools)', () => {
    const translated = translatePiEvent({
      type: 'toolcall_start',
      contentIndex: 0,
      partial: fakePartial,
    });
    expect(translated?.type).toBe('provider_diagnostic');
    if (translated?.type === 'provider_diagnostic') {
      expect(translated.code).toBe('unexpected_tool_event');
    }
  });

  it('drops the streaming done event (final usage/sessionId comes via stream.result() in runTurn)', () => {
    const translated = translatePiEvent({
      type: 'done',
      reason: 'stop',
      message: fakeAssistantMessage(),
    });
    expect(translated).toBeNull();
  });

  it('passes through error events with recoverable=false', () => {
    const translated = translatePiEvent({
      type: 'error',
      reason: 'error',
      error: fakeAssistantMessage({ stopReason: 'error', errorMessage: 'boom' }),
    });
    expect(translated?.type).toBe('error');
    if (translated?.type === 'error') {
      expect(translated.message).toBe('boom');
      expect(translated.recoverable).toBe(false);
    }
  });

  it('marks aborted error events as recoverable (matches abort vs hard-fail semantics)', () => {
    const translated = translatePiEvent({
      type: 'error',
      reason: 'aborted',
      error: fakeAssistantMessage({ stopReason: 'aborted', errorMessage: 'cancelled' }),
    });
    expect(translated?.type).toBe('error');
    if (translated?.type === 'error') {
      expect(translated.recoverable).toBe(true);  // aborted ≠ broken
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CodexRuntime.runTurn — gating paths (don't require mocking pi-ai's stream)
// ─────────────────────────────────────────────────────────────────────────

describe('CodexRuntime.runTurn — auth + model-resolution gating', () => {
  it('emits start → auth_required → done(error) when not logged in', async () => {
    codexAuthMock.loggedIn = false;
    const runtime = new CodexRuntime();
    const events = await collectEvents(runtime.runTurn(fakeTurnInput()));

    expect(events).toEqual([
      { type: 'start', runtimeId: 'codex', modelRef: expect.objectContaining({ canonical: 'openai-codex/gpt-5.5' }) },
      { type: 'auth_required', provider: 'openai-codex', message: expect.stringMatching(/not logged in/i) },
      { type: 'done', finishReason: 'error' },
    ]);
  });

  it('emits error → done when model id is not in pi-ai registry', async () => {
    codexAuthMock.loggedIn = true;  // get past the auth gate
    const runtime = new CodexRuntime();
    // Forge a modelRef whose `.model` field is not in pi-ai's registry.
    const input = fakeTurnInput();
    (input as { modelRef: { model: string } }).modelRef = {
      ...input.modelRef,
      model: 'gpt-totally-fake',
    } as typeof input.modelRef;

    const events = await collectEvents(runtime.runTurn(input));

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('start');
    expect(types).toContain('error');
    expect(types[types.length - 1]).toBe('done');
    const err = events.find((e) => e.type === 'error');
    expect(err && 'message' in err && err.message).toMatch(/not found in pi-ai's openai-codex registry/);
  });

  it('runtime identity fields match the contract', () => {
    const runtime = new CodexRuntime();
    expect(runtime.id).toBe('codex');
    expect(runtime.providerId).toBe('openai-codex');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Successful stream — end-to-end with a mocked pi-ai stream.
//
// Per design review (Codex bot catch on PR E2): the auth/model-gating
// tests don't exercise the most likely-to-regress code path: text_delta
// accumulation, final message capture (responseId + usage), sidecar
// persistence, and event ordering. This test stages a complete fake
// stream and asserts the full event sequence + side effect.
// ─────────────────────────────────────────────────────────────────────────

describe('CodexRuntime.runTurn — successful stream end-to-end', () => {
  it('emits start → text_delta(s) → session → usage → done(stop) and persists the session id', async () => {
    codexAuthMock.loggedIn = true;

    const fakeFinal = fakeAssistantMessage({
      responseId: 'resp_abc123',
      usage: {
        input: 42, output: 17, cacheRead: 10, cacheWrite: 0, totalTokens: 59,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
      },
      stopReason: 'stop',
    });

    streamFactory.value = () => makeFakeStream(
      [
        { type: 'start', partial: fakeAssistantMessage() },
        { type: 'text_delta', contentIndex: 0, delta: 'Hello ', partial: fakeAssistantMessage() },
        { type: 'text_delta', contentIndex: 0, delta: 'world', partial: fakeAssistantMessage() },
      ],
      fakeFinal,
    );

    const runtime = new CodexRuntime();
    const events = await collectEvents(runtime.runTurn(fakeTurnInput()));

    // First event must be `start` per the runtime contract.
    expect(events[0]).toEqual({
      type: 'start',
      runtimeId: 'codex',
      modelRef: expect.objectContaining({ canonical: 'openai-codex/gpt-5.5' }),
    });

    // Text deltas pass through as true deltas (no cumulative subtraction).
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas).toEqual([
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'world' },
    ]);

    // After the stream drains, `stream.result()` provides the final
    // message — runtime emits session + usage + done from that.
    const sessionEvt = events.find((e) => e.type === 'session');
    expect(sessionEvt).toEqual({ type: 'session', sessionId: 'resp_abc123' });

    const usageEvt = events.find((e) => e.type === 'usage');
    expect(usageEvt).toEqual({
      type: 'usage',
      input: 42,
      output: 17,
      cacheRead: 10,
      cacheWrite: 0,
      cost: 0.001,
    });

    // Done must be the LAST event and must carry the stop finish reason.
    expect(events[events.length - 1]).toEqual({ type: 'done', finishReason: 'stop' });

    // Sidecar persistence — runtime calls persistSessionId which writes
    // to thread_provider_sessions via setProviderSession.
    expect(setProviderSessionSpy).toHaveBeenCalledWith({
      threadId: 'thread-1',
      runtimeId: 'codex',
      provider: 'openai-codex',
      modelRef: 'openai-codex/gpt-5.5',
      sessionId: 'resp_abc123',
    });
  });

  it('skips session/usage emit when the final message has no responseId (degraded provider)', async () => {
    // Defensive case: pi-ai's contract has responseId as optional. If
    // it's missing, we shouldn't pretend to capture a session id (would
    // pollute the sidecar with an empty string).
    codexAuthMock.loggedIn = true;

    const fakeFinal = fakeAssistantMessage({
      responseId: undefined,
      stopReason: 'stop',
    });
    streamFactory.value = () => makeFakeStream(
      [{ type: 'text_delta', contentIndex: 0, delta: 'ok', partial: fakeAssistantMessage() }],
      fakeFinal,
    );

    const runtime = new CodexRuntime();
    const events = await collectEvents(runtime.runTurn(fakeTurnInput()));

    expect(events.find((e) => e.type === 'session')).toBeUndefined();
    expect(setProviderSessionSpy).not.toHaveBeenCalled();
    // Still emits usage + done.
    expect(events.find((e) => e.type === 'usage')).toBeDefined();
    expect(events[events.length - 1]).toEqual({ type: 'done', finishReason: 'stop' });
  });
});
