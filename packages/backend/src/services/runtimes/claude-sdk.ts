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
 * ## PR B2b: MCP loading, hooks attachment, capability methods
 *
 * `mcpServerStatus`, `toggleMcpServer`, `reconnectMcpServer`,
 * `rewindFiles`, `getContextUsage`, `listSessions` move from
 * `AgentService` to this runtime (exposed via `getCapabilityProvider`).
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

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly id: RuntimeId = 'claude-sdk';
  readonly providerId: ProviderId = 'claude';

  /**
   * Build SDK `Options` and call `query()`. Returns the SDK `Query`
   * result for the caller to iterate. All Claude-SDK-specific option
   * shape (preset system prompt, pulse-mode branching, plugin path
   * derivation, file checkpointing flag, resume id placement) lives
   * here so `AgentService` doesn't have to know about it.
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

    return query({ prompt: input.prompt, options });
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
