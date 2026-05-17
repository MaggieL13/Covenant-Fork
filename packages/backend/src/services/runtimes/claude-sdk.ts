/**
 * `ClaudeAgentRuntime` — the Claude Agent SDK implementation of
 * `AgentRuntime`. Wraps `@anthropic-ai/claude-agent-sdk`.
 *
 * ## PR B1 status: SCAFFOLD ONLY (the `AgentRuntime` interface)
 *
 * The `runTurn` method is still a stub that throws. PR B3 lands the
 * fully-normalized event-stream implementation along with the
 * side-by-side WS regression suite.
 *
 * ## PR B2a status: SDK CALL SITE MOVED HERE
 *
 * `dispatchClaudeQuery` is a Claude-SDK-specific helper that owns the
 * `Options` assembly and the `query()` call. `AgentService._processQuery`
 * calls this method instead of importing `query` from
 * `@anthropic-ai/claude-agent-sdk` directly. The returned `Query` is
 * iterated by AgentService as before — stream consumption + event
 * persistence + WS broadcast all stay in AgentService. Behavior is
 * byte-identical to before this PR.
 *
 * Why a separate `dispatchClaudeQuery` method instead of `runTurn`:
 * `runTurn` returns `AsyncIterable<AgentRuntimeEvent>` (normalized
 * events), which means a real `runTurn` implementation requires the
 * SDK→AgentRuntimeEvent translation layer. That translation lands in
 * PR B3 alongside side-by-side WS regression tests. For B2a we just
 * need to consolidate the SDK touchpoint; emitting Claude-native
 * shapes through the existing path is the smallest correct step.
 *
 * ## PR B2b status: capabilities moved as DIRECT METHODS
 *
 * `listSessions` (B2b-1) + `mcpServerStatusLive` /
 * `toggleMcpServerLive` / `reconnectMcpServerLive` / `rewindFiles` /
 * `fireContextUsageRefresh` / `getContextUsage` /
 * `resetContextOnCompaction` (B2b-2) live as direct concrete methods
 * on `ClaudeAgentRuntime`, not behind `getCapabilityProvider`.
 *
 * Direct methods chosen over the cap-provider lookup because every
 * caller today knows it's talking to Claude (AgentService is the only
 * dispatcher, and it still calls these methods directly through the
 * `claudeRuntime` singleton). When PR E ships the Codex runtime,
 * AgentService's MCP/rewind/etc. methods will need to consult the
 * resolved runtime's capabilities — that's the point to reconsider
 * `getCapabilityProvider` as a runtime-agnostic typed lookup. For B2b
 * the abstraction would be overhead without payoff.
 *
 * ## PR B3: normalized event bridge + callers switch
 *
 * `runTurn` stops throwing and becomes the canonical entry point.
 * AgentService consumes `AgentRuntimeEvent` directly; the
 * `dispatchClaudeQuery` helper becomes a private implementation
 * detail of `runTurn`. WebSocket broadcast layer becomes
 * runtime-agnostic. Hook consumers rewire to the normalized stream.
 */

import { query, listSessions, type Options, type Query, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'path';
import type { ProviderId, RuntimeId } from '@resonant/shared';
import type { AgentRuntime, AgentRuntimeEvent, AgentTurnInput, CapabilityKey } from './types.js';

/**
 * Input to `dispatchClaudeQuery`. Mirrors the inputs that
 * `_processQuery` was assembling inline before B2a — keeps the
 * Claude-specific shape (preset system-prompt vs plain pulse text,
 * MCP servers, hooks) explicit so the runtime contract is unambiguous.
 *
 * **Not** the same as `AgentTurnInput`. `AgentTurnInput` is the
 * provider-agnostic shape that `runTurn` will accept in PR B3;
 * `ClaudeRuntimeDispatchInput` is the Claude-flavored intermediate that
 * `dispatchClaudeQuery` consumes during the B2a → B3 transition.
 */
export interface ClaudeRuntimeDispatchInput {
  /** Enriched prompt (orientation context + recent history + user content). */
  prompt: string;
  /** Raw provider-native model id (`claude-sonnet-4-6`, `sonnet`, etc.). */
  model: string;
  /** Working directory for the SDK (skills discovery, file checkpointing). */
  cwd: string;
  /** Pulse mode flips a long list of SDK options — kept as one bool for
   *  parity with the pre-B2a inline assembly. */
  isPulse: boolean;
  /** Effort level resolved per model (`auto` -> `medium`/`high` etc.). */
  effectiveEffort: string;
  /** Non-pulse: appended to the `claude_code` preset system prompt. */
  appendSystemPromptText?: string;
  /** Pulse: plain text used as the entire system prompt. */
  pulseSystemPrompt?: string;
  /** MCP server map (already keyword-gated by `buildMcpServersForQuery`).
   *  Omitted or empty → no `mcpServers` field on the SDK options. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Hook callbacks (Claude-SDK shape) from `createHooks(hookContext)`.
   *  Omitted on pulse turns. */
  hooks?: Options['hooks'];
  /** Existing session id to resume. Omitted on pulse (pulse never
   *  resumes — `persistSession: false`). */
  resumeSessionId?: string;
  /** Abort controller for stop_generation + safety timeout. */
  abortController: AbortController;
}

/**
 * Callback shape `fireContextUsageRefresh` invokes when a fresh
 * context-usage snapshot arrives. AgentService wires this to its
 * WebSocket broadcaster + log line — the runtime doesn't reach into
 * the registry directly so the abstraction stays clean.
 */
export interface ContextUsageUpdate {
  used: number;
  window: number;
  percentage: number;
  model: string;
}

/**
 * Status snapshot returned by MCP live ops. Mirrors the SDK's
 * `mcpServerStatus()` return shape — AgentService maps these into the
 * Resonant-flavored `McpServerInfo` (with `toolCount` etc.) at the
 * boundary, keeping protocol translation in the runtime and shape
 * conversion in the consumer.
 */
export interface McpLiveOpResult {
  statuses?: Array<{
    name: string;
    status: string;
    error?: string;
    tools?: Array<{ name: string; description?: string }>;
    scope?: string;
  }>;
  error?: string;
}

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly id: RuntimeId = 'claude-sdk';
  readonly providerId: ProviderId = 'claude';

  /**
   * In-flight Claude SDK Query — captured during `dispatchClaudeQuery`,
   * released in `clearActiveQuery` (called by AgentService's `finally`
   * block in `_processQuery`). Capability methods (`rewindFiles`, MCP
   * live ops, `fireContextUsageRefresh`) operate on this reference;
   * they short-circuit to `{ error: 'No active session' }` when null.
   *
   * Was a module-level `let activeQuery` in `agent.ts` before PR B2b-2.
   * Moving to instance state ties the SDK lifecycle to the runtime
   * (where it belongs) and clears the way for multiple runtime
   * implementations to maintain their own provider-native in-flight
   * handles independently.
   */
  private activeQuery: Query | null = null;

  // Context-usage gauge state. Updated by `fireContextUsageRefresh`;
  // read by `getContextUsage`. `pendingContextRefresh` debounces
  // simultaneous SDK calls; `lastReportedTokens` dedupes value-equal
  // refreshes (same number twice in a row → no broadcast).
  // All four were module/closure state in `_processQuery` before B2b-2.
  private contextTokensUsed = 0;
  private contextWindowSize = 0;
  private pendingContextRefresh = false;
  private lastReportedTokens = -1;

  /**
   * Build SDK `Options` and call `query()`. Returns the SDK `Query`
   * result for the caller to iterate. All Claude-SDK-specific option
   * shape (preset system prompt, pulse-mode branching, plugin path
   * derivation, file checkpointing flag, resume id placement) lives
   * here so `AgentService` doesn't have to know about it.
   *
   * As of PR B2b-2 this also captures the returned `Query` as the
   * runtime's `activeQuery` so capability methods (`rewindFiles`, MCP
   * live ops, context refresh) can operate on the in-flight session
   * without AgentService having to pass it through.
   *
   * Behavior must remain byte-identical to the pre-B2a inline assembly
   * in `_processQuery`. If you find yourself "improving" the option
   * shape during this move, stop — improvements belong in their own
   * PR with their own behavior diff.
   */
  dispatchClaudeQuery(input: ClaudeRuntimeDispatchInput): Query {
    const options: Options = {
      model: input.model,
      systemPrompt: input.isPulse
        ? (input.pulseSystemPrompt ?? '')
        : { type: 'preset', preset: 'claude_code', append: input.appendSystemPromptText ?? '' },
      cwd: input.cwd,
      permissionMode: input.isPulse ? 'plan' : 'bypassPermissions',
      allowDangerouslySkipPermissions: !input.isPulse,
      maxTurns: input.isPulse ? 1 : 30,
      includePartialMessages: !input.isPulse,
      // `display: 'summarized'` is required to actually see thinking on Opus
      // 4.7+ — those models default `display` to `'omitted'`, which causes the
      // API to return empty `thinking` blocks (only `signature` for continuity).
      // On 4.6 / Sonnet 4.6 the default is already `'summarized'` so this is
      // a no-op. Without it, the streaming capture path in `_processQuery`
      // never sees `thinking_delta` events on 4.7 and the panel logs
      // "0 thinking block(s)" even when the model thought hard.
      // Ref: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
      thinking: input.isPulse ? { type: 'disabled' } : { type: 'adaptive', display: 'summarized' },
      effort: input.effectiveEffort as any,
      tools: input.isPulse ? [] : undefined,
      persistSession: input.isPulse ? false : undefined,
      hooks: input.isPulse ? undefined : input.hooks,
      // Plugin: native skill discovery from .claude/skills/
      plugins: input.isPulse
        ? undefined
        : [{ type: 'local' as const, path: join(input.cwd, '.claude').replace(/\\/g, '/') }],
      // Explicitly pass MCP servers — SDK isolation mode doesn't auto-discover .mcp.json
      ...(input.mcpServers && Object.keys(input.mcpServers).length > 0 && {
        mcpServers: input.mcpServers,
      }),
      abortController: input.abortController,
      // File checkpointing enables rewindFiles() — only valid on non-pulse turns
      // (pulse runs `permissionMode: 'plan'` which is read-only anyway).
      ...(input.isPulse ? {} : { enableFileCheckpointing: true }),
      // Resume existing session if provided (non-pulse only — pulse passes
      // `persistSession: false` so resume has no meaning there).
      ...(input.resumeSessionId && !input.isPulse ? { resume: input.resumeSessionId } : {}),
    };

    const result = query({ prompt: input.prompt, options });
    this.activeQuery = result;
    return result;
  }

  /**
   * Release the in-flight Query reference. Called by AgentService's
   * `_processQuery` `finally` block after the stream loop completes
   * (success, error, or abort). Subsequent capability calls return
   * "No active session" until the next `dispatchClaudeQuery`.
   *
   * Also resets context-usage dedup state so the first refresh on the
   * next turn always fires (otherwise a turn-to-turn collision on
   * `totalTokens` would silently skip the first broadcast).
   */
  clearActiveQuery(): void {
    this.activeQuery = null;
    this.pendingContextRefresh = false;
    this.lastReportedTokens = -1;
  }

  /** True iff a Query is currently in flight. */
  hasActiveQuery(): boolean {
    return this.activeQuery !== null;
  }

  /**
   * Current gauge snapshot (from the most recent successful refresh).
   * `tokensUsed` and `contextWindow` are 0 before any refresh has
   * happened in the current session.
   */
  getContextUsage(): { tokensUsed: number; contextWindow: number } {
    return { tokensUsed: this.contextTokensUsed, contextWindow: this.contextWindowSize };
  }

  /**
   * Called from the compaction-boundary handler in `_processQuery`
   * after the SDK reports a successful compaction. The window is
   * fresh post-compaction so the gauge resets to 0; the next refresh
   * tick repopulates it.
   */
  resetContextOnCompaction(): void {
    this.contextTokensUsed = 0;
  }

  /**
   * Fire-and-forget context-usage refresh. Called from
   * `_processQuery`'s stream loop on each assistant tick.
   *
   * - Debounced: `pendingContextRefresh` ensures only one outstanding
   *   SDK control request at a time (multiple assistant ticks within
   *   a single turn don't pile up).
   * - Value-deduped: `lastReportedTokens` tracks the last successful
   *   read; identical-value refreshes skip both the local mutation
   *   AND the `onUpdate` callback so the broadcaster doesn't emit
   *   redundant `context_usage` events.
   * - Error-tolerant: the SDK's "Query closed before response
   *   received" race (which fires on the last refresh tick of every
   *   successful turn) is silenced at the log level; other failures
   *   surface as warnings.
   *
   * The `onUpdate` callback is invoked synchronously on the
   * micro-task that handles the SDK response. AgentService passes
   * the WebSocket broadcaster + log line as the callback so the
   * runtime stays free of `registry` / `console.log` formatting
   * coupling.
   */
  fireContextUsageRefresh(onUpdate: (info: ContextUsageUpdate) => void): void {
    if (!this.activeQuery || this.pendingContextRefresh) return;
    this.pendingContextRefresh = true;
    this.activeQuery.getContextUsage().then((usage) => {
      if (
        usage
        && typeof usage.totalTokens === 'number'
        && typeof usage.maxTokens === 'number'
        && usage.maxTokens > 0
      ) {
        if (usage.totalTokens === this.lastReportedTokens) return;
        this.lastReportedTokens = usage.totalTokens;
        this.contextTokensUsed = usage.totalTokens;
        this.contextWindowSize = usage.maxTokens;
        const percentage = typeof usage.percentage === 'number'
          ? Math.round(usage.percentage)
          : Math.round((usage.totalTokens / usage.maxTokens) * 100);
        onUpdate({
          used: this.contextTokensUsed,
          window: this.contextWindowSize,
          percentage,
          model: usage.model ?? '?',
        });
      }
    }).catch((err) => {
      // Defensive: getContextUsage() can fail if the query closed
      // between our request and the response. The LAST refresh tick
      // on any turn races the SDK's stream-close — that's expected,
      // not a failure. Suppress that specific message; surface real
      // errors.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/Query closed before response received/i.test(msg)) {
        console.warn('[ClaudeAgentRuntime] getContextUsage failed:', msg);
      }
    }).finally(() => {
      this.pendingContextRefresh = false;
    });
  }

  /**
   * Snapshot of MCP server statuses from the live session. Returns
   * `null` (not throw) when there's no active query — caller should
   * treat as "status unavailable right now, try after next turn."
   */
  async mcpServerStatusLive(): Promise<McpLiveOpResult['statuses'] | null> {
    if (!this.activeQuery) return null;
    try {
      return await this.activeQuery.mcpServerStatus();
    } catch (err) {
      console.warn('[ClaudeAgentRuntime] Failed to get MCP status:', err);
      return null;
    }
  }

  /**
   * Reconnect a single MCP server in the live session, then return
   * the post-reconnect status snapshot for the caller to merge into
   * its cache. Returns `{ error }` if there's no active query (which
   * means the reconnect will happen on the next turn automatically
   * — caller surfaces this as "will apply on next message").
   */
  async reconnectMcpServerLive(name: string): Promise<McpLiveOpResult> {
    if (!this.activeQuery) {
      return { error: 'No active session — will apply on next message' };
    }
    try {
      await this.activeQuery.reconnectMcpServer(name);
      const statuses = await this.activeQuery.mcpServerStatus();
      return { statuses };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Toggle a single MCP server enabled/disabled in the live session,
   * then return the post-toggle status snapshot. Returns `{}` (no
   * statuses, no error) when there's no active query — caller's DB
   * write of the persistent disabled-list is the source of truth for
   * future turns; this op is purely the in-flight SDK adjustment.
   */
  async toggleMcpServerLive(name: string, enabled: boolean): Promise<McpLiveOpResult> {
    if (!this.activeQuery) {
      return {};
    }
    try {
      await this.activeQuery.toggleMcpServer(name, enabled);
      const statuses = await this.activeQuery.mcpServerStatus();
      return { statuses };
    } catch {
      // Best-effort — failures here don't propagate to the caller
      // because the persistent disabled-list is already authoritative
      // for the next turn. Matches pre-B2b-2 behavior in
      // AgentService.toggleMcpServer which silently swallowed live-op
      // failures.
      return {};
    }
  }

  /**
   * Rewind filesystem changes back to the state at a previous user
   * message. Thin wrap of `Query.rewindFiles` from the SDK; returns
   * `{ canRewind: false, error: ... }` when there's no active query
   * (matches the pre-B2b-2 AgentService behavior).
   */
  async rewindFiles(userMessageId: string, dryRun?: boolean): Promise<{ canRewind: boolean; filesChanged?: string[]; insertions?: number; deletions?: number; error?: string }> {
    if (!this.activeQuery) {
      return { canRewind: false, error: 'No active session' };
    }
    try {
      return await this.activeQuery.rewindFiles(userMessageId, { dryRun });
    } catch (err) {
      return { canRewind: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Not implemented in PR B1/B2a. Callers continue to use
   * `dispatchClaudeQuery` (B2a) + the existing `_processQuery` stream
   * consumption path. PR B3 lands the normalized-event implementation
   * that replaces both.
   */
  // eslint-disable-next-line require-yield
  async *runTurn(_input: AgentTurnInput): AsyncIterable<AgentRuntimeEvent> {
    throw new Error(
      'ClaudeAgentRuntime.runTurn is not wired up yet — PR B3 will land the ' +
      'normalized event implementation. Until then, AgentService._processQuery ' +
      'calls dispatchClaudeQuery() directly and iterates the SDK Query result ' +
      'with the existing stream-consumption code.',
    );
  }

  /**
   * Reads `thread.current_session_id` for the Claude case once PR C adds
   * the per-(thread, runtime, provider, model_ref) sidecar table. For
   * now returns `undefined` — the legacy resume path lives in
   * `_processQuery` (reads `thread.current_session_id` directly).
   */
  resumeSessionId(): string | undefined {
    return undefined;
  }

  /** Same status as `resumeSessionId` — paired no-op. */
  persistSessionId(): void {
    return;
  }

  /**
   * List historical SDK sessions in a given working directory. Thin
   * wrapper over `@anthropic-ai/claude-agent-sdk.listSessions` —
   * moved here in PR B2b-1 so the SDK import surface stays
   * consolidated to this file. Errors are swallowed to an empty
   * array because the panel that consumes this can tolerate a
   * missing session list (degrades gracefully to "no sessions
   * shown") but should never 500 over a transient SDK hiccup.
   */
  async listSessions(cwd: string, limit = 50): Promise<unknown[]> {
    try {
      return await listSessions({ dir: cwd, limit });
    } catch (err) {
      console.error('[ClaudeAgentRuntime] Failed to list sessions:', err);
      return [];
    }
  }

  /**
   * Capability lookup. MCP toggle / file rewind / context usage move
   * here in PR B2b-2 (the heavier landing — those couple through the
   * shared `activeQuery` state and migrate together). For now returns
   * `undefined` for every cap; the simple no-state capabilities
   * (listSessions today) are exposed as direct methods instead of
   * through this lookup so callers don't have to do double
   * indirection. The cap lookup is preserved for future capabilities
   * that genuinely benefit from runtime-agnostic typing.
   */
  getCapabilityProvider<T>(_cap: CapabilityKey): T | undefined {
    return undefined;
  }

  /**
   * No-op — abort routing happens through `AgentService.activeAbortController`,
   * passed through `dispatchClaudeQuery` input. PR B3 moves the
   * controller in here.
   */
  abort(): void {
    return;
  }
}
