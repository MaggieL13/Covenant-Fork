/**
 * `CodexRuntime` — the OpenAI Codex (ChatGPT OAuth) implementation of
 * `AgentRuntime`. Wraps pi-ai's `streamOpenAICodexResponses`.
 *
 * ## Status: PR E2 — full implementation
 *
 * PR E0 added Codex preview manifest entries; PR E1 added the OAuth
 * login flow + Provider Health UI. This PR lands the actual runtime
 * that turns a configured Codex tier into a streamed response.
 *
 * ## Statelessness, deliberately
 *
 * pi-ai's `openai-codex-responses` provider sends `store: false` and the
 * full `input: messages` array on every request — it does NOT chain via
 * `previous_response_id`. That means a Codex "session" in our world is
 * really just the message history we rebuild from the `messages` DB
 * table each turn.
 *
 * We still write the response's `responseId` into
 * `thread_provider_sessions` for two reasons:
 *   1) Prompt-cache affinity hints to OpenAI's edge (`prompt_cache_key`
 *      in the pi-ai body — uses our `sessionId` option, which we set to
 *      the prior responseId).
 *   2) Audit / debug ("what was the last Codex response id for this
 *      thread?") in case OpenAI later exposes inspection tooling.
 *
 * Nothing in our code treats it like a resumable Claude session.
 *
 * ## No tools in E2
 *
 * The manifest declares `tools: false` for Codex preview models, so we
 * don't translate `toolcall_*` events from pi-ai. If the upstream stream
 * ever emits one (it shouldn't with no tools sent), we surface it as a
 * provider_diagnostic and continue rather than crashing.
 *
 * ## Auth
 *
 * `getCodexAccessToken()` from `services/auth/codex-oauth.ts` is the
 * only auth touchpoint. It auto-refreshes when within 5min of expiry
 * and throws `CodexAuthRequiredError` if there are no credentials OR
 * the refresh failed. We translate that throw into an `auth_required`
 * event + clean `done` so AgentService can persist a friendly message
 * instead of bubbling a stack trace.
 */

import { streamOpenAICodexResponses } from '@earendil-works/pi-ai/openai-codex-responses';
import {
  getModel,
  type Message as PiMessage,
  type AssistantMessageEvent,
  type AssistantMessage,
  type StopReason as PiStopReason,
  type Model,
  type ToolCall,
} from '@earendil-works/pi-ai';
import type { ModelRef, ProviderId, RuntimeId } from '@resonant/shared';
import {
  getCodexAccessToken,
  CodexAuthRequiredError,
} from '../auth/codex-oauth.js';
import {
  getProviderSession,
  setProviderSession,
} from '../db/provider-sessions.js';
import { toolRegistry } from '../tools/registry.js';
import {
  applyOutputBudget,
  MAX_TOOL_OUTPUT_CHARS,
} from '../tools/output-budget.js';
import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentTurnInput,
  ThreadHandle,
  NormalizedMessage,
} from './types.js';

/**
 * Map our internal ThinkingEffort vocabulary onto pi-ai's
 * `reasoningEffort` enum. The Codex providers accept these levels for
 * o-series and reasoning-capable GPT-5.x models; non-reasoning models
 * silently ignore the field. We map 'max' → 'xhigh' (pi-ai's
 * highest tier) and 'auto' → undefined (let pi-ai pick its default).
 */
function mapEffortForCodex(
  effort?: string,
): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  switch (effort) {
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'xhigh';
    case 'max': return 'xhigh';
    case 'minimal': return 'minimal';
    case 'none': return 'none';
    case 'auto':
    case undefined:
    case '':
      return undefined;
    default:
      return undefined;
  }
}

/** Map pi-ai stop reason to our finish reason vocabulary. */
function mapStopReasonForDone(reason: PiStopReason): 'stop' | 'length' | 'tool_calls' | 'aborted' | 'error' {
  switch (reason) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'toolUse': return 'tool_calls';
    case 'aborted': return 'aborted';
    case 'error': return 'error';
  }
}

/**
 * Convert our NormalizedMessage to pi-ai's UserMessage / AssistantMessage
 * shapes. `system` role is folded into `systemPrompt` at the caller —
 * we only emit user/assistant rows here. Each provider has its own way
 * of representing system roles inside the message list (pi-ai's Codex
 * provider takes a top-level `systemPrompt`, not in-band system
 * messages), which is why we filter rather than translate.
 */
export function toPiMessages(messages: NormalizedMessage[]): PiMessage[] {
  const out: PiMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;  // folded into systemPrompt
    if (m.role === 'user') {
      // PR E3a — vision: when a user message carries image bytes, emit
      // pi-ai's mixed-content shape `[{type:'text', text}, ...images]`
      // instead of the plain-string shorthand. pi-ai's
      // openai-codex-responses provider converts each `ImageContent`
      // entry into OpenAI's `input_image` wire shape internally — we
      // never touch the raw OpenAI vocabulary. Text leads the array so
      // the model sees the caption before each attached image.
      if (m.images && m.images.length > 0) {
        const content: Array<
          | { type: 'text'; text: string }
          | { type: 'image'; data: string; mimeType: string }
        > = [{ type: 'text', text: m.content }];
        for (const img of m.images) {
          content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
        }
        out.push({
          role: 'user',
          content,
          timestamp: Date.parse(m.createdAt) || Date.now(),
        });
        continue;
      }
      out.push({
        role: 'user',
        content: m.content,
        timestamp: Date.parse(m.createdAt) || Date.now(),
      });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        // Minimal AssistantMessage shape — pi-ai's openai-codex-responses
        // provider only reads `role`/`content`/`timestamp` from history;
        // the other fields exist for the FINAL message produced by the
        // current turn, not for replayed history.
        content: [{ type: 'text', text: m.content }],
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        model: 'replayed',
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.parse(m.createdAt) || Date.now(),
      });
    }
  }
  return out;
}

/**
 * Resolve a manifest model id (e.g. `gpt-5.1`) to pi-ai's full Model
 * object via its `openai-codex` registry. Throws if the id isn't in
 * pi-ai's registry — the manifest and pi-ai must stay in sync.
 *
 * `as never` casts cope with pi-ai's exact-string-id type narrowing
 * (it expects a literal-string union, we pass a runtime string).
 * Runtime mismatch (unknown id) throws cleanly inside pi-ai.
 */
function resolveCodexPiModel(modelId: string): Model<'openai-codex-responses'> {
  const model = getModel('openai-codex' as never, modelId as never) as unknown as
    | Model<'openai-codex-responses'>
    | undefined;
  if (!model) {
    throw new Error(
      `Model "${modelId}" is not registered in pi-ai's openai-codex provider`,
    );
  }
  return model;
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 120)}...` : compact;
}

function contentBlockCount(message: { content?: unknown } | undefined): number | undefined {
  if (!message || !Array.isArray(message.content)) return undefined;
  return message.content.length;
}

type CodexDebugDeltaBatch = {
  deltaType: 'text_delta' | 'thinking_delta';
  contentIndex: number;
  chunks: number;
  chars: number;
  partialContentBlocks?: number;
  partialResponseIdPresent?: boolean;
};

/**
 * Sanitized pi-ai event summary for local Codex debugging.
 *
 * This is intentionally not the normalized AgentRuntimeEvent shape. It is a
 * native-stream "black box recorder" used when debugging provider drift:
 * event ordering, content indexes, response id presence, usage presence, etc.
 * By default it logs sizes only, not model text/reasoning content.
 */
export function summarizeCodexPiEventForDebug(
  event: AssistantMessageEvent,
  includeContent = false,
): Record<string, unknown> {
  const summary: Record<string, unknown> = { type: event.type };

  if ('contentIndex' in event) {
    summary.contentIndex = event.contentIndex;
  }
  if ('reason' in event) {
    summary.reason = event.reason;
  }
  if ('delta' in event && typeof event.delta === 'string') {
    summary.deltaChars = event.delta.length;
    if (includeContent) summary.deltaPreview = preview(event.delta);
  }
  if ('content' in event && typeof event.content === 'string') {
    summary.contentChars = event.content.length;
    if (includeContent) summary.contentPreview = preview(event.content);
  }
  if ('partial' in event) {
    summary.partialContentBlocks = contentBlockCount(event.partial);
    summary.partialResponseIdPresent = Boolean(event.partial.responseId);
  }
  if (event.type === 'done') {
    summary.messageContentBlocks = contentBlockCount(event.message);
    summary.messageResponseIdPresent = Boolean(event.message.responseId);
    summary.stopReason = event.message.stopReason;
    summary.usagePresent = Boolean(event.message.usage);
  }
  if (event.type === 'error') {
    summary.errorMessageChars = event.error.errorMessage?.length ?? 0;
    if (includeContent && event.error.errorMessage) {
      summary.errorMessagePreview = preview(event.error.errorMessage);
    }
  }

  return summary;
}

function flushCodexPiEventDebugBatch(batch: CodexDebugDeltaBatch | null): void {
  if (!batch || !envFlag('CODEX_EVENT_LOG')) return;
  console.log('[CodexRuntime:event]', {
    type: `${batch.deltaType}_batch`,
    contentIndex: batch.contentIndex,
    chunks: batch.chunks,
    chars: batch.chars,
    partialContentBlocks: batch.partialContentBlocks,
    partialResponseIdPresent: batch.partialResponseIdPresent,
  });
}

function logCodexPiEvent(
  event: AssistantMessageEvent,
  deltaBatch: CodexDebugDeltaBatch | null,
): CodexDebugDeltaBatch | null {
  if (!envFlag('CODEX_EVENT_LOG')) return null;

  if (event.type === 'text_delta' || event.type === 'thinking_delta') {
    if (
      deltaBatch
      && deltaBatch.deltaType === event.type
      && deltaBatch.contentIndex === event.contentIndex
    ) {
      return {
        ...deltaBatch,
        chunks: deltaBatch.chunks + 1,
        chars: deltaBatch.chars + event.delta.length,
        partialContentBlocks: contentBlockCount(event.partial),
        partialResponseIdPresent: Boolean(event.partial.responseId),
      };
    }

    flushCodexPiEventDebugBatch(deltaBatch);
    return {
      deltaType: event.type,
      contentIndex: event.contentIndex,
      chunks: 1,
      chars: event.delta.length,
      partialContentBlocks: contentBlockCount(event.partial),
      partialResponseIdPresent: Boolean(event.partial.responseId),
    };
  }

  flushCodexPiEventDebugBatch(deltaBatch);
  const includeContent = envFlag('CODEX_EVENT_LOG_CONTENT');
  console.log('[CodexRuntime:event]', summarizeCodexPiEventForDebug(event, includeContent));
  return null;
}

function logCodexFinalMessage(final: {
  responseId?: string;
  stopReason?: unknown;
  usage?: unknown;
  content?: unknown;
}): void {
  if (!envFlag('CODEX_EVENT_LOG')) return;
  console.log('[CodexRuntime:final]', {
    responseIdPresent: Boolean(final.responseId),
    stopReason: final.stopReason,
    usagePresent: Boolean(final.usage),
    contentBlocks: contentBlockCount(final),
  });
}

export class CodexRuntime implements AgentRuntime {
  readonly id: RuntimeId = 'codex';
  readonly providerId: ProviderId = 'openai-codex';

  /**
   * Single in-flight stream per runtime singleton — used by `abort()`.
   * If a turn fires before the previous one's stream completed, the
   * AbortController is replaced; the previous turn's iteration already
   * has its own controller closure, so abort() only affects the most
   * recent turn (matching ClaudeAgentRuntime semantics).
   */
  private activeAbortController: AbortController | null = null;

  /**
   * Tool registry the loop driver consults for available tools +
   * dispatch. Defaults to the module-level `toolRegistry` singleton in
   * production; tests inject their own `ToolRegistry` instance for
   * isolation (matching the DI pattern used for sessions / onNativeEvent
   * in the lab branch).
   */
  private readonly registry: import('../tools/registry.js').ToolRegistry;

  constructor(opts: {
    registry?: import('../tools/registry.js').ToolRegistry;
  } = {}) {
    this.registry = opts.registry ?? toolRegistry;
  }

  resumeSessionId(thread: ThreadHandle, modelRef: ModelRef): string | undefined {
    const row = getProviderSession({
      threadId: thread.id,
      runtimeId: this.id,
      provider: this.providerId,
      modelRef: modelRef.canonical,
    });
    return row?.session_id ?? undefined;
  }

  persistSessionId(thread: ThreadHandle, modelRef: ModelRef, sessionId: string): void {
    setProviderSession({
      threadId: thread.id,
      runtimeId: this.id,
      provider: this.providerId,
      modelRef: modelRef.canonical,
      sessionId,
    });
  }

  abort(): void {
    this.activeAbortController?.abort();
  }

  async *runTurn(input: AgentTurnInput): AsyncIterable<AgentRuntimeEvent> {
    // Always emit start first per the runtime contract.
    yield { type: 'start', runtimeId: this.id, modelRef: input.modelRef };

    // Auth gate — translate CodexAuthRequiredError into an auth_required
    // event so AgentService can render a friendly chat message instead of
    // surfacing the raw error. No api call needed yet.
    let accessToken: string;
    try {
      accessToken = await getCodexAccessToken();
    } catch (err) {
      if (err instanceof CodexAuthRequiredError) {
        yield {
          type: 'auth_required',
          provider: this.providerId,
          message: err.message,
        };
        yield { type: 'done', finishReason: 'error' };
        return;
      }
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        recoverable: false,
      };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    // Resolve pi-ai's Model<'openai-codex-responses'>. If the manifest
    // and pi-ai registry drift apart (e.g. operator picked a model id
    // pi-ai doesn't know), surface as a clean error rather than crash.
    let piModel: Model<'openai-codex-responses'>;
    try {
      piModel = resolveCodexPiModel(input.modelRef.model);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        type: 'error',
        message: `Codex model "${input.modelRef.model}" not found in pi-ai's openai-codex registry: ${msg}`,
        recoverable: true,
      };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    // Build pi-ai's Context. The orientation block already lives in
    // input.systemPrompt (the dispatcher folds it in for Codex turns).
    // The handoff packet, when present, is rendered as a system note
    // prepended to the system prompt — Codex doesn't have a native
    // handoff slot.
    const systemText = input.systemPrompt.kind === 'text'
      ? input.systemPrompt.value
      : (input.systemPrompt.append || '');

    // Handoff packet — when a (runtime, provider, model_ref) combo has
    // no prior session for this thread AND the thread has prior
    // assistant turns, the dispatcher builds a memory-tier summary
    // packet so the new combo gets cross-provider continuity instead
    // of starting blind. `fromModelRef` is best-effort (from the
    // most-recent sidecar row) and may be undefined on legacy threads.
    const handoffNote = input.handoff
      ? (() => {
          const from = input.handoff.fromModelRef
            ? `from ${input.handoff.fromModelRef} `
            : '';
          return `[Cross-provider handoff ${from}— summary of prior conversation]\n${input.handoff.summary}\n[/Cross-provider handoff]\n\n`;
        })()
      : '';

    // Hook the runtime's abort controller to the input's abort signal.
    // Both can fire — `input.abortSignal` is wired to the per-turn
    // timeout + the user's stop button; `this.activeAbortController` is
    // for the runtime-level abort() method. Combined into a single
    // signal handed to pi-ai.
    this.activeAbortController = new AbortController();
    const runtimeController = this.activeAbortController;
    const inputAbortHandler = () => runtimeController.abort();
    input.abortSignal?.addEventListener('abort', inputAbortHandler, { once: true });

    // Reasoning effort (only used by reasoning-capable models; pi-ai
    // ignores it on non-reasoning models).
    const reasoningEffort = mapEffortForCodex(input.thinkingEffort);

    // Resume "session id" — actually the prior responseId, used for
    // prompt-cache affinity. Not for actual resume (Codex provider is
    // stateless in pi-ai).
    const priorResponseId = input.sessionId
      ?? this.resumeSessionId(input.thread, input.modelRef);

    // PR E3b — tool-calling loop state. The loop iterates per-turn
    // refresh of pi-ai's `messages` array. Each iteration appends the
    // assistant's reply + any tool results so the next request shows
    // the model what it just said and the tool outputs it requested.
    const piMessages: PiMessage[] = toPiMessages(input.messages);
    const toolList = this.registry.toCodexFormat();
    const hasTools = toolList.length > 0;
    const fullSystemPrompt = handoffNote + systemText;
    const toolCtx = { scopeRoot: input.cwd ?? '.', abortSignal: runtimeController.signal };

    // Safety caps for the loop. Numbers per the spec §4 (PR E3b/4).
    const MAX_ITER = 20;
    const MAX_PARALLEL = 5;
    const MAX_OUTPUT_BYTES = 200 * 1024;
    // Per-result cap lives in `output-budget.ts` as
    // MAX_TOOL_OUTPUT_CHARS (50_000), shared with the built-in
    // tools' self-cap so the same number bounds both surfaces.
    let iteration = 0;
    let totalOutputBytes = 0;

    try {
      while (iteration < MAX_ITER) {
        console.log(
          `[CodexRuntime] turn ${iteration === 0 ? 'start' : `iter ${iteration}`}: ` +
          `model=${input.modelRef.model}, messages=${piMessages.length}, ` +
          `effort=${reasoningEffort ?? 'default'}, ` +
          `cacheKey=${priorResponseId ?? 'fresh'}, ` +
          `tools=${hasTools ? toolList.length : 0}`,
        );

        // Kick off the per-iteration stream. pi-ai's StreamFunction
        // returns an AssistantMessageEventStream synchronously;
        // iteration awaits each event. Errors during request setup
        // throw synchronously; errors mid-stream surface inside the
        // stream's done event.
        let stream;
        try {
          stream = streamOpenAICodexResponses(piModel, {
            systemPrompt: fullSystemPrompt,
            messages: piMessages,
            tools: hasTools ? toolList : undefined,
          }, {
            apiKey: accessToken,
            signal: runtimeController.signal,
            sessionId: priorResponseId,
            reasoningEffort,
            reasoningSummary: 'auto',
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/401|unauthor/i.test(msg)) {
            yield {
              type: 'auth_required',
              provider: this.providerId,
              message: `Codex auth rejected: ${msg}. Log in again via Settings.`,
            };
          } else {
            yield { type: 'error', message: msg, recoverable: false };
          }
          yield { type: 'done', finishReason: 'error' };
          return;
        }

        // Stream consumer — same per-iteration logic as the pre-E3b
        // chat-only path. text_delta passes through; thinking_* gets
        // buffered into one consolidated chunk per block so the UI
        // sees one reasoning card per logical chunk rather than one
        // card per token. Tool events from the stream are silenced
        // (see translatePiEvent's toolcall_* case) — tool dispatch
        // sources from `final.content` after the stream drains.
        let thinkingBuffer: string | null = null;
        let producedText = false;
        let debugDeltaBatch: CodexDebugDeltaBatch | null = null;
        let final: AssistantMessage;
        try {
          for await (const event of stream) {
            debugDeltaBatch = logCodexPiEvent(event, debugDeltaBatch);

            if (event.type === 'text_delta') producedText = true;

            if (event.type === 'thinking_start') {
              thinkingBuffer = '';
              continue;
            }
            if (event.type === 'thinking_delta' && thinkingBuffer !== null) {
              thinkingBuffer += event.delta;
              continue;
            }
            if (event.type === 'thinking_end') {
              if (thinkingBuffer && thinkingBuffer.length > 0) {
                yield { type: 'thinking_delta', text: thinkingBuffer };
              }
              thinkingBuffer = null;
              continue;
            }

            const translated = translatePiEvent(event);
            if (translated) yield translated;
          }
          flushCodexPiEventDebugBatch(debugDeltaBatch);
          debugDeltaBatch = null;
          // Defensive flush: stream ended mid-thinking-block (rare).
          if (thinkingBuffer && thinkingBuffer.length > 0) {
            yield { type: 'thinking_delta', text: thinkingBuffer };
          }

          final = await stream.result();
          logCodexFinalMessage(final);
        } catch (err) {
          flushCodexPiEventDebugBatch(debugDeltaBatch);
          debugDeltaBatch = null;
          const msg = err instanceof Error ? err.message : String(err);
          if (runtimeController.signal.aborted) {
            yield { type: 'done', finishReason: 'aborted' };
            return;
          }
          if (/401|unauthor/i.test(msg)) {
            yield {
              type: 'auth_required',
              provider: this.providerId,
              message: `Codex auth expired during request: ${msg}. Log in again via Settings.`,
            };
            yield { type: 'done', finishReason: 'error' };
            return;
          }
          if (/429|rate.?limit/i.test(msg)) {
            const retryAfterMs = parseRetryAfter(msg);
            yield { type: 'rate_limit', retryAfterMs };
            yield { type: 'done', finishReason: 'error' };
            return;
          }
          yield { type: 'error', message: msg, recoverable: false };
          yield { type: 'done', finishReason: 'error' };
          return;
        }

        // SOURCE OF TRUTH for tool calls: the captured AssistantMessage's
        // ToolCall content blocks. The streaming toolcall_* events
        // were silenced above — those are best-effort UI surfaces and
        // can drop on transport hiccup. `final.content` is what pi-ai
        // committed as the model's output for this turn.
        const toolCalls: ToolCall[] = final.content.filter(
          (c): c is ToolCall => c.type === 'toolCall',
        );

        // Capture the assistant turn in the growing context so the next
        // iteration's request shows the model what it just said + what
        // tools it called.
        piMessages.push(final);

        if (toolCalls.length === 0) {
          // Normal completion path. Stuck-detection: an empty turn
          // (no text, no tools) AFTER a previous tool iteration is a
          // model bug — terminate rather than loop forever.
          //
          // Also check `final.content` for any non-empty text block
          // (E3b/4 review P3): the stream's `text_delta` events can
          // miss on transport hiccup or in test fixtures with an
          // empty event list but a populated final message. The
          // final message's text content is the authoritative truth
          // for "did the model actually say something this turn?".
          const producedTextFromFinal = final.content.some(
            (c) => c.type === 'text' && c.text.length > 0,
          );
          if (!producedText && !producedTextFromFinal && iteration > 0) {
            yield {
              type: 'error',
              message: 'Codex produced an empty turn during tool loop (no text, no tool calls). Terminating.',
              recoverable: true,
            };
          }
          if (final.responseId) {
            yield { type: 'session', sessionId: final.responseId };
            this.persistSessionId(input.thread, input.modelRef, final.responseId);
          }
          if (final.usage) {
            yield {
              type: 'usage',
              input: final.usage.input,
              output: final.usage.output,
              cacheRead: final.usage.cacheRead,
              cacheWrite: final.usage.cacheWrite,
              cost: final.usage.cost?.total,
            };
          }
          yield { type: 'done', finishReason: mapStopReasonForDone(final.stopReason) };
          return;
        }

        // Tool dispatch path. PR E3b/4 review (Codex P1 catch):
        // execute ALL requested tool calls in chunks of MAX_PARALLEL
        // — never drop calls. Dropping them would push an assistant
        // message containing N tool calls into piMessages but only
        // M<N matching ToolResult entries, which the next pi-ai
        // request rejects with "No tool call found for function call
        // output with call_id ..." (OpenAI protocol invariant: every
        // tool call must have a matching tool result before the next
        // turn). Chunking executes all N in waves of MAX_PARALLEL
        // bounded concurrency.
        const executions: Array<{ call: ToolCall; outputText: string; isError: boolean }> = [];
        let budgetTrippedDuringDispatch = false;

        for (let chunkStart = 0; chunkStart < toolCalls.length; chunkStart += MAX_PARALLEL) {
          const chunk = toolCalls.slice(chunkStart, chunkStart + MAX_PARALLEL);

          // (a) tool_start events — emitted from the outer loop
          //     BEFORE dispatch (async-gen yield rule: yield can't
          //     live inside Promise.all's map callback).
          for (const call of chunk) {
            yield {
              type: 'tool_start',
              id: call.id,
              name: call.name,
              input: call.arguments,
            };
          }

          // (b) Execute the chunk in parallel, collecting plain values.
          const chunkResults = await Promise.all(
            chunk.map(async (call) => {
              try {
                const tool = this.registry.get(call.name);
                if (!tool) {
                  return {
                    call,
                    outputText: JSON.stringify({
                      error: {
                        code: 'unknown_tool',
                        message: `Unknown tool: ${call.name}`,
                      },
                    }),
                    isError: true,
                  };
                }
                // Safety net via applyOutputBudget — tools already
                // self-cap (E3b/2), but defense-in-depth catches
                // any future tool that forgot to wrap. Using the
                // helper guarantees length ≤ MAX_TOOL_OUTPUT_CHARS
                // exactly (E3b/4 review P2: the old `slice + suffix`
                // pattern overshot by the suffix length).
                const raw = await tool.execute(call.arguments, toolCtx);
                const outputText = applyOutputBudget(raw, MAX_TOOL_OUTPUT_CHARS);
                return { call, outputText, isError: false };
              } catch (err) {
                return {
                  call,
                  outputText: JSON.stringify({
                    error: {
                      code: 'tool_threw',
                      message: err instanceof Error ? err.message : String(err),
                    },
                  }),
                  isError: true,
                };
              }
            }),
          );

          // (c) tool_result events for this chunk, after dispatch.
          for (const { call, outputText, isError } of chunkResults) {
            // Budget accounting uses actual UTF-8 byte length, NOT
            // JS string .length (which is UTF-16 code units). For
            // mostly-ASCII source-code output the two are equal,
            // but emoji / Japanese / accented text takes 2-4 UTF-8
            // bytes per char and would otherwise sneak past the
            // 200KB cap. (E3b/4 second-pass Codex review catch.)
            totalOutputBytes += Buffer.byteLength(outputText, 'utf8');
            yield {
              type: 'tool_result',
              id: call.id,
              name: call.name,
              output: outputText,
              isError,
            };
          }

          executions.push(...chunkResults);

          // Mid-chunk budget check. If the total trips while we still
          // have remaining chunks, mark and break — we'll synthesize
          // "skipped due to budget" results for the unexecuted calls
          // below so the next pi-ai request stays protocol-valid
          // (every toolCallId from final.content gets a matching
          // toolResult, even when the budget cut us short).
          if (totalOutputBytes > MAX_OUTPUT_BYTES) {
            budgetTrippedDuringDispatch = true;
            // Synthesize skipped-result entries for any remaining
            // calls beyond the current chunk so piMessages stays
            // protocol-valid even though we never executed them.
            const dispatchedIds = new Set(executions.map((e) => e.call.id));
            for (const call of toolCalls) {
              if (dispatchedIds.has(call.id)) continue;
              const skipped = {
                call,
                outputText: JSON.stringify({
                  error: {
                    code: 'skipped_budget',
                    message: 'Tool call skipped — turn output budget exceeded before this call ran.',
                  },
                }),
                isError: true,
              };
              executions.push(skipped);
              yield {
                type: 'tool_result',
                id: skipped.call.id,
                name: skipped.call.name,
                output: skipped.outputText,
                isError: true,
              };
            }
            break;
          }

          // Abort signal check between chunks — same idea, but we
          // bail without synthesizing skipped results because the
          // whole turn ends with done(aborted) below.
          if (runtimeController.signal.aborted) break;
        }

        // (d) Append pi-ai ToolResultMessage entries for EVERY dispatched
        //     or synthesized result. The set of toolCallIds in
        //     piMessages now exactly matches the set in final.content
        //     — protocol invariant satisfied for the next pi-ai turn.
        for (const { call, outputText, isError } of executions) {
          piMessages.push({
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: 'text', text: outputText }],
            isError,
            timestamp: Date.now(),
          });
        }

        if (budgetTrippedDuringDispatch || totalOutputBytes > MAX_OUTPUT_BYTES) {
          yield {
            type: 'error',
            message: `Codex tool output budget exceeded (${totalOutputBytes} / ${MAX_OUTPUT_BYTES} bytes). Ending turn.`,
            recoverable: true,
          };
          yield { type: 'done', finishReason: 'length' };
          return;
        }

        if (runtimeController.signal.aborted) {
          yield { type: 'done', finishReason: 'aborted' };
          return;
        }

        iteration++;
      }

      // Iteration ceiling hit — model is still requesting tools after
      // 20 turns. Stop here rather than loop forever; let the user see
      // what we have and re-prompt with a tighter task if they want
      // to continue.
      yield {
        type: 'error',
        message: `Codex reached the tool-loop ceiling (${MAX_ITER} iterations) and was still requesting tools. Ending turn.`,
        recoverable: true,
      };
      yield { type: 'done', finishReason: 'length' };
    } finally {
      input.abortSignal?.removeEventListener('abort', inputAbortHandler);
      // Clear the active controller only if it's still the one we created
      // — a newer turn may have already replaced it.
      if (this.activeAbortController === runtimeController) {
        this.activeAbortController = null;
      }
    }
  }
}

/**
 * Translate a single pi-ai AssistantMessageEvent into our normalized
 * AgentRuntimeEvent shape, or `null` to drop the event. Exported for
 * unit tests — the translation table is the most likely place for
 * subtle bugs (cumulative-vs-delta, missing event types) so we want it
 * test-pinnable in isolation.
 */
export function translatePiEvent(event: AssistantMessageEvent): AgentRuntimeEvent | null {
  switch (event.type) {
    case 'start':
    case 'text_start':
    case 'text_end':
    case 'thinking_start':
    case 'thinking_end':
      return null;  // structural events; payload comes via the deltas
    case 'text_delta':
      // pi-ai sends true deltas (the new chunk only), no cumulative
      // subtraction required. `delta` is the field name (not `text`).
      return { type: 'text_delta', text: event.delta };
    case 'thinking_delta':
      return { type: 'thinking_delta', text: event.delta };
    case 'toolcall_start':
    case 'toolcall_delta':
    case 'toolcall_end':
      // PR E3b: tool calls are sourced from `final.content` (the
      // captured AssistantMessage) as the authoritative list, NOT
      // from these streaming events. The runTurn outer loop emits
      // `tool_start` shells from the final-message ToolCall blocks
      // BEFORE dispatch — surfacing them here too would duplicate.
      // See the loop driver's `for (const call of batch)` block.
      return null;
    case 'done':
      // The outer iterator handles done via stream.result() to get
      // the full final message (usage, responseId). Drop this event;
      // the result-based done is what AgentService consumes.
      return null;
    case 'error':
      // Aborts come through here when the signal triggers mid-stream.
      // We mark aborts as `recoverable: true` (user-initiated, not a
      // system failure — retrying makes sense) and hard errors as
      // `recoverable: false` (provider/network failure, surface as-is).
      // The outer try/catch also catches abort separately via
      // `signal.aborted` and emits done{aborted}; this event is a
      // belt-and-suspenders translation.
      return {
        type: 'error',
        message: event.error.errorMessage ?? `Codex stream errored (${event.reason})`,
        recoverable: event.reason === 'aborted',
      };
  }
}

/**
 * Best-effort parse of `Retry-After:` value from an error message
 * string. Returns milliseconds, or undefined if no number found.
 * pi-ai bubbles HTTP error messages with the header value embedded
 * in some cases; we make a single pass at extraction.
 */
function parseRetryAfter(msg: string): number | undefined {
  const m = msg.match(/retry.?after[:\s]+(\d+)/i);
  if (m) return parseInt(m[1], 10) * 1000;
  return undefined;
}
