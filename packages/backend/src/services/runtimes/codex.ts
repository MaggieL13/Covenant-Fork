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
import { getModel, type Message as PiMessage, type AssistantMessageEvent, type StopReason as PiStopReason, type Model } from '@earendil-works/pi-ai';
import type { ModelRef, ProviderId, RuntimeId } from '@resonant/shared';
import {
  getCodexAccessToken,
  CodexAuthRequiredError,
} from '../auth/codex-oauth.js';
import {
  getProviderSession,
  setProviderSession,
} from '../db/provider-sessions.js';
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

    const context = {
      systemPrompt: handoffNote + systemText,
      messages: toPiMessages(input.messages),
      tools: undefined,  // E2: no tool support for Codex
    };

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

    console.log(
      `[CodexRuntime] turn start: model=${input.modelRef.model}, ` +
      `messages=${context.messages.length}, ` +
      `effort=${reasoningEffort ?? 'default'}, ` +
      `cacheKey=${priorResponseId ?? 'fresh'}`,
    );

    // Kick off the stream. pi-ai's StreamFunction returns an
    // AssistantMessageEventStream synchronously; iteration awaits each
    // event. Errors during request setup are thrown synchronously here;
    // errors mid-stream surface as `{ type: 'error' }` events.
    let stream;
    try {
      stream = streamOpenAICodexResponses(piModel, context, {
        apiKey: accessToken,
        signal: runtimeController.signal,
        sessionId: priorResponseId,
        reasoningEffort,
        reasoningSummary: 'auto',
      });
    } catch (err) {
      input.abortSignal?.removeEventListener('abort', inputAbortHandler);
      const msg = err instanceof Error ? err.message : String(err);
      // Auth failures during request setup (rare — token already
      // validated by getCodexAccessToken's refresh) get the
      // auth_required treatment.
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

    // Stream consumer — translate each pi-ai event into our normalized
    // shape. text_delta events pass through 1:1 (pi-ai gives true
    // deltas already), but thinking_* events get BUFFERED here:
    // pi-ai sends one thinking_delta per token, which would render as
    // ~hundreds of micro-blocks in the UI (one card per word). We
    // accumulate inside a thinking_start/thinking_end pair and emit a
    // single consolidated thinking_delta when the block closes — that
    // gives one card per logical reasoning chunk, matching the Claude
    // path's per-block shape that the UI was tuned for.
    let thinkingBuffer: string | null = null;
    let debugDeltaBatch: CodexDebugDeltaBatch | null = null;
    try {
      for await (const event of stream) {
        debugDeltaBatch = logCodexPiEvent(event, debugDeltaBatch);

        // Per-block thinking buffering (Codex-specific; pure passthrough
        // would flood the UI with single-token cards).
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
        if (translated) {
          yield translated;
        }
      }
      // Safety: if the stream ended mid-thinking-block (rare; defensive),
      // flush the buffer so the user sees what was reasoned so far.
      flushCodexPiEventDebugBatch(debugDeltaBatch);
      debugDeltaBatch = null;
      if (thinkingBuffer && thinkingBuffer.length > 0) {
        yield { type: 'thinking_delta', text: thinkingBuffer };
      }

      // After the stream drains, the result() promise carries the final
      // AssistantMessage with usage + responseId + stopReason. Capture
      // session id for sidecar persistence + emit our usage event.
      const final = await stream.result();
      logCodexFinalMessage(final);
      if (final.responseId) {
        yield { type: 'session', sessionId: final.responseId };
        // Persist for next turn's prompt-cache affinity.
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
    } catch (err) {
      flushCodexPiEventDebugBatch(debugDeltaBatch);
      debugDeltaBatch = null;
      const msg = err instanceof Error ? err.message : String(err);
      // Abort path — `signal: aborted` throws inside the iteration.
      if (runtimeController.signal.aborted) {
        yield { type: 'done', finishReason: 'aborted' };
        return;
      }
      // Auth failures mid-stream (token expired between getCodexAccessToken
      // and the actual request) — surface as auth_required so the UI
      // routes the user to re-login.
      if (/401|unauthor/i.test(msg)) {
        yield {
          type: 'auth_required',
          provider: this.providerId,
          message: `Codex auth expired during request: ${msg}. Log in again via Settings.`,
        };
        yield { type: 'done', finishReason: 'error' };
        return;
      }
      // Rate-limit signal — surface separately so UI can show the
      // banner instead of a generic error.
      if (/429|rate.?limit/i.test(msg)) {
        const retryAfterMs = parseRetryAfter(msg);
        yield { type: 'rate_limit', retryAfterMs };
        yield { type: 'done', finishReason: 'error' };
        return;
      }
      yield { type: 'error', message: msg, recoverable: false };
      yield { type: 'done', finishReason: 'error' };
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
      // E2 ships with no tools sent to Codex; if a tool event ever
      // arrives despite that, surface as a diagnostic rather than
      // crashing or pretending to consume it.
      return {
        type: 'provider_diagnostic',
        code: 'unexpected_tool_event',
        message: `Codex emitted ${event.type} but tools are not enabled in E2`,
      };
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
