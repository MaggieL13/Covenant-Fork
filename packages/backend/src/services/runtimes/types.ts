/**
 * Multi-provider runtime interface — the contract every provider runtime
 * (Claude SDK, Codex OAuth, OpenRouter, Ollama) implements.
 *
 * PR B1 (this file): defines the shape only. No runtime is wired up
 * yet; no caller dispatches through this interface. The existing
 * `_processQuery` path in `agent.ts` still calls
 * `@anthropic-ai/claude-agent-sdk.query()` directly.
 *
 * PR B2: `ClaudeAgentRuntime` becomes the real implementation; the
 * guts of `_processQuery` move into it.
 *
 * PR B3: `AgentService` dispatches through `resolveConfiguredRuntime`
 * + the normalized event bridge instead of calling `query()` directly,
 * and the WebSocket broadcast layer consumes `AgentRuntimeEvent`
 * instead of Claude-SDK-shaped messages.
 *
 * See `shared/multi-provider-runtime-spec-2026-05-16.md` (gitignored)
 * for the full design and PR sequence rationale.
 */

import type { Thread } from '@resonant/shared';
import type { ModelRef, ProviderId, RuntimeId, ThinkingEffort } from '@resonant/shared';
import type { AgentModelTier } from '../agent.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * System prompt shape varies per runtime. Claude SDK accepts a preset
 * marker `{ type: 'preset', preset: 'claude_code', append }`; other
 * runtimes take plain text. The union preserves the Claude shape
 * losslessly so we don't strip the preset on the way through.
 */
export type RuntimeSystemPrompt =
  | { kind: 'text'; value: string }
  | { kind: 'claude-preset'; preset: 'claude_code'; append: string };

/**
 * Minimal normalized message shape used in handoff packets and (later)
 * in conversation history replay for runtimes without native session
 * resume. Intentionally tiny — providers translate to their own
 * native shape inside `runTurn`.
 */
export interface NormalizedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;        // ISO 8601
}

/**
 * Cross-provider handoff packet. Generated when a turn is dispatched
 * on a (runtime, provider, model) combination with no session row in
 * `thread_provider_sessions` for the current thread AND the thread
 * has at least one prior assistant turn.
 *
 * Renamed from "handoff packet" in spec Rev 2 to avoid collision with
 * the existing Claude-SDK `session.handoff_note` (which is the
 * compaction recovery note — distinct concept).
 */
export interface ProviderHandoff {
  handoffVersion: 1;
  fromRuntime: RuntimeId;
  fromProvider: ProviderId;
  fromModelRef: string;            // canonical ref of the previous turn's model
  sourceSessionId?: string;        // audit/debug only; target doesn't use it
  toRuntime: RuntimeId;
  toProvider: ProviderId;
  targetModelRef: string;          // canonical ref of the new turn's model
  threadTitle?: string;
  lastDigest?: string;
  summary: string;                 // 2-4 sentences, memory-tier or extractive
  summarySource: 'memory-tier' | 'extractive-fallback';
  recentMessages: NormalizedMessage[];
  budget: {
    summaryTokens: number;
    recentTokens: number;
    totalCap: number;
  };
}

/**
 * Placeholder tool definition. Claude SDK runs MCP servers natively
 * (no explicit tools list passed to `runTurn`); non-Claude runtimes
 * in later PRs will translate this to their provider-native format.
 * For PR B1 the shape is intentionally minimal — fleshed out when a
 * non-Claude runtime first needs it.
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;           // JSON schema; provider-translated at request build
}

/** Subset of `Thread` needed to dispatch a turn. */
export type ThreadHandle = Pick<
  Thread,
  'id' | 'name' | 'type' | 'current_session_id'
>;

/**
 * Input to a runtime turn. Built by `AgentService` from the user
 * message + orientation context + thread state + tier config, then
 * passed to the resolved runtime's `runTurn`.
 */
export interface AgentTurnInput {
  thread: ThreadHandle;
  tier: AgentModelTier;
  modelRef: ModelRef;
  platform: 'web' | 'discord' | 'telegram' | 'api' | 'internal';
  isAutonomous: boolean;
  /** Pre-assembled orientation context block (thread, time, gap, status,
   *  vault). Runtime prepends or includes as appropriate. */
  orientation: string;
  systemPrompt: RuntimeSystemPrompt;
  /** Last-N conversation history in normalized form. Most runtimes
   *  with native session resume ignore this when `sessionId` is set;
   *  others always use it. */
  messages: NormalizedMessage[];
  /** Cross-provider bridge packet when the (runtime, provider, model)
   *  combination has no prior session for this thread. */
  handoff?: ProviderHandoff;
  /** Provider-native session id for resume (Claude SDK session_id,
   *  Codex conversation_id, etc.). Omitted for fresh sessions. */
  sessionId?: string;
  cwd?: string;
  thinkingEffort?: ThinkingEffort;
  tools?: ToolDefinition[];
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Events (the stream emitted by `runTurn`)
// ---------------------------------------------------------------------------

/**
 * Normalized event stream from any runtime. Replaces direct consumption
 * of Claude SDK message shapes in the WebSocket broadcast / persistence
 * layers (the wiring happens in PR B3 — for now this is just a contract).
 *
 * `text_delta` vs `text_snapshot`: some providers emit incremental
 * deltas (Claude SDK, OpenAI streaming with delta mode), others emit
 * cumulative snapshots of the full text-so-far (some Ollama models).
 * Consumers handle both: deltas append, snapshots replace.
 */
export type AgentRuntimeEvent =
  /** Stream actually began (distinct from "queued"). */
  | { type: 'start'; runtimeId: RuntimeId; modelRef: ModelRef }
  /** Provider-native session id captured. Persisted to
   *  `thread_provider_sessions` for future resume. */
  | { type: 'session'; sessionId: string }
  /** Incremental text token. Append to running buffer. */
  | { type: 'text_delta'; text: string }
  /** Cumulative text snapshot. Replace the running buffer. */
  | { type: 'text_snapshot'; text: string }
  /** Incremental reasoning / extended thinking. `summary` carries the
   *  short surfaced version when the provider exposes it (Claude). */
  | { type: 'thinking_delta'; text: string; summary?: string }
  /** Tool invocation started. `input` is the parsed argument object. */
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  /** Tool invocation completed. `isError` distinguishes recoverable
   *  tool failures from successful results. */
  | { type: 'tool_result'; id: string; name: string; output: unknown; isError?: boolean }
  /** Context-window gauge update (used / max). Surfaces in the
   *  context-usage indicator. */
  | { type: 'context_usage'; used: number; max: number }
  /** Billable usage report. Distinct from `context_usage` — this is
   *  cost/quota, not gauge. `cost` is provider-reported when available. */
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number }
  /** Context compaction lifecycle (Claude SDK only). Drives the
   *  in-flight compaction banner. */
  | { type: 'compaction_notice'; phase: 'starting' | 'complete' }
  /** Provider signaled a rate limit. Optional retry hint in ms. */
  | { type: 'rate_limit'; retryAfterMs?: number }
  /** Provider-specific diagnostic (Codex WS fallback, OpenRouter
   *  routing notes, Ollama local server reachability). Surfaced to
   *  logs and optionally to UI. */
  | { type: 'provider_diagnostic'; code: string; message: string; data?: unknown }
  /** Provider needs (re-)authentication. Routes the UI to the
   *  appropriate auth flow instead of showing a generic error. */
  | { type: 'auth_required'; provider: ProviderId; message: string }
  /** Response was suppressed by the runtime itself (e.g. pulse
   *  PULSE_OK from a provider that emits its own suppression
   *  signal). Generalizes today's `stream_end { suppressed: true }`. */
  | { type: 'suppressed'; reason: string }
  /** Turn complete. `finishReason` mirrors OpenAI's vocabulary
   *  because every provider can map to it. */
  | { type: 'done'; finishReason: 'stop' | 'length' | 'tool_calls' | 'aborted' | 'error' }
  /** Unrecoverable runtime error. `recoverable: true` indicates the
   *  user can fix and retry (e.g. config error); `false` indicates
   *  a provider/network failure to surface as-is. */
  | { type: 'error'; message: string; recoverable: boolean };
// Future: { type: 'media'; ... } for vision/image outputs.

// ---------------------------------------------------------------------------
// The runtime interface
// ---------------------------------------------------------------------------

/**
 * Capability key for optional runtime-specific extensions
 * (MCP server toggle, listSessions, file rewind). Each runtime
 * exposes whichever capabilities it actually implements via
 * `getCapabilityProvider`. Consumers check for `undefined`
 * before calling — non-Claude runtimes return `undefined` for
 * Claude-SDK-specific caps and that's the correct contract.
 *
 * For PR B1 this is a plain string. Later PRs may move to a
 * branded type for static type-safety.
 */
export type CapabilityKey = string;

export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly providerId: ProviderId;

  /**
   * Execute one turn. Returns an async iterable of normalized events.
   *
   * Runtime contract:
   * - Always emit `{type: 'start'}` first.
   * - Always emit `{type: 'done'}` exactly once at the end (success,
   *   length, or aborted) OR `{type: 'error'}` exactly once on
   *   unrecoverable failure.
   * - May emit `{type: 'session'}` once when a fresh session is
   *   established (so `AgentService` can persist to
   *   `thread_provider_sessions`).
   * - Other events (`text_delta`, `tool_*`, `thinking_*`,
   *   `usage`, `context_usage`, etc.) are best-effort per provider.
   */
  runTurn(input: AgentTurnInput): AsyncIterable<AgentRuntimeEvent>;

  /**
   * Look up the runtime-native session id to resume for this thread+model
   * pair. Returns `undefined` if no compatible session exists.
   *
   * Optional — runtimes without session resume (Ollama, fresh OpenRouter
   * conversations) don't implement this.
   */
  resumeSessionId?(thread: ThreadHandle, modelRef: ModelRef): string | undefined;

  /**
   * Persist a runtime-native session id for future resume.
   *
   * Optional — paired with `resumeSessionId`. Runtimes that don't
   * support resume don't implement this either.
   */
  persistSessionId?(thread: ThreadHandle, modelRef: ModelRef, sessionId: string): void;

  /**
   * Look up an optional capability extension (MCP toggle, listSessions,
   * file rewind). Returns `undefined` when the runtime doesn't
   * implement that capability — and that's the correct answer to
   * surface (the UI hides the corresponding controls).
   */
  getCapabilityProvider?<T>(cap: CapabilityKey): T | undefined;

  /**
   * Abort the in-flight turn. Idempotent. Optional — runtimes
   * without long-lived in-flight state (single-shot HTTP) may skip.
   */
  abort?(): void;
}
