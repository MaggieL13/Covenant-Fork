import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────
// Mocks (same shape as codex.test.ts but with a QUEUE-based stream
// factory — each iteration of the tool loop pops the next fake stream
// from `streamQueue`, so a single test can drive multiple iterations).
// ─────────────────────────────────────────────────────────────────────────

const codexAuthMock = { loggedIn: true };
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

vi.mock('../db/provider-sessions.js', () => ({
  getProviderSession: vi.fn(() => null),
  setProviderSession: vi.fn(),
}));

type FakeStream = AsyncIterable<unknown> & { result(): Promise<unknown> };
const streamQueue: FakeStream[] = [];
const streamCalls: Array<{ messages: unknown[]; tools: unknown }> = [];

vi.mock('@earendil-works/pi-ai/openai-codex-responses', () => ({
  streamOpenAICodexResponses: (_model: unknown, ctx: { messages: unknown[]; tools: unknown }) => {
    streamCalls.push({ messages: [...ctx.messages], tools: ctx.tools });
    const next = streamQueue.shift();
    if (!next) {
      throw new Error('streamQueue is empty — test forgot to enqueue a stream for this iteration');
    }
    return next;
  },
}));

vi.mock('@earendil-works/pi-ai', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-ai')>('@earendil-works/pi-ai');
  return {
    ...actual,
    getModel: (provider: string, modelId: string) => {
      if (provider === 'openai-codex' && modelId === 'gpt-5.5') {
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

import { CodexRuntime } from './codex.js';
import { ToolRegistry, type CovenantTool } from '../tools/registry.js';
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from '@earendil-works/pi-ai';
import type { AgentRuntimeEvent, AgentTurnInput, NormalizedMessage } from './types.js';
import { normalizeModelRef } from '@resonant/shared';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function fakeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
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

function toolCallBlock(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { type: 'toolCall', id, name, arguments: args };
}

function enqueueStream(events: AssistantMessageEvent[], finalMessage: AssistantMessage): void {
  streamQueue.push({
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    result: async () => finalMessage,
  });
}

async function collectEvents(iter: AsyncIterable<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const out: AgentRuntimeEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

function fakeTurnInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    thread: { id: 'thread-1', name: 't', type: 'daily', current_session_id: null },
    tier: 'interactive',
    modelRef: normalizeModelRef('openai-codex/gpt-5.5'),
    platform: 'web',
    isAutonomous: false,
    orientation: '[Context]\n[/Context]',
    systemPrompt: { kind: 'text', value: 'test' },
    messages: [
      { role: 'user', content: 'help me', createdAt: new Date().toISOString() },
    ] as NormalizedMessage[],
    cwd: '/tmp/scope',
    ...overrides,
  };
}

let registry: ToolRegistry;
let runtime: CodexRuntime;

beforeEach(() => {
  streamQueue.length = 0;
  streamCalls.length = 0;
  registry = new ToolRegistry();
  runtime = new CodexRuntime({ registry });
});

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('CodexRuntime — tool loop driver (PR E3b/4)', () => {
  it('single tool call → execute → next iteration without tools → done', async () => {
    const execCalls: Array<{ name: string; args: unknown }> = [];
    const tool: CovenantTool = {
      name: 'read_file',
      description: 'read',
      parameters: { type: 'object', additionalProperties: true },
      execute: async (args) => {
        execCalls.push({ name: 'read_file', args });
        return 'file contents go here';
      },
    };
    registry.register(tool);

    // Iter 0: model asks for read_file
    enqueueStream(
      [],
      fakeAssistantMessage({
        content: [toolCallBlock('call-1', 'read_file', { path: 'foo.ts' })],
        stopReason: 'toolUse',
      }),
    );
    // Iter 1: model finishes after seeing the tool result
    enqueueStream([], fakeAssistantMessage({ stopReason: 'stop' }));

    const events = await collectEvents(runtime.runTurn(fakeTurnInput()));

    // tool was actually executed with the model-provided args
    expect(execCalls).toEqual([{ name: 'read_file', args: { path: 'foo.ts' } }]);

    // canonical event sequence
    const types = events.map((e) => e.type);
    expect(types).toContain('start');
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_result');
    expect(types[types.length - 1]).toBe('done');

    // exactly TWO stream calls — one per iteration
    expect(streamCalls).toHaveLength(2);
    // second stream call carries the toolResult message appended after dispatch
    const secondTurnMessages = streamCalls[1].messages;
    expect(secondTurnMessages.length).toBeGreaterThan(streamCalls[0].messages.length);
    // shape check: a toolResult entry exists for call-1
    expect(secondTurnMessages.some((m: any) => m.role === 'toolResult' && m.toolCallId === 'call-1')).toBe(true);
  });

  it('parallel tool calls in one iteration all execute', async () => {
    const tool: CovenantTool = {
      name: 'work',
      description: 'work',
      parameters: { type: 'object', additionalProperties: true },
      execute: async (args) => `output for ${JSON.stringify(args)}`,
    };
    registry.register(tool);

    enqueueStream(
      [],
      fakeAssistantMessage({
        content: [
          toolCallBlock('c1', 'work', { id: 1 }),
          toolCallBlock('c2', 'work', { id: 2 }),
          toolCallBlock('c3', 'work', { id: 3 }),
        ],
        stopReason: 'toolUse',
      }),
    );
    enqueueStream([], fakeAssistantMessage({ stopReason: 'stop' }));

    const events = await collectEvents(runtime.runTurn(fakeTurnInput()));
    const toolStarts = events.filter((e) => e.type === 'tool_start');
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolStarts).toHaveLength(3);
    expect(toolResults).toHaveLength(3);
  });

  it('chunks calls over MAX_PARALLEL into waves but executes ALL of them (no dropped fingers)', async () => {
    // PR E3b/4 review (Codex P1 catch): the original
    // slice(0, MAX_PARALLEL) approach dropped calls 6+ silently
    // — but the assistant message in piMessages still listed all
    // 7 toolCallIds, so the next pi-ai request would 400 with
    // "No tool call found for function call output with call_id ..."
    // (every toolCall in the prior turn must have a matching
    // toolResult before the next request). Fix: chunk in waves of
    // MAX_PARALLEL and execute all calls before re-asking the model.
    let executed = 0;
    const tool: CovenantTool = {
      name: 'work',
      description: 'work',
      parameters: { type: 'object', additionalProperties: true },
      execute: async () => {
        executed++;
        return 'ok';
      },
    };
    registry.register(tool);

    enqueueStream(
      [],
      fakeAssistantMessage({
        content: [
          toolCallBlock('c1', 'work'),
          toolCallBlock('c2', 'work'),
          toolCallBlock('c3', 'work'),
          toolCallBlock('c4', 'work'),
          toolCallBlock('c5', 'work'),
          toolCallBlock('c6', 'work'), // ← would have been dropped pre-fix
          toolCallBlock('c7', 'work'),
        ],
        stopReason: 'toolUse',
      }),
    );
    enqueueStream([], fakeAssistantMessage({ stopReason: 'stop' }));

    const events = await collectEvents(runtime.runTurn(fakeTurnInput()));

    // All 7 tools actually ran.
    expect(executed).toBe(7);
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(7);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(7);

    // Protocol invariant: every toolCallId from the prior assistant
    // message has a matching toolResult in the NEXT stream call's
    // piMessages. Without this, OpenAI 400s.
    expect(streamCalls).toHaveLength(2);
    const nextTurnMessages = streamCalls[1].messages as Array<{
      role: string;
      toolCallId?: string;
    }>;
    const toolResults = nextTurnMessages.filter((m) => m.role === 'toolResult');
    expect(toolResults).toHaveLength(7);
    const resultIds = new Set(toolResults.map((m) => m.toolCallId));
    expect(resultIds).toEqual(new Set(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']));
  });

  it('unknown tool name surfaces as structured tool_result error, loop continues', async () => {
    enqueueStream(
      [],
      fakeAssistantMessage({
        content: [toolCallBlock('c1', 'does_not_exist')],
        stopReason: 'toolUse',
      }),
    );
    enqueueStream([], fakeAssistantMessage({ stopReason: 'stop' }));

    const events = await collectEvents(runtime.runTurn(fakeTurnInput()));
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.isError).toBe(true);
      const parsed = JSON.parse(String(toolResult.output));
      expect(parsed.error.code).toBe('unknown_tool');
    }
    // Loop continued past the bad call.
    expect(events[events.length - 1].type).toBe('done');
  });

  it('tool throwing produces structured error result and loop continues', async () => {
    registry.register({
      name: 'flaky',
      description: 'flaky',
      parameters: { type: 'object', additionalProperties: true },
      execute: async () => {
        throw new Error('boom');
      },
    });

    enqueueStream(
      [],
      fakeAssistantMessage({
        content: [toolCallBlock('c1', 'flaky')],
        stopReason: 'toolUse',
      }),
    );
    enqueueStream([], fakeAssistantMessage({ stopReason: 'stop' }));

    const events = await collectEvents(runtime.runTurn(fakeTurnInput()));
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.isError).toBe(true);
      const parsed = JSON.parse(String(toolResult.output));
      expect(parsed.error.code).toBe('tool_threw');
      expect(parsed.error.message).toContain('boom');
    }
  });

  it('per-result truncation at the shared MAX_TOOL_OUTPUT_CHARS cap applies as safety net', async () => {
    // Tool returns 60KB without self-capping. Loop driver routes
    // through applyOutputBudget which guarantees the output length
    // is ≤ MAX_TOOL_OUTPUT_CHARS (50KB chars) exactly. (E3b/4 review
    // P2: the prior slice + suffix pattern overshot the cap by the
    // suffix length; applyOutputBudget keeps it strictly inside.)
    registry.register({
      name: 'fat',
      description: 'fat',
      parameters: { type: 'object', additionalProperties: true },
      execute: async () => 'x'.repeat(60 * 1024),
    });

    enqueueStream(
      [],
      fakeAssistantMessage({
        content: [toolCallBlock('c1', 'fat')],
        stopReason: 'toolUse',
      }),
    );
    enqueueStream([], fakeAssistantMessage({ stopReason: 'stop' }));

    const events = await collectEvents(runtime.runTurn(fakeTurnInput()));
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.type).toBe('tool_result');
    if (toolResult?.type === 'tool_result') {
      const outputStr = String(toolResult.output);
      expect(outputStr.length).toBeLessThanOrEqual(50_000);
      expect(outputStr).toContain('[tool output truncated');
    }
  });

  it('total-output budget exceeded → error + done(length)', async () => {
    // Tool returns ~50KB; with 5 calls in parallel that's ~250KB,
    // over the 200KB MAX_OUTPUT_BYTES.
    registry.register({
      name: 'big',
      description: 'big',
      parameters: { type: 'object', additionalProperties: true },
      execute: async () => 'y'.repeat(50 * 1024),
    });

    enqueueStream(
      [],
      fakeAssistantMessage({
        content: [
          toolCallBlock('c1', 'big'),
          toolCallBlock('c2', 'big'),
          toolCallBlock('c3', 'big'),
          toolCallBlock('c4', 'big'),
          toolCallBlock('c5', 'big'),
        ],
        stopReason: 'toolUse',
      }),
    );

    const events = await collectEvents(runtime.runTurn(fakeTurnInput()));
    // Last events should be error (budget) + done(length).
    const last = events[events.length - 1];
    expect(last.type).toBe('done');
    if (last.type === 'done') expect(last.finishReason).toBe('length');
    const errEvent = events.find(
      (e) => e.type === 'error' && /budget exceeded/.test(e.message),
    );
    expect(errEvent).toBeDefined();
  });

  it('budget tripped mid-chunk emits synthetic skipped results for remaining calls (protocol invariant)', async () => {
    // PR E3b/4 review P1 follow-up: when the budget trips between
    // chunks, the remaining calls would otherwise have no
    // toolResult entries — which would 400 the (unreachable, but
    // still protocol-correct) next pi-ai request. Verify each call
    // in `final.content` gets a matching result either real or
    // synthesized `skipped_budget`.
    registry.register({
      name: 'big',
      description: 'big',
      parameters: { type: 'object', additionalProperties: true },
      execute: async () => 'z'.repeat(50 * 1024),
    });

    // 10 calls. Chunk 1 (5 calls × 50KB = 250KB) trips the 200KB
    // budget. Remaining 5 should be synthesized as skipped.
    const calls: ReturnType<typeof toolCallBlock>[] = [];
    for (let i = 1; i <= 10; i++) calls.push(toolCallBlock(`c${i}`, 'big'));
    enqueueStream(
      [],
      fakeAssistantMessage({ content: calls, stopReason: 'toolUse' }),
    );

    const events = await collectEvents(runtime.runTurn(fakeTurnInput()));

    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults).toHaveLength(10);

    // Calls 1-5 should be the real big outputs; 6-10 should be
    // structured `skipped_budget` errors.
    const skipped = toolResults
      .filter((e) => {
        if (e.type !== 'tool_result') return false;
        const parsed = (() => {
          try { return JSON.parse(String(e.output)); } catch { return null; }
        })();
        return parsed?.error?.code === 'skipped_budget';
      });
    expect(skipped.length).toBeGreaterThanOrEqual(5);

    // Last events: error + done(length).
    const last = events[events.length - 1];
    expect(last.type).toBe('done');
    if (last.type === 'done') expect(last.finishReason).toBe('length');
  });

  it('iteration ceiling at MAX_ITER=20 terminates with ceiling error', async () => {
    registry.register({
      name: 'persistent',
      description: 'persistent',
      parameters: { type: 'object', additionalProperties: true },
      execute: async () => 'tiny',
    });

    // Enqueue 20 streams that ALL request a tool call. The 21st iter
    // wouldn't run because we cap at MAX_ITER.
    for (let i = 0; i < 20; i++) {
      enqueueStream(
        [],
        fakeAssistantMessage({
          content: [toolCallBlock(`c${i}`, 'persistent')],
          stopReason: 'toolUse',
        }),
      );
    }

    const events = await collectEvents(runtime.runTurn(fakeTurnInput()));
    const ceilingErr = events.find(
      (e) => e.type === 'error' && /tool-loop ceiling/.test(e.message),
    );
    expect(ceilingErr).toBeDefined();
    const last = events[events.length - 1];
    expect(last.type).toBe('done');
    if (last.type === 'done') expect(last.finishReason).toBe('length');
    // Exactly 20 stream calls (one per iteration up to the cap).
    expect(streamCalls).toHaveLength(20);
  });

  it('stuck detection: empty turn (no text, no tools) after a tool iteration emits an error', async () => {
    registry.register({
      name: 'work',
      description: 'work',
      parameters: { type: 'object', additionalProperties: true },
      execute: async () => 'output',
    });

    // Iter 0: tool call
    enqueueStream(
      [],
      fakeAssistantMessage({
        content: [toolCallBlock('c1', 'work')],
        stopReason: 'toolUse',
      }),
    );
    // Iter 1: empty turn — content has no text-producing events, no tool calls.
    // We can't easily fake "no text events" via fake streams (the stream
    // iter is empty), but `producedText` defaults to false. So iter 1 with
    // empty content array AND empty event stream triggers stuck detection.
    enqueueStream(
      [],
      fakeAssistantMessage({ content: [], stopReason: 'stop' }),
    );

    const events = await collectEvents(runtime.runTurn(fakeTurnInput()));
    const stuckErr = events.find(
      (e) => e.type === 'error' && /empty turn/.test(e.message),
    );
    expect(stuckErr).toBeDefined();
    // Still terminates cleanly with done(stop) — stuck detection
    // surfaces an error but doesn't change the finish reason.
    const last = events[events.length - 1];
    expect(last.type).toBe('done');
  });

  it('chat-only turn (no tool calls) takes exactly one iteration', async () => {
    enqueueStream([], fakeAssistantMessage({ stopReason: 'stop' }));
    const events = await collectEvents(runtime.runTurn(fakeTurnInput()));
    expect(streamCalls).toHaveLength(1);
    // No tool events at all.
    expect(events.find((e) => e.type === 'tool_start')).toBeUndefined();
    expect(events.find((e) => e.type === 'tool_result')).toBeUndefined();
    // Done with stop.
    const last = events[events.length - 1];
    expect(last.type).toBe('done');
    if (last.type === 'done') expect(last.finishReason).toBe('stop');
  });

  it('passes registry-formatted tools into pi-ai context when tools are registered', async () => {
    registry.register({
      name: 'read_file',
      description: 'read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      execute: async () => 'ok',
    });

    enqueueStream([], fakeAssistantMessage({ stopReason: 'stop' }));
    await collectEvents(runtime.runTurn(fakeTurnInput()));

    expect(streamCalls).toHaveLength(1);
    const tools = streamCalls[0].tools as Array<{ name: string }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('read_file');
  });

  it('passes tools=undefined when registry is empty (no tool advertisement)', async () => {
    enqueueStream([], fakeAssistantMessage({ stopReason: 'stop' }));
    await collectEvents(runtime.runTurn(fakeTurnInput()));
    expect(streamCalls[0].tools).toBeUndefined();
  });
});
