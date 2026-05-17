/**
 * `ClaudeAgentRuntime` — the Claude Agent SDK implementation of
 * `AgentRuntime`. Wraps `@anthropic-ai/claude-agent-sdk`.
 *
 * ## PR B1 status (this file): SCAFFOLD ONLY
 *
 * Nothing in the codebase dispatches through this runtime yet. The
 * existing `_processQuery` path in `agent.ts` still calls
 * `@anthropic-ai/claude-agent-sdk.query()` directly. This file exists
 * so the `AgentRuntime` shape is provably implementable and so the
 * resolver / capability machinery has a real instance to return when
 * tests or future code want one.
 *
 * Calling `runTurn` on this stub throws — there's no caller in B1,
 * but the throw is explicit so a stray future caller can't silently
 * fall through to a no-op. The error message points at the next PR
 * where the implementation actually lands.
 *
 * ## PR B2: implementation lands
 *
 * The guts of `_processQuery` (query options assembly, MCP loading,
 * hooks attachment, session resume, file checkpointing, stream
 * consumption, compaction handling, tool insertions) move here.
 * `_processQuery` becomes a thin wrapper that constructs an
 * `AgentTurnInput` and dispatches to `runTurn`, adapting the event
 * stream back into a string for the existing return signature.
 *
 * ## PR B3: callers switch
 *
 * `AgentService` consumes `AgentRuntimeEvent` directly instead of
 * Claude SDK message shapes; hook consumers (compaction banner,
 * scribe trigger, tool-result logs) rewire to the normalized event
 * stream. WebSocket broadcast layer becomes runtime-agnostic.
 */

import type { ProviderId, RuntimeId } from '@resonant/shared';
import type { AgentRuntime, AgentRuntimeEvent, AgentTurnInput, CapabilityKey } from './types.js';

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly id: RuntimeId = 'claude-sdk';
  readonly providerId: ProviderId = 'claude';

  /**
   * Not implemented in PR B1. Callers continue to use the existing
   * `_processQuery` path in `agent.ts`. PR B2 lands the real
   * implementation by moving `_processQuery` internals into this
   * method.
   */
  // eslint-disable-next-line require-yield
  async *runTurn(_input: AgentTurnInput): AsyncIterable<AgentRuntimeEvent> {
    throw new Error(
      'ClaudeAgentRuntime.runTurn is not wired up yet — PR B1 introduces the ' +
      'AgentRuntime interface scaffold only. Use AgentService.processMessage / ' +
      'processAutonomous (which still call @anthropic-ai/claude-agent-sdk ' +
      'directly via _processQuery) until PR B2 moves the SDK internals here.',
    );
  }

  /**
   * Reads `thread.current_session_id` for the Claude case once PR B1.5
   * / PR C add the per-(thread, runtime, provider, model_ref) sidecar
   * table. For PR B1 returns `undefined` because no caller invokes
   * this yet and the legacy resume path lives unchanged in
   * `_processQuery` (reads `thread.current_session_id` directly).
   */
  resumeSessionId(): string | undefined {
    return undefined;
  }

  /**
   * Same status as `resumeSessionId` — paired no-op for PR B1.
   */
  persistSessionId(): void {
    return;
  }

  /**
   * Capability lookup. Real capabilities (MCP toggle, listSessions,
   * file rewind, getContextUsage) land in PR B2 when the SDK call
   * surface moves in. For PR B1 always returns `undefined`.
   */
  getCapabilityProvider<T>(_cap: CapabilityKey): T | undefined {
    return undefined;
  }

  /**
   * No-op in PR B1 — abort routing happens through `AgentService`'s
   * existing `activeAbortController` field, not through this runtime.
   * PR B2 moves the abort controller in here.
   */
  abort(): void {
    return;
  }
}
