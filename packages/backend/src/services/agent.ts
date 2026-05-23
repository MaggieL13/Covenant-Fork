import { query, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerInfo } from '@resonant/shared';
import { MODELS, resolveEffortForModel, coerceEffortForProvider, normalizeModelRef, unwrapModelRefForClaudeSdk, findModelByRef, type ModelRef, type ModelCapabilities } from '@resonant/shared';
import { ClaudeAgentRuntime } from './runtimes/claude-sdk.js';
import { CodexRuntime } from './runtimes/codex.js';
import type { AgentRuntime, AgentTurnInput, NormalizedMessage } from './runtimes/types.js';
import { buildCodexNormalizedMessages } from './runtimes/codex-history.js';
import { buildProviderHandoff, renderProviderHandoffAsPrompt, type ProviderHandoff } from './handoff.js';
import { createMessage, updateThreadSession, clearAllThreadSessions, getThread, updateThreadActivity, createSessionRecord, endSessionRecord, getConfig as getDbConfig, setConfig as setDbConfig, getMessages, getProviderSession, setProviderSession, hasProviderSessionsForThread, listProviderSessionsForThread, clearAllProviderSessions } from './db.js';
import { registry } from './registry.js';
import { createHooks, buildOrientationContext, buildPulseOrientationContext, type HookContext, type ToolInsertion } from './hooks.js';
import type { MessageSegment, ProviderShape, RuntimeId, MessageProvenance } from '@resonant/shared';
import { normalizeThinkingSegment } from '@resonant/shared';
import type { PushService } from './push.js';
import { getResonantConfig } from '../config.js';
import crypto from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

// Lazy-init: config isn't available at import time — defer until first use
let _initialized = false;
let needsReinit = false;
let claudeMdContent = '';
let AGENT_CWD = '';
const mcpServersFromConfig: Record<string, McpServerConfig> = {};

/** Mark the agent for re-initialization (e.g. after CLAUDE.md changes) */
export function markForReinit(): void {
  needsReinit = true;
}

function ensureInit() {
  if (_initialized && !needsReinit) return;
  needsReinit = false;
  _initialized = true;
  const config = getResonantConfig();
  AGENT_CWD = config.agent.cwd;

  // Load CLAUDE.md
  const candidates = [
    config.agent.claude_md_path,
    join(AGENT_CWD, '.claude/CLAUDE.md'),
    join(AGENT_CWD, 'CLAUDE.md'),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) {
      claudeMdContent = readFileSync(candidate, 'utf-8');
      console.log(`Loaded CLAUDE.md from: ${candidate} (${claudeMdContent.length} chars)`);
      break;
    }
  }

  // Load .mcp.json
  const mcpJsonPath = config.agent.mcp_json_path;
  if (existsSync(mcpJsonPath)) {
    try {
      const mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      if (mcpJson.mcpServers) {
        for (const [name, mcpCfg] of Object.entries(mcpJson.mcpServers) as [string, any][]) {
          if (mcpCfg.type === 'url' || mcpCfg.type === 'http') {
            mcpServersFromConfig[name] = { type: 'http', url: mcpCfg.url, headers: mcpCfg.headers };
          } else if (mcpCfg.type === 'sse') {
            mcpServersFromConfig[name] = { type: 'sse', url: mcpCfg.url, headers: mcpCfg.headers };
          } else if (!mcpCfg.type || mcpCfg.type === 'stdio') {
            mcpServersFromConfig[name] = { command: mcpCfg.command, args: mcpCfg.args, env: mcpCfg.env };
          }
        }
        console.log(`Loaded ${Object.keys(mcpServersFromConfig).length} MCP servers from .mcp.json: ${Object.keys(mcpServersFromConfig).join(', ')}`);
      }
    } catch (err) {
      console.warn('Failed to load .mcp.json:', err instanceof Error ? err.message : err);
    }
  }
}

// ---------------------------------------------------------------------------
// Persistent MCP disable list — survives between queries
// ---------------------------------------------------------------------------

function getDisabledMcpServers(): Set<string> {
  try {
    const raw = getDbConfig('mcp.disabled_servers');
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {}
  return new Set();
}

function setDisabledMcpServers(disabled: Set<string>): void {
  setDbConfig('mcp.disabled_servers', JSON.stringify([...disabled]));
}

// ---------------------------------------------------------------------------
// Dynamic MCP loading — keyword-gated to reduce token overhead (~2,000 tokens)
// ---------------------------------------------------------------------------

const CC_MCP_KEYWORDS = [
  'task', 'tasks', 'care', 'cycle', 'pet', 'pets',
  'expense', 'expenses', 'calendar', 'mood', 'wellness',
  'scratchpad', 'countdown', 'win', 'daily win',
  'list', 'lists', 'finance', 'finances', 'budget',
  'event', 'events', 'period', 'planner', 'project',
];

const MIND_MCP_KEYWORDS = [
  'remember', 'forget', 'memory', 'memories',
  'feel', 'feeling', 'mood', 'dream', 'journal', 'identity',
  'who am i', 'surface', 'orient', 'ground',
  'tension', 'resolve', 'sit with', 'pattern', 'emotion',
];

function matchesKeyword(content: string, keywords: string[]): boolean {
  const normalized = content.toLowerCase();
  return keywords.some(kw => {
    const pattern = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return pattern.test(normalized);
  });
}

function shouldIncludeCcMcp(content: string, isAutonomous: boolean): boolean {
  if (isAutonomous) return true;
  return matchesKeyword(content, CC_MCP_KEYWORDS);
}

function shouldIncludeMindMcp(content: string, isAutonomous: boolean, isFirstMessage: boolean): boolean {
  if (isAutonomous) return true;
  if (isFirstMessage) return true;
  return matchesKeyword(content, MIND_MCP_KEYWORDS);
}

function isCcMcpServer(name: string, serverConfig: McpServerConfig, ccServerName: string): boolean {
  if (ccServerName && name === ccServerName) return true;
  // Check if the URL ends with /mcp/cc
  if ('url' in serverConfig && typeof serverConfig.url === 'string') {
    return serverConfig.url.endsWith('/mcp/cc');
  }
  return false;
}

function isMindMcpServer(name: string, _serverConfig: McpServerConfig, mindServerName: string): boolean {
  if (mindServerName && name === mindServerName) return true;
  return name.toLowerCase().includes('mind');
}

function buildMcpServersForQuery(
  allServers: Record<string, McpServerConfig>,
  content: string,
  isAutonomous: boolean,
  isFirstMessage: boolean,
): Record<string, McpServerConfig> {
  const config = getResonantConfig();
  const ccServerName = config.hooks.cc_mcp_server_name || '';
  const mindServerName = config.hooks.mind_mcp_server_name || '';

  const includeCc = shouldIncludeCcMcp(content, isAutonomous);
  const includeMind = shouldIncludeMindMcp(content, isAutonomous, isFirstMessage);

  const disabled = getDisabledMcpServers();
  const filtered: Record<string, McpServerConfig> = {};
  for (const [name, serverConfig] of Object.entries(allServers)) {
    if (disabled.has(name)) {
      console.log(`[MCP] Skipping "${name}" (disabled by user)`);
      continue;
    }
    if (!includeCc && isCcMcpServer(name, serverConfig, ccServerName)) {
      console.log(`[MCP] Skipping CC MCP "${name}" (no keyword match)`);
      continue;
    }
    if (!includeMind && isMindMcpServer(name, serverConfig, mindServerName)) {
      console.log(`[MCP] Skipping Mind MCP "${name}" (no keyword match)`);
      continue;
    }
    filtered[name] = serverConfig;
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// Model resolution — checks DB config, YAML config, env, then defaults
// ---------------------------------------------------------------------------

/** Four independent model-resolution tiers. */
export type AgentModelTier = 'interactive' | 'autonomous' | 'pulse' | 'memory';

/**
 * Resolve the configured raw model string for a given tier. Honors the
 * cascade DB config > YAML config > env var > default. Returns whatever
 * the user has configured verbatim — could be a legacy bare id
 * (`claude-sonnet-4-6`), a canonical ref (`claude/claude-sonnet-4-6`), or
 * a future non-Claude ref. Normalization happens in
 * `resolveConfiguredModelRef`; SDK-boundary unwrap (which throws on
 * non-Claude refs) happens in `resolveConfiguredClaudeSdkModel`.
 *
 * Tier semantics:
 * - interactive: chat turns initiated by the user
 * - autonomous: wakes / timers / watchers / impulses (full-mode autonomous)
 * - pulse: lightweight heartbeat checks (separate cheap-model tier)
 * - memory: handoff-summary calls (PR D — used by services/handoff.ts to
 *   summarize prior conversation when a turn lands on a (runtime, provider,
 *   model_ref) combo with no prior session. Cheap + JSON-reliable model;
 *   defaults to Haiku.)
 */
function resolveConfiguredRawModel(tier: AgentModelTier): string {
  if (tier === 'pulse') {
    const dbValue = getDbConfig('agent.model_pulse');
    if (dbValue) return dbValue;
    const cfg = getResonantConfig();
    if (cfg.agent.model_pulse) return cfg.agent.model_pulse;
    return 'claude-haiku-4-5';
  }

  if (tier === 'memory') {
    const dbValue = getDbConfig('agent.model_memory');
    if (dbValue) return dbValue;
    const cfg = getResonantConfig();
    if (cfg.agent.model_memory) return cfg.agent.model_memory;
    return 'claude-haiku-4-5';
  }

  const dbKey = tier === 'autonomous' ? 'agent.model_autonomous' : 'agent.model';
  const dbValue = getDbConfig(dbKey);
  if (dbValue) return dbValue;

  const cfg = getResonantConfig();
  const yamlValue = tier === 'autonomous' ? cfg.agent.model_autonomous : cfg.agent.model;
  if (yamlValue) return yamlValue;

  if (process.env.AGENT_MODEL) return process.env.AGENT_MODEL;

  return 'claude-sonnet-4-6';
}

/**
 * Resolve the configured model for a given tier as a structured
 * `ModelRef` (provider, runtime, raw native id, canonical form).
 *
 * Accepts both legacy bare ids (`claude-sonnet-4-6`) and canonical
 * provider-qualified refs (`claude/claude-sonnet-4-6`) from config.
 * Used by call sites that need to know which runtime to dispatch to
 * (later PRs in the multi-provider arc).
 */
export function resolveConfiguredModelRef(tier: AgentModelTier): ModelRef {
  return normalizeModelRef(resolveConfiguredRawModel(tier));
}

/**
 * Resolve the configured model ID for a given tier and return the **raw
 * provider-native string** suitable for handing directly to the Claude
 * Agent SDK (`claude-sonnet-4-6`, `sonnet`, etc.). Existing call sites
 * keep their string-typed signature; the manifest's canonical refs do
 * not leak into the SDK boundary.
 *
 * **CALL THIS ONLY AT THE CLAUDE SDK BOUNDARY.** Until non-Claude
 * runtimes ship, this throws a friendly error if the configured tier
 * points at a non-Claude runtime — protects the SDK from being handed
 * something it can't execute. For call sites that aren't dispatching
 * directly to `query()` (runtime-health computing minimums, orchestrator
 * showing pulse config, settings UI), use `resolveConfiguredModelRef`
 * instead and handle non-Claude runtimes explicitly. Using this function
 * outside the SDK dispatch path turns a "switch tier in Settings"
 * recoverable state into a 500 / crashed turn.
 */
export function resolveConfiguredClaudeSdkModel(tier: AgentModelTier): string {
  return unwrapModelRefForClaudeSdk(resolveConfiguredModelRef(tier), tier);
}

// ---------------------------------------------------------------------------
// Runtime resolver (PR B1 — scaffold)
// ---------------------------------------------------------------------------

/**
 * Singleton runtime instances. Module-level so the runtime keeps any
 * connection / auth state across resolver calls (matters for non-
 * Claude runtimes in later PRs; for the Claude stub it's just here so
 * `resolveConfiguredRuntime` returns the same object each call).
 */
const claudeRuntime = new ClaudeAgentRuntime();
const codexRuntime = new CodexRuntime();

/**
 * Resolved runtime dispatch packet — what `resolveConfiguredRuntime`
 * returns. Bundles the runtime instance, the parsed model ref, and the
 * model's declared capabilities so the dispatcher doesn't have to do
 * three lookups in a row.
 */
export interface ResolvedRuntime {
  runtime: AgentRuntime;
  modelRef: ModelRef;
  capabilities: ModelCapabilities;
}

/**
 * Fallback capabilities for a model ref that isn't in the manifest
 * (operator typed a custom ref in config without registering it).
 * Conservative defaults: assume no special capabilities so UI hides
 * tool/MCP/etc. controls rather than offering features the runtime
 * can't deliver.
 */
const FALLBACK_CAPABILITIES: ModelCapabilities = {
  tools: false,
  vision: false,
  reasoning: false,
  mcp: false,
  sessionResume: false,
  fileCheckpointing: false,
};

/**
 * Resolve the configured tier to a runtime dispatch packet.
 *
 * **Current B-series status:** the only runtime wired up is
 * `claude-sdk` (via `ClaudeAgentRuntime`). The runtime owns SDK
 * `Options` assembly and the `query()` call (PR B2a); MCP loading +
 * capability methods + stream consumption + event normalization still
 * live in `_processQuery` / `AgentService` (move in PR B2b / B3).
 * `resolveConfiguredRuntime` is exposed as the future dispatch
 * entry point — once PR B3 lands `runTurn`, `_processQuery` becomes a
 * thin consumer of `runtime.runTurn()` events.
 *
 * For tiers configured with a non-Claude ref today, this throws — the
 * runtime simply doesn't exist yet. PR E (Codex runtime) is the first
 * non-Claude runtime; before then, users who want to test the
 * scaffold should keep their tiers on Claude refs.
 */
export function resolveConfiguredRuntime(tier: AgentModelTier): ResolvedRuntime {
  const modelRef = resolveConfiguredModelRef(tier);

  let runtime: AgentRuntime;
  switch (modelRef.runtime) {
    case 'claude-sdk':
      runtime = claudeRuntime;
      break;
    case 'codex':
      // PR E2: Codex runtime wired. Selecting a Codex model now
      // dispatches via CodexRuntime → pi-ai's streamOpenAICodexResponses
      // (requires a logged-in OAuth session; CodexRuntime emits
      // `auth_required` if not, which AgentService translates into a
      // friendly chat message).
      runtime = codexRuntime;
      break;
    case 'openai-compat':
    case 'ollama-native':
      throw new Error(
        `Model "${modelRef.canonical}" requires the ${modelRef.runtime} runtime, ` +
        `which is not wired up yet (planned for a later PR of the multi-provider arc). ` +
        `Switch the ${tier} tier back to a Claude model in Settings.`,
      );
    default: {
      // Exhaustiveness check — if a new RuntimeId is added to the
      // shared manifest and not handled here, TypeScript will flag this
      // assignment as an error at compile time.
      const _exhaustive: never = modelRef.runtime;
      throw new Error(`Unknown runtime "${_exhaustive}" for model "${modelRef.canonical}"`);
    }
  }

  const entry = findModelByRef(modelRef.canonical);
  const capabilities = entry?.capabilities ?? FALLBACK_CAPABILITIES;

  return { runtime, modelRef, capabilities };
}

// ---------------------------------------------------------------------------
// One-shot SDK helper (B1.5 — consolidates the rogue digest.ts import)
// ---------------------------------------------------------------------------

/**
 * One-shot Claude SDK query — for read-only, single-turn, no-tools,
 * no-session-resume callers (currently: the Scribe digest worker).
 *
 * Wraps `@anthropic-ai/claude-agent-sdk.query()` with sensible one-shot
 * defaults (`permissionMode: 'plan'`, `tools: []`, `persistSession: false`,
 * `maxTurns: 1`) and collects assistant text deltas plus a fallback to
 * the result-message string. Returns the full assembled text.
 *
 * **Why this helper exists:** before B1.5, `digest.ts` imported `query`
 * directly from `@anthropic-ai/claude-agent-sdk`. That made it a second
 * SDK touchpoint outside of `agent.ts`, which would have made the
 * runtime extraction (B-series) harder — every site that imports the
 * SDK has to be considered when the abstraction lands. Consolidating
 * the SDK surface into `agent.ts` means later B-series PRs only have
 * one runtime call site to thread through `ClaudeAgentRuntime`.
 *
 * **Why not `ClaudeAgentRuntime.runTurn` instead:** the runtime's
 * `runTurn` lands in PR B3 (normalized event bridge). Until then this
 * helper stays here for callers that need a fire-and-forget one-shot
 * without the persist/broadcast/queue machinery of `_processQuery`.
 * When B3 lands, `runOneShotQuery` can become a thin wrapper that
 * constructs an `AgentTurnInput` and dispatches through the runtime —
 * without touching `digest.ts` at all.
 *
 * `model` is the raw provider-native id (`'haiku'`, `'claude-sonnet-4-6'`).
 * Caller is responsible for unwrapping `ModelRef` → raw id before passing
 * (`unwrapModelRefForClaudeSdk` is the helper) since this function calls
 * the Claude SDK directly.
 */
export async function runOneShotQuery(opts: {
  prompt: string;
  model: string;
  systemPrompt: string;
  maxTurns?: number;
}): Promise<string> {
  let collected = '';

  // Log the one-shot model BEFORE the SDK call so callers (handoff /
  // scribe digest) can verify which model their tier resolved to.
  // Pre-PR-D this was invisible — there was no per-call log line, so
  // a misconfigured tier (e.g. Memory set to Sonnet but quietly resolving
  // to Haiku) was unfalsifiable from logs alone.
  console.log(`[Agent] OneShot: ${opts.model} (maxTurns: ${opts.maxTurns ?? 2})`);

  for await (const message of query({
    prompt: opts.prompt,
    options: {
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      // PR D smoke caught: maxTurns: 1 makes the SDK throw "Reached
      // maximum number of turns (1)" even when the model responds in
      // a single turn — the SDK seems to count "produced response +
      // checking if more iterations needed" as having used the turn.
      // Bumping default to 2 gives it slack to terminate gracefully
      // without erroring; the model still responds in 1 turn (no
      // additional cost), there's just room for the SDK to exit
      // cleanly. Caller can still override with `maxTurns: 1` if they
      // explicitly want the strict cap.
      maxTurns: opts.maxTurns ?? 2,
      permissionMode: 'plan' as any, // read-only, no tool use
      tools: [],
      persistSession: false,
    },
  })) {
    if (!message || typeof message !== 'object' || !('type' in message)) continue;
    const msg = message as any;
    // Streamed assistant content — preferred when present.
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          collected += block.text;
        }
      }
    }
    // Fallback to the result message's final string when no assistant
    // stream came through (some SDK paths don't emit assistant deltas
    // on very short one-shots).
    if (msg.type === 'result' && msg.result) {
      if (!collected) collected = msg.result;
    }
  }

  return collected;
}

// Thin wrappers for the SDK-boundary call sites in this file — delegate
// to the throwing resolver. Both wrappers run right before query() so
// the throw is contained to the dispatch path (and caught by the
// model-resolution try/catch in _processQuery for friendly fallback).
function getConfiguredModel(isAutonomous: boolean): string {
  return resolveConfiguredClaudeSdkModel(isAutonomous ? 'autonomous' : 'interactive');
}

// Pulse runs on its own model tier — heartbeat decisions are extremely
// shallow and fit Haiku's strengths. DB > YAML > default ('claude-haiku-4-5').
// Kept separate from getConfiguredModel so that the autonomous tier (used by
// wakes / impulses / watchers / timers) can stay on Sonnet while pulse drops
// to Haiku without tier-flag gymnastics.
function getConfiguredPulseModel(): string {
  return resolveConfiguredClaudeSdkModel('pulse');
}

/**
 * Get the configured thinking effort value for a given tier.
 *
 * Tier resolution rules:
 * - `'interactive'`: reads `agent.thinking_effort` (DB > YAML > 'auto').
 *   This is the historical field; semantics are unchanged for users who
 *   haven't set the autonomous override.
 * - `'autonomous'`: reads `agent.thinking_effort_autonomous` first
 *   (DB > YAML), falls back to the global `agent.thinking_effort`
 *   (DB > YAML > 'auto') when the autonomous override is unset.
 *   Back-compat: an unset autonomous override means "match chat" —
 *   identical behavior to before this field existed.
 * - Pulse never calls this — its query option is `thinking: { type: 'disabled' }`,
 *   no effort is sent.
 *
 * Returns the configured value verbatim. The actual resolution to a
 * concrete SDK effort level (handling 'auto', validating per model)
 * happens in `resolveEffortForModel()` at the call site, after the
 * tier's model has been resolved.
 */
function getConfiguredThinkingEffort(tier: 'interactive' | 'autonomous'): string {
  const cfg = getResonantConfig();

  if (tier === 'autonomous') {
    // Autonomous-specific override wins if explicitly set.
    const dbAutoValue = getDbConfig('agent.thinking_effort_autonomous');
    if (dbAutoValue) return dbAutoValue;
    const yamlAutoValue = cfg.agent.thinking_effort_autonomous;
    if (yamlAutoValue) return String(yamlAutoValue);
    // Fall through to the global value — preserves pre-PR-#10 behavior.
  }

  const dbValue = getDbConfig('agent.thinking_effort');
  if (dbValue) return dbValue;
  // Default 'auto' — see PR #8/9 commentary above.
  return cfg.agent.thinking_effort || 'auto';
}

// /recap slash command intercept. Matches `/recap` with optional trailing
// args ("/recap today only", "/recap focus on decisions") so that args are
// folded into the rewritten prompt as a focus hint instead of slipping
// through as literal slash-command text. The full rewrite happens in
// processMessage before the prompt enters the queue.
const RECAP_COMMAND_RE = /^\s*\/recap(?:\s+(.+?))?\s*$/i;
const RECAP_BASE_PROMPT = [
  'Summarize this conversation so far. Cover the key beats, decisions made, and where we are right now — 5-7 bullets, then a short "currently:" line at the end.',
  'Skip greetings, skip "happy to recap" style preambles. Lead with the recap itself.',
  'This is for the user who just walked back to their desk and wants a fast orientation. Be specific, not generic.',
].join(' ');

function buildRecapPrompt(focus: string | undefined): string {
  if (!focus) return RECAP_BASE_PROMPT;
  // Sanitize: strip surrounding quotes, collapse whitespace, cap length so
  // a wildly long focus arg can't blow out the prompt budget.
  const cleaned = focus.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!cleaned) return RECAP_BASE_PROMPT;
  return `${RECAP_BASE_PROMPT} The user asked you to focus on: ${cleaned}. Prioritize that lens while keeping the recap structured.`;
}


// Presence state
let presenceStatus: 'active' | 'dormant' | 'waking' | 'offline' = 'offline';

// Active abort controller — survives across the query lifecycle so
// `stopGeneration()` can signal cancellation regardless of which
// runtime is in flight. (Runtime owns its own provider-native query
// reference; the AbortController is the AgentService-side cross-cutting
// signal.)
// PR B2b-2: `activeQuery` + context-usage state moved into
// `ClaudeAgentRuntime` as private instance fields. AgentService
// methods that need them call `claudeRuntime.getContextUsage()` /
// `claudeRuntime.hasActiveQuery()` / etc.
let activeAbortController: AbortController | null = null;

// ---------------------------------------------------------------------------
// QueryQueue — priority-based queue replacing boolean queryLock
// Agent SDK V1 can only run one query at a time, so we queue excess requests
// ---------------------------------------------------------------------------

const PRIORITIES = {
  web_interactive: 0,    // Owner typing in UI
  discord_owner: 1,      // Owner on Discord
  discord_other: 2,      // Other users
  autonomous: 3,         // Orchestrator wakes
} as const;

const MAX_QUEUE_DEPTH = 5;
const QUEUE_TIMEOUT_MS = 90_000;

interface QueueEntry {
  priority: number;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  execute: () => Promise<string>;
  enqueuedAt: number;
}

class QueryQueue {
  private queue: QueueEntry[] = [];
  private running = false;

  get isProcessing(): boolean {
    return this.running;
  }

  get depth(): number {
    return this.queue.length;
  }

  async enqueue(priority: number, execute: () => Promise<string>): Promise<string> {
    // If idle, run immediately
    if (!this.running && this.queue.length === 0) {
      this.running = true;
      try {
        return await execute();
      } finally {
        this.running = false;
        this.processNext();
      }
    }

    // Queue is full — reject
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      const cfg = getResonantConfig();
      return `[${cfg.identity.companion_name} is busy — please try again in a moment]`;
    }

    // Enqueue with priority
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ priority, resolve, reject, execute, enqueuedAt: Date.now() });
      // Sort by priority (lower number = higher priority)
      this.queue.sort((a, b) => a.priority - b.priority);
    });
  }

  private async processNext(): Promise<void> {
    // Prune timed-out entries
    const now = Date.now();
    this.queue = this.queue.filter(entry => {
      if (now - entry.enqueuedAt > QUEUE_TIMEOUT_MS) {
        entry.resolve('[Request timed out in queue]');
        return false;
      }
      return true;
    });

    if (this.queue.length === 0) return;

    const next = this.queue.shift()!;
    this.running = true;

    try {
      const result = await next.execute();
      next.resolve(result);
    } catch (err) {
      next.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.running = false;
      this.processNext();
    }
  }
}

const queryQueue = new QueryQueue();

// PR B3: `extractThinkingSummary` moved into `runtimes/claude-sdk.ts`
// (its only caller, `runClaudeTurn`, lives there now). Duplicated as a
// small private helper in the runtime file rather than back-imported
// to avoid circular module evaluation risk between agent.ts and
// runtimes/claude-sdk.ts.

interface ThinkingInsertion {
  textOffset: number;
  content: string;
  summary: string;
  providerShape: ProviderShape;
}

/**
 * Map the resolved runtime to a thinking-segment provider shape. Single
 * source of truth for the per-provider rendering discriminant. Future
 * providers (openai-compat for OpenRouter, ollama-native for Ollama) fall
 * through to `'generic'` until a future arc carves them out individually.
 *
 * Exported for unit tests. Production callers are the two thinking_delta
 * handlers below — both compute `providerShape` ONCE and use the same
 * value for `thinkingBlocks.push` AND `registry.broadcast`, which is the
 * structural invariant that guarantees streaming and persisted thinking
 * segments agree on shape (see per-provider-rendering-spec §4, Codex's
 * T13/T14 pairing guardrail).
 */
export function resolveProviderShape(runtime: RuntimeId): ProviderShape {
  switch (runtime) {
    case 'claude-sdk': return 'claude';
    case 'codex': return 'codex';
    case 'openai-compat':
    case 'ollama-native':
      return 'generic';
  }
}

// Options for autonomous (orchestrator-driven) queries. Pulse uses these to
// run a model turn that may decide to stay silent — in that case the
// response is dropped before persist/push and the client gets a
// `stream_end { suppressed: true }` instead of a final message.
//
// streamToClient gates BOTH the stream_start and stream_token broadcasts
// for the duration of the query. It does NOT gate thinking, tool_use, or
// tool_result broadcasts; those flow through their own hook channels and
// are cleaned up frontend-side if a suppressed stream_end follows.
export interface AutonomousOpts {
  suppressIf?: (response: string) => boolean;
  streamToClient?: boolean;
  suppressedLogLabel?: string;
  orientationMode?: 'full' | 'pulse';
}

/**
 * Build the `metadata` blob persisted on a companion message. Always
 * stamps `provenance` (so the renderer can dispatch per-provider
 * components regardless of which model is active NOW); includes
 * `segments` when present. Exported for unit tests.
 *
 * Legacy companion rows that predate this arc lack `provenance` —
 * read-side coercion (normalizeThinkingSegment) defaults them to the
 * claude shape, see shared/types.ts.
 */
export function buildCompanionMessageMetadata(
  modelRef: ModelRef,
  segments: MessageSegment[],
): Record<string, unknown> {
  const provenance: MessageProvenance = {
    runtimeId: modelRef.runtime,
    providerId: modelRef.provider,
    modelRef: modelRef.canonical,
  };
  const meta: Record<string, unknown> = { provenance };
  if (segments.length > 0) meta.segments = segments;
  return meta;
}

// Build interleaved text/tool/thinking segments from response text + insertions.
// Exported for unit tests; not intended for callers outside agent.ts.
export function buildSegments(fullResponse: string, toolInsertions: ToolInsertion[], thinkingBlocks: ThinkingInsertion[] = []): MessageSegment[] {
  if (toolInsertions.length === 0 && thinkingBlocks.length === 0) return [];

  // Merge all insertions into one sorted list
  type Insertion = { textOffset: number } & (
    | { kind: 'tool'; data: ToolInsertion }
    | { kind: 'thinking'; data: ThinkingInsertion }
  );

  const allInsertions: Insertion[] = [
    ...toolInsertions.map(t => ({ textOffset: t.textOffset, kind: 'tool' as const, data: t })),
    ...thinkingBlocks.map(t => ({ textOffset: t.textOffset, kind: 'thinking' as const, data: t })),
  ].sort((a, b) => a.textOffset - b.textOffset);

  const segments: MessageSegment[] = [];
  let cursor = 0;

  for (const ins of allInsertions) {
    const offset = Math.min(ins.textOffset, fullResponse.length);
    if (offset > cursor) {
      segments.push({ type: 'text', content: fullResponse.slice(cursor, offset) });
    }
    if (ins.kind === 'tool') {
      segments.push({
        type: 'tool',
        toolId: ins.data.toolId,
        toolName: ins.data.toolName,
        input: ins.data.input,
        output: ins.data.output,
        isError: ins.data.isError,
      });
    } else {
      // Read providerShape from the insertion (set at the thinking_delta
      // capture site so it matches what we broadcast over WS). normalize-
      // ThinkingSegment picks the correct discriminated-union variant —
      // claude keeps summary, codex/generic drop it.
      segments.push(normalizeThinkingSegment({
        type: 'thinking',
        content: ins.data.content,
        providerShape: ins.data.providerShape,
        summary: ins.data.summary,
      }));
    }
    cursor = offset;
  }

  // Trailing text after last insertion
  if (cursor < fullResponse.length) {
    segments.push({ type: 'text', content: fullResponse.slice(cursor) });
  }

  return segments;
}

// Cached MCP server status (refreshed on each query, seeded from config on first access)
let cachedMcpStatus: McpServerInfo[] = [];
let mcpStatusSeeded = false;

function seedMcpStatusIfNeeded(): void {
  if (mcpStatusSeeded || cachedMcpStatus.length > 0) return;
  mcpStatusSeeded = true;
  const disabled = getDisabledMcpServers();
  cachedMcpStatus = Object.keys(mcpServersFromConfig).map(name => ({
    name,
    status: disabled.has(name) ? 'disabled' : 'pending',
    toolCount: 0,
  }));
}

export class AgentService {
  private pushService: PushService | null = null;
  // Threads with a pending /clear that should reserve the next interactive
  // turn as the fresh-session starter. Autonomous turns (watchers,
  // impulses, scheduled wakes, timer prompts, manual wakes — anything
  // that runs through processAutonomous outside of pulse mode) that
  // complete on a thread in this set still persist their message to the
  // transcript, but they do NOT update thread.current_session_id, which
  // would otherwise consume the fresh-session slot the user reserved
  // with /clear. The next user-initiated turn drains the flag.
  // In-memory by design: backend restart loses the pending state, worst
  // case is one missed clear-honoring window which the user can /clear
  // again. Pulse turns are naturally excluded by the existing
  // !isPulseOrientation guard around the session-persistence block.
  private clearPendingForThread = new Set<string>();

  setPushService(service: PushService): void {
    this.pushService = service;
  }

  getPresenceStatus(): 'active' | 'dormant' | 'waking' | 'offline' {
    return presenceStatus;
  }

  isProcessing(): boolean {
    return queryQueue.isProcessing;
  }

  /**
   * Mark a thread as having a pending /clear. Called by commands.ts
   * handleClear after the DB session-pointer reset. The next interactive
   * turn on this thread will start fresh AND drain the flag; any
   * autonomous turns that fire before that interactive turn will skip
   * the session-pointer write so they do not consume the reserved slot.
   */
  markThreadSessionClearPending(threadId: string): void {
    this.clearPendingForThread.add(threadId);
  }

  getQueueDepth(): number {
    return queryQueue.depth;
  }

  getMcpStatus(): McpServerInfo[] {
    ensureInit();
    seedMcpStatusIfNeeded();
    const disabled = getDisabledMcpServers();
    // Merge disabled state into cached status
    const status = cachedMcpStatus.map(s => ({
      ...s,
      status: disabled.has(s.name) ? 'disabled' : s.status,
    }));
    // Add any disabled servers not in cache (e.g., never connected this session)
    for (const name of disabled) {
      if (!status.find(s => s.name === name)) {
        // Check if it exists in config
        if (mcpServersFromConfig[name]) {
          status.push({ name, status: 'disabled', toolCount: 0 });
        }
      }
    }
    return status;
  }

  getContextUsage(): { tokensUsed: number; contextWindow: number } {
    // PR B2b-2: gauge state lives on the runtime now (populated by
    // its in-stream `fireContextUsageRefresh`). Public method stays
    // here so /status, /cost, and the chat-header indicator can keep
    // calling `agent.getContextUsage()` exactly as before.
    return claudeRuntime.getContextUsage();
  }

  stopGeneration(): boolean {
    if (activeAbortController) {
      activeAbortController.abort();
      return true;
    }
    return false;
  }

  async reconnectMcpServer(name: string): Promise<{ success: boolean; error?: string }> {
    // PR B2b-2: live SDK op moved to ClaudeAgentRuntime; AgentService
    // still owns the cachedMcpStatus mapping (since it merges with
    // the persistent disabled-list in `getMcpStatus`).
    const result = await claudeRuntime.reconnectMcpServerLive(name);
    if (result.error) {
      return { success: false, error: result.error };
    }
    if (result.statuses) {
      cachedMcpStatus = result.statuses.map(s => ({
        name: s.name, status: s.status as McpServerInfo['status'], error: s.error,
        toolCount: s.tools?.length ?? 0,
        tools: s.tools?.map(t => ({ name: t.name, description: t.description })),
        scope: s.scope,
      }));
    }
    return { success: true };
  }

  async toggleMcpServer(name: string, enabled: boolean): Promise<{ success: boolean; error?: string }> {
    try {
      // Check if already in desired state — prevent duplicate calls
      const disabled = getDisabledMcpServers();
      const isCurrentlyDisabled = disabled.has(name);
      if (enabled && !isCurrentlyDisabled) return { success: true }; // already enabled
      if (!enabled && isCurrentlyDisabled) return { success: true }; // already disabled

      // Persist to DB — takes effect on next query
      if (enabled) {
        disabled.delete(name);
      } else {
        disabled.add(name);
      }
      setDisabledMcpServers(disabled);

      // Update cached status immediately so UI reflects the change
      const serverInCache = cachedMcpStatus.find(s => s.name === name);
      if (serverInCache) {
        serverInCache.status = enabled ? 'pending' : 'disabled';
        if (!enabled) serverInCache.toolCount = 0;
      } else if (!enabled) {
        // Server not in cache yet (never connected) — add it as disabled
        cachedMcpStatus.push({ name, status: 'disabled', toolCount: 0 });
      }

      // PR B2b-2: live SDK toggle moves through the runtime. Returns
      // `{}` when there's no active query (next turn will pick up the
      // DB-persisted preference); returns `{ statuses }` on success
      // for cache refresh.
      const liveResult = await claudeRuntime.toggleMcpServerLive(name, enabled);
      if (liveResult.statuses) {
        cachedMcpStatus = liveResult.statuses.map(s => ({
          name: s.name, status: s.status as McpServerInfo['status'], error: s.error,
          toolCount: s.tools?.length ?? 0,
          tools: s.tools?.map(t => ({ name: t.name, description: t.description })),
          scope: s.scope,
        }));
      }

      // Re-enabling requires a fresh session to fully reconnect SDK-managed servers.
      // Clear all active sessions so the next message starts clean. PR C: also
      // wipe the per-provider sidecar — `resumeSessionId` prefers sidecar rows
      // over `threads.current_session_id`, so leaving them in place would let
      // the next turn immediately re-resume the very session this path is
      // trying to clear (defeats the "force MCP reconnect" intent).
      if (enabled) {
        try {
          clearAllThreadSessions();
          const sidecarCleared = clearAllProviderSessions();
          console.log(`[MCP] Cleared sessions to force MCP reconnect on next message (legacy pointers + ${sidecarCleared} sidecar rows)`);
        } catch { /* best-effort */ }
      }

      console.log(`[MCP] ${name} ${enabled ? 'enabled' : 'disabled'} (persistent)`);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async rewindFiles(userMessageId: string, dryRun?: boolean): Promise<{ canRewind: boolean; filesChanged?: string[]; insertions?: number; deletions?: number; error?: string }> {
    // PR B2b-2: moved to ClaudeAgentRuntime.rewindFiles. Public method
    // stays as a pass-through so the WebSocket route handler in
    // ws/events.ts keeps working unchanged.
    return claudeRuntime.rewindFiles(userMessageId, dryRun);
  }

  async listSessions(limit = 50): Promise<unknown[]> {
    ensureInit();
    // PR B2b-1: moved to ClaudeAgentRuntime.listSessions. AgentService
    // method stays as the public API surface (routes call `agent.listSessions`)
    // but the SDK call lives in the runtime now.
    return claudeRuntime.listSessions(AGENT_CWD, limit);
  }

  async processMessage(threadId: string, content: string, threadMeta?: { name: string; type: 'daily' | 'named' }, opts?: {
    platform?: 'web' | 'discord' | 'telegram' | 'api';
    platformContext?: string;
  }): Promise<string> {
    // /recap intercept — rewrite the literal slash command into a curated
    // summary instruction before queuing. Keeps the user-facing affordance
    // tight ("recap" is one word, easy to type) while making the model's
    // behavior deterministic instead of relying on whichever speaker
    // happens to interpret the slash command first. Supports optional args
    // ("/recap focus on decisions") that get folded in as a focus hint.
    const recapMatch = content.match(RECAP_COMMAND_RE);
    if (recapMatch) {
      content = buildRecapPrompt(recapMatch[1]);
    }

    // Determine priority based on platform
    const platform = opts?.platform || 'web';
    let priority: number;
    if (platform === 'web') {
      priority = PRIORITIES.web_interactive;
    } else if (platform === 'telegram') {
      // Telegram is owner-only — always high priority
      priority = PRIORITIES.discord_owner;
    } else if (platform === 'discord') {
      // Check if it's the owner by inspecting platformContext
      // Discord messages from the owner get higher priority
      const isOwner = opts?.platformContext?.includes('owner');
      priority = isOwner ? PRIORITIES.discord_owner : PRIORITIES.discord_other;
    } else {
      priority = PRIORITIES.web_interactive;
    }

    return queryQueue.enqueue(priority, async () => {
      presenceStatus = 'waking';
      registry.broadcast({ type: 'presence', status: 'waking' });
      return this._processQuery(threadId, content, false, threadMeta, opts);
    });
  }

  async processAutonomous(threadId: string, prompt: string, opts: AutonomousOpts = {}): Promise<string> {
    return queryQueue.enqueue(PRIORITIES.autonomous, async () => {
      return this._processQuery(threadId, prompt, true, undefined, undefined, opts);
    });
  }

  private async _processQuery(threadId: string, content: string, isAutonomous = false, threadMeta?: { name: string; type: 'daily' | 'named' }, platformOpts?: { platform?: 'web' | 'discord' | 'telegram' | 'api'; platformContext?: string }, autonomousOpts: AutonomousOpts = {}): Promise<string> {
    ensureInit();
    const thread = getThread(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);

    const cfg = getResonantConfig();
    const isPulseOrientation = autonomousOpts.orientationMode === 'pulse';

    // Stream message placeholder
    const streamMsgId = crypto.randomUUID();

    // Response and tool tracking (declared early so hookContext can reference)
    let safetyTimeout: ReturnType<typeof setTimeout> | undefined;
    const MAX_RESPONSE_LENGTH = 200_000; // ~50k tokens
    let fullResponse = '';
    let responseTruncated = false;
    // PR #11 / chip #38: track compaction in-flight from the moment the
    // PreCompact hook fires (banner-show signal) through the
    // `compact_boundary` message (banner-hide signal). The flag lives at
    // this scope (rather than inside the stream-loop block lower down)
    // so the hookContext below can capture it via the onCompactionStart
    // callback. Bot review on PR #11 caught the race window: PreCompact
    // fires earlier than the SDK's `system: compacting` message, so
    // setting the flag only on the latter could miss aborts in between.
    let isCompactionInProgress = false;
    const toolInsertions: ToolInsertion[] = [];
    const thinkingBlocks: ThinkingInsertion[] = [];
    // PR B3: `currentThinkingAccum` (the per-content-block thinking
    // text buffer) moved into `runClaudeTurn`. The runtime accumulates
    // deltas internally and emits a single `thinking_delta` event with
    // the full block text + summary at `content_block_stop`.

    // Build hook context
    const platform = platformOpts?.platform || 'web';
    const hookContext: HookContext = {
      threadId,
      threadName: threadMeta?.name ?? thread.name,
      threadType: threadMeta?.type ?? thread.type,
      streamMsgId,
      isAutonomous,
      registry,
      sessionId: thread.current_session_id || null,
      platform,
      platformContext: platformOpts?.platformContext,
      toolInsertions,
      getTextLength: () => fullResponse.length,
      // PR #11 / chip #38: PreCompact hook calls this the moment it
      // broadcasts the in-progress banner. Closes the race window where
      // an abort could fire between the hook and the SDK's first
      // `system: compacting` message and miss the cleanup.
      onCompactionStart: () => { isCompactionInProgress = true; },
    };

    // First message of this session — include static orientation content (tools, skills, vault)
    const isFirstMessage = !thread.current_session_id;

    // Build query options — V1 API (full config support)
    // Three-tier model: pulse uses its own (Haiku by default), autonomous wakes
    // use the autonomous tier, interactive queries use the primary tier.
    // Interactive + autonomous resolve via DB > YAML > env var > default.
    // Pulse resolves via DB > YAML > default (no env var; pulse is narrow
    // enough that operator config doesn't need a third override path).
    //
    // Wrapped: getConfigured*Model() reach `resolveConfiguredClaudeSdkModel`,
    // which throws when the configured tier points at a non-Claude runtime
    // (which has no implementation yet). Catching here so a misconfigured
    // tier surfaces as a friendly inline error instead of crashing the
    // turn / being swallowed by the outer generic handler.
    //
    // On failure: pulse returns the literal `PULSE_OK` (which
    // `isSuppressiblePulseResponse` already matches, so pulse stays
    // silent AND skips the orchestrator's post-pulse activity bump).
    // Interactive/autonomous emit the friendly message through the same
    // persist+broadcast machinery the normal inner SDK-error catch
    // (line 1271 region) uses — without this, the early return would
    // skip stream_start / createMessage / stream_end and the user would
    // just see... nothing.
    const tier = isPulseOrientation ? 'pulse' : (isAutonomous ? 'autonomous' : 'interactive');
    let model: string;
    let modelRef: ModelRef;
    try {
      if (isPulseOrientation) {
        // Pulse stays Claude-only (Codex not in pulse tier hints; pulse
        // PULSE_OK reliability requires Haiku-class). `getConfiguredPulseModel`
        // throws if the configured pulse model is non-Claude.
        model = getConfiguredPulseModel();
        modelRef = normalizeModelRef(model);
      } else {
        // PR E2: don't unwrap-to-Claude here. Resolve the canonical
        // model ref, then guard that the runtime is wired up. Codex now
        // flows through; non-Claude/non-Codex runtimes (ollama-native,
        // openai-compat) still throw the friendly "not wired up" error.
        modelRef = resolveConfiguredModelRef(isAutonomous ? 'autonomous' : 'interactive');
        if (modelRef.runtime !== 'claude-sdk' && modelRef.runtime !== 'codex') {
          throw new Error(
            `Model "${modelRef.canonical}" requires the ${modelRef.runtime} runtime, ` +
            `which is not wired up yet. Switch the ${isAutonomous ? 'autonomous' : 'interactive'} ` +
            `tier back to a Claude or Codex model in Settings.`,
          );
        }
        model = modelRef.model;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const friendly = `⚠️ Model configuration error (${tier} tier): ${message}`;
      console.warn(`[Agent] Model resolution failed for ${tier} tier: ${message}`);

      // Pulse: silent + suppress activity bump via the existing pulse
      // suppression path (orchestrator.checkPulse checks the response
      // through isSuppressiblePulseResponse before bumping activity).
      if (isPulseOrientation) return 'PULSE_OK';

      // Non-pulse: persist as a real companion message + broadcast through
      // the normal chat/Discord/Telegram surfaces so the user can see and
      // act on it. Mirrors the shape of the SDK-error catch + persist
      // sequence further down in this function.
      if (autonomousOpts.streamToClient !== false) {
        registry.broadcast({ type: 'stream_start', messageId: streamMsgId, threadId });
      }
      const companionMessage = createMessage({
        id: streamMsgId,
        threadId,
        role: 'companion',
        content: friendly,
        contentType: 'text',
        platform,
        createdAt: new Date().toISOString(),
      });
      if (autonomousOpts.streamToClient !== false) {
        registry.broadcast({ type: 'stream_end', messageId: streamMsgId, final: companionMessage });
      }
      presenceStatus = 'dormant';
      registry.broadcast({ type: 'presence', status: 'dormant' });
      return friendly;
    }
    // PR E2: `modelRef` is now resolved inside the model-resolution try
    // block above (covers both Claude path via `normalizeModelRef(model)`
    // and Codex path via `resolveConfiguredModelRef(tier)`), so the
    // finally block's session-bookkeeping below can still read it.

    // Effort resolves AFTER model selection so `auto` can pick the right
    // value per model class (high for Opus/Sonnet, medium for Haiku).
    // Pulse short-circuits to 'low' because it doesn't actually use
    // thinking (`thinking: { type: 'disabled' }` below) — the value is
    // just for the log line.
    // Tier-aware lookup (PR #10): autonomous reads `thinking_effort_autonomous`
    // when set, falls back to global `thinking_effort` otherwise. Lets users
    // run Chat on Opus + Max while Autonomous stays on Sonnet + a valid level.
    const configuredEffort = isPulseOrientation
      ? 'low'  // unused; pulse path passes thinking: disabled
      : getConfiguredThinkingEffort(isAutonomous ? 'autonomous' : 'interactive');
    // Provider-mismatch safety belt: when autonomous "Match Chat" lets a
    // chat-tier effort bleed into an autonomous turn whose model lives on
    // a different provider (chat = Codex with `none`, autonomous =
    // Claude), the inherited value can be invalid for the dispatch
    // model. Coerce the configured value to the resolved model's
    // provider — `auto` is the safe fallback that `resolveEffortForModel`
    // then turns into a sensible per-model-class default.
    const coercedEffort = isPulseOrientation
      ? 'low'
      : coerceEffortForProvider(modelRef.provider, configuredEffort);
    const effectiveEffort = isPulseOrientation
      ? 'low'
      : resolveEffortForModel(model, coercedEffort);
    console.log(`[Agent] Model: ${model} (${tier}, effort: ${effectiveEffort})`);

    // Tool-behavior rule prepended to the system prompt. Lives here
    // rather than in CLAUDE.md so the personal persona file stays
    // untouched. Keep this short — long tool rules pull focus from the
    // companion's voice.
    const subagentModelChoices = MODELS
      .filter((model) => model.id.startsWith('claude-'))
      .map((model) => model.minClaudeCodeVersion
        ? `${model.id} (${model.label}, CC ${model.minClaudeCodeVersion}+)`
        : `${model.id} (${model.label})`)
      .join(', ');

    const TOOL_BEHAVIOR_RULES = [
      '## Tool behavior',
      '',
      'When using the Write tool to save user-facing content (scripts, stories, notes, markdown, ElevenLabs scripts, personal writing), default to the `shared/` folder relative to the project root. Example: `shared/elevenlabs-april-19.md`, not `elevenlabs-april-19.md`.',
      '',
      'Repo-root writes are appropriate only for files that genuinely belong at the root (package.json, README, config, test artifacts explicitly requested). When unsure, prefer `shared/`.',
      '',
      'If the Voice tool returns an error indicating it is unavailable / not configured, send your intended message as a normal chat reply instead. Do NOT improvise by creating a canvas, writing a markdown file, or any other persistence-based workaround for what was meant to be a voice note — a regular chat message is the correct fallback.',
      '',
      `Subagent presets are reusable helper workflows stored in \`.claude/agents/*.md\`. If the user asks to save a workflow as a subagent preset, usually draft the preset first (name, description, pinned model, helper instructions), suggest workflow-specific improvements, and ask for approval before writing the file. If the user explicitly says to create/save/update it now, create or update the Markdown file there. Prefer these pinned model IDs over aliases: ${subagentModelChoices}. When the user names a specific model version such as Sonnet 4.6 or Opus 4.7, use the matching pinned \`claude-*\` ID rather than the family alias. The \`/subagents\` command lists available pinned model choices and saved presets.`,
    ].join('\n');

    const appendText = claudeMdContent
      ? `${TOOL_BEHAVIOR_RULES}\n\n${claudeMdContent}`
      : TOOL_BEHAVIOR_RULES;

    const pulseSystemPrompt = [
      `You are ${cfg.identity.companion_name}, running a lightweight internal pulse check for ${cfg.identity.user_name}.`,
      'Your default behavior is silence: output exactly PULSE_OK unless there is a specific, concrete reason to interrupt now.',
      'Do not greet, narrate availability, acknowledge the check, or use tools. If you do reach out, be brief and name the concrete reason first.',
    ].join('\n');

    // SDK options assembly + the query() call moved into
    // `ClaudeAgentRuntime.dispatchClaudeQuery` in PR B2a. Inputs to that
    // method are constructed below (after orientation + history are
    // built); the dispatch call itself happens inside the outer try
    // block alongside the abort/timeout setup.

    if (autonomousOpts.streamToClient !== false) {
      registry.broadcast({
        type: 'stream_start',
        messageId: streamMsgId,
        threadId,
      });
    }

    let sessionId: string | null = null;

    try {
      presenceStatus = 'active';
      registry.broadcast({ type: 'presence', status: 'active' });

      if (!isPulseOrientation) {
        // Write thread ID for CLI tool integration (only if cwd dir exists)
        try {
          const threadFilePath = join(cfg.agent.cwd, '.resonant-thread');
          if (existsSync(cfg.agent.cwd)) {
            writeFileSync(threadFilePath, threadId);
          }
        } catch {}
      }

      // PR C: resolve the resume session id from the per-provider sidecar
      // table first; fall back to `threads.current_session_id` ONLY for
      // genuinely pre-PR-C threads (no sidecar rows yet). Pulse never
      // resumes (`persistSession: false`).
      //
      // Hoisted above the handoff/orientation block (PR D) because the
      // handoff builder uses `resumeSessionId` as a skip condition — if
      // a session resumed cleanly, the new combo has native continuity
      // and a handoff packet would just duplicate context.
      //
      // Codex bot catch on PR #16: the legacy fallback was originally
      // gated on `runtime === 'claude-sdk' && thread.current_session_id`
      // alone, which fired whenever the exact (runtime, provider,
      // model_ref) lookup missed — including normal model switches.
      // A thread mid-Sonnet-session that switched to Opus would have
      // NO Opus sidecar row, fall through to `thread.current_session_id`,
      // and resume the Sonnet session under Opus — defeating per-model
      // isolation and risking incompatible context.
      //
      // The fix: gate the fallback on `!hasProviderSessionsForThread()`
      // too. Once a thread has ANY sidecar row, the sidecar is
      // authoritative; a missing exact-key means "this combo has no
      // session yet" (fresh start), NOT "fall back to the old single
      // pointer." Pre-PR-C threads (zero sidecar rows + legacy pointer)
      // still resume cleanly on their first post-migration Claude turn,
      // and the finally block then writes the first sidecar row so
      // subsequent turns hit the sidecar path directly.
      const resumeSessionId = isPulseOrientation
        ? undefined
        : (() => {
            const providerSession = getProviderSession({
              threadId: thread.id,
              runtimeId: modelRef.runtime,
              provider: modelRef.provider,
              modelRef: modelRef.canonical,
            });
            if (providerSession) return providerSession.session_id;
            if (
              modelRef.runtime === 'claude-sdk' &&
              thread.current_session_id &&
              !hasProviderSessionsForThread(thread.id)
            ) {
              return thread.current_session_id;
            }
            return undefined;
          })();

      // Build orientation context (thread, time, gap, status, vault)
      // Prepended to prompt because SessionStart hooks don't fire in V1 query()
      // Static content (CHAT TOOLS, skills, vault path) only on first message of session
      const orientation = isPulseOrientation
        ? buildPulseOrientationContext(hookContext)
        : await buildOrientationContext(hookContext, isFirstMessage, content);

      // On fresh sessions (e.g. after model swap), inject recent message history
      // so the new model has conversational context instead of starting blind
      let historyBlock = '';
      if (!isPulseOrientation && isFirstMessage) {
        const recentMessages = getMessages({ threadId, limit: 10 });
        if (recentMessages.length > 0) {
          const historyLines = recentMessages.map((m, i) => {
            const role = m.role === 'user' ? cfg.identity.user_name : cfg.identity.companion_name;
            // Last 3 messages get full content (most likely to be referenced after model swap)
            // Older messages get truncated to save tokens
            const isRecent = i >= recentMessages.length - 3;
            const maxLen = isRecent ? 5000 : 500;
            const preview = m.content.length > maxLen ? m.content.slice(0, maxLen) + '...' : m.content;
            return `${role}: ${preview}`;
          });
          historyBlock = `\n[Recent Conversation]\n${historyLines.join('\n')}\n[/Recent Conversation]\n`;
        }
      }

      // PR D: ProviderHandoff — when a turn lands on a (runtime, provider,
      // model_ref) combo with no prior session AND the thread has prior
      // assistant messages, bridge the gap with a memory-tier summary +
      // last-N messages packet. Without this, switching from Sonnet to
      // Opus mid-thread leaves Opus starting blind on its first turn.
      //
      // Skip conditions:
      //  - Pulse turns (no continuity needed; pulse is one-shot).
      //  - A session was successfully resumed (`resumeSessionId` truthy —
      //    the native session is the source of continuity, prepending
      //    handoff text would just duplicate context the model already
      //    has).
      //  - `/clear` was just used for this thread (`clearPendingForThread`
      //    holds the marker) — user explicitly asked for a fresh start;
      //    handoff would fight that intent.
      //  - Internal: `buildProviderHandoff` itself returns null when the
      //    thread has no prior assistant messages (fresh thread).
      let handoffBlock = '';
      // PR E2 fix: hoist the typed handoff packet itself so the Codex
      // dispatch branch below can pass it through to CodexRuntime's
      // `input.handoff` field. Pre-fix this PR set
      // `codexHandoff = handoffBlock ? undefined : undefined` (a
      // placeholder Codex bot caught) — Codex turns silently skipped
      // the memory-tier summary bridge. With this hoist, Claude →
      // Codex switches get the same handoff narrative Claude → Claude
      // switches get.
      let handoff: ProviderHandoff | null = null;
      const clearPendingForHandoff = this.clearPendingForThread.has(threadId);
      if (!isPulseOrientation && !resumeSessionId && !clearPendingForHandoff) {
        try {
          // Memory tier is its own resolver tier — defaults to Haiku, can
          // be overridden in Settings → Model picker for users who want
          // richer summaries. Uses `resolveConfiguredClaudeSdkModel` so
          // canonical/legacy refs both work, and the SDK-boundary guard
          // catches misconfigured non-Claude tiers cleanly (handoff just
          // falls back to extractive in that case via the cascade in
          // `services/handoff.ts`).
          let memoryTierModel: string;
          try {
            memoryTierModel = resolveConfiguredClaudeSdkModel('memory');
          } catch {
            // Non-Claude memory tier configured but runtime not wired
            // yet → use Haiku default for the summary call rather than
            // failing the whole turn. The extractive fallback will fire
            // if the SDK call itself errors.
            memoryTierModel = 'claude-haiku-4-5';
          }

          // PR D Codex nit: pass fromModelRef so the rendered handoff
          // can name the previous combo ("handoff from claude/claude-sonnet-4-6
          // to claude/claude-opus-4-7"). Read the most-recent sidecar row
          // for this thread; if there isn't one, the field stays undefined
          // and `renderProviderHandoffAsPrompt` omits the hint cleanly.
          const priorSessions = listProviderSessionsForThread(thread.id);
          const fromModelRef = priorSessions[0]?.model_ref;

          handoff = await buildProviderHandoff({
            thread,
            targetRuntime: modelRef.runtime,
            targetProvider: modelRef.provider,
            targetModelRef: modelRef.canonical,
            fromModelRef,
            memoryTierModel,
            // Dependency-inject the summarizer so handoff.ts doesn't
            // import agent.ts (avoids a circular import). The shape
            // matches `runOneShotQuery` directly; the wrap is so the
            // contract documented in SummarizeFn ("never throws") can
            // be enforced — wrap any SDK throw as empty string so the
            // cascade falls through to extractive cleanly.
            summarize: async (sumOpts) => {
              try {
                return await runOneShotQuery(sumOpts);
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.warn(`[Handoff] memory-tier SDK call threw: ${errMsg}`);
                return '';
              }
            },
            identityCompanionName: cfg.identity.companion_name,
            identityUserName: cfg.identity.user_name,
          });

          if (handoff) {
            handoffBlock = '\n' + renderProviderHandoffAsPrompt(handoff) + '\n';
            console.log(
              `[Handoff] ${handoff.summarySource} summary (${handoff.summary.length} chars), ` +
              `${handoff.recentMessages.length} recent messages, ` +
              `~${handoff.totalTokensApprox} tokens, target=${handoff.toModelRef}`,
            );
          }
        } catch (err) {
          // Defensive: handoff failures must never block a turn. Log and
          // proceed without a packet — the new combo will start blind on
          // its first turn (same as pre-PR-D behavior).
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[Handoff] build failed, proceeding without packet: ${errMsg}`);
        }
      }

      const enrichedPrompt = `[Context]\n${orientation}\n[/Context]${handoffBlock}${historyBlock}\n\n${content}`;

      // Abort controller for stop_generation support + safety timeout.
      // Passed into `dispatchClaudeQuery` (which wires it onto the SDK
      // Options) rather than set directly here — the runtime owns
      // option assembly as of PR B2a.
      activeAbortController = new AbortController();
      // Fallback matches the config default — see PR #11 / chip #38
      // for why this bumped from 300s to 1200s (compaction + Opus 4.7
      // tool-loop turns ran past the old cap).
      const timeoutMs = getResonantConfig().agent.query_timeout_ms || 1200000;
      safetyTimeout = setTimeout(() => {
        console.warn(`[Agent] Query timed out after ${timeoutMs / 1000}s, aborting`);
        activeAbortController?.abort();
      }, timeoutMs);

      // PR B3: SDK call site + stream consumption both live on the
      // runtime now. `claudeRuntime.runClaudeTurn` internally calls
      // `dispatchClaudeQuery` (still does the Options assembly) and
      // iterates the resulting Query, yielding normalized
      // `AgentRuntimeEvent`s instead of raw SDK message shapes.
      // AgentService consumes those events below; the post-dispatch
      // MCP enforce/refresh dance hangs off the `start` event handler
      // (fires once the runtime's activeQuery is populated).
      //
      // `modelRef` is hoisted to the outer scope (declared right after
      // model resolution) so the finally block can use it for sidecar
      // writes.

      // PR D: `resumeSessionId` is now resolved earlier in the try block
      // (right after the thread-file write) so the handoff packet's
      // skip-condition can read it. See the hoisted block above.

      // PR B2b-2: `fireContextUsageRefresh` closure + dedup state
      // (`pendingContextRefresh`, `lastReportedTokens`) + the
      // `contextTokensUsed` / `contextWindowSize` mutation now live in
      // `ClaudeAgentRuntime.fireContextUsageRefresh`. AgentService
      // passes the broadcast + log callback so the runtime stays free
      // of `registry` / `console.log` formatting coupling.
      const fireContextUsageRefresh = () => {
        claudeRuntime.fireContextUsageRefresh(({ used, window, percentage, model }) => {
          console.log(`Context usage: ${used} / ${window} (${percentage}%) [${model}]`);
          registry.broadcast({
            type: 'context_usage',
            percentage,
            tokensUsed: used,
            contextWindow: window,
          });
        });
      };

      // PR E2: dispatcher branches on resolved runtime. Claude path is
      // unchanged from PR B3 (~200 lines of event handler below). Codex
      // path is a parallel, simpler handler in `dispatchCodexTurn`
      // below — no MCP, no compaction, no Claude-specific context usage,
      // and `auth_required` translates to a friendly chat-visible
      // message instead of bubbling raw error text. Both paths share
      // the same outer try/catch + finally, so session bookkeeping +
      // sidecar writes happen for both via the existing
      // `setProviderSession` call in finally.
      if (modelRef.runtime === 'codex') {
        // Codex history is rebuilt from DB each turn (pi-ai's
        // openai-codex-responses provider is stateless — sends full
        // `input: messages` array each request, doesn't chain via
        // previous_response_id). 30-message window matches what we
        // send to a fresh Claude session via the historyBlock.
        // getMessages already returns chronological order (oldest -> newest).
        // Codex replays the full message array each turn, so preserving this
        // order is load-bearing: newest-first replay makes old scene anchors
        // look current to the model.
        // PR E3a: history construction (DB → normalized + image extraction
        // + synthetic-prompt append + image bridge to synthetic) factored
        // into `buildCodexNormalizedMessages`. Pure function, fully unit
        // tested in `codex-history.test.ts`. Comments inside that helper
        // explain the load-bearing synthetic + image-bridge behavior.
        const dbMessages = getMessages({ threadId, limit: 30 });
        const codexHistory = buildCodexNormalizedMessages({
          dbMessages,
          currentContent: content,
          nowIso: new Date().toISOString(),
          // Suppresses tail-image bridging + in-flight fallback
          // annotation when the synthetic is a pulse/wake prompt
          // rather than a synthesized form of the user's message.
          isAutonomous,
        });
        const normalizedMessages: NormalizedMessage[] = codexHistory.messages;
        if (codexHistory.fallbackNotices.length > 0) {
          console.warn(
            `[Codex] image attachment fallbacks (${codexHistory.fallbackNotices.length}):`,
            codexHistory.fallbackNotices.map((f) => `${f.fileId} -> ${f.reason}`),
          );
          // PR E3a.5 — surface each fallback to the UI as well as the
          // log so the user can see WHICH image got dropped and why,
          // not just discover the silent absence after the model's
          // response lands. Frontend renders an inline pill near the
          // message keyed by `ownerMessageId`.
          for (const notice of codexHistory.currentTurnFallbackNotices) {
            registry.broadcast({
              type: 'attachment_warning',
              messageId: notice.ownerMessageId,
              fileId: notice.fileId,
              filename: notice.filename,
              reason: notice.reason,
            });
          }
        }

        // System prompt folds CLAUDE.md + tool rules + orientation into
        // one block. Codex doesn't have a system-vs-developer-vs-user
        // distinction we care about, and pi-ai's openai-codex-responses
        // takes a single systemPrompt field.
        const systemPromptText = `${appendText}\n\n[Context]\n${orientation}\n[/Context]`;

        // Handoff packet — built earlier in the dispatcher. Claude path
        // consumes the rendered text via `handoffBlock` (prepended to
        // the enriched prompt). Codex path gets the typed packet
        // directly — CodexRuntime renders it as a system-note prefix
        // (see `handoffNote` in runtimes/codex.ts). This is the bridge
        // that lets a Claude → Codex switch carry the memory-tier
        // summary cleanly. `handoff` is `null` when there's no prior
        // assistant turn, when a session resumed cleanly, or when
        // /clear was just used — all the same skip conditions the
        // Claude path respects.
        const codexHandoff = handoff ?? undefined;

        const codexInput: AgentTurnInput = {
          thread,
          tier: isAutonomous ? 'autonomous' : 'interactive',
          modelRef,
          platform,
          isAutonomous,
          orientation,
          systemPrompt: { kind: 'text', value: systemPromptText },
          messages: normalizedMessages,
          handoff: codexHandoff,
          sessionId: resumeSessionId ?? undefined,
          cwd: AGENT_CWD,
          thinkingEffort: effectiveEffort,
          abortSignal: activeAbortController.signal,
        };

        try {
          for await (const event of codexRuntime.runTurn(codexInput)) {
            if (event.type === 'start') continue;
            if (event.type === 'session') {
              if (event.sessionId !== sessionId) {
                sessionId = event.sessionId;
                hookContext.sessionId = sessionId;
              }
              continue;
            }
            if (event.type === 'text_delta') {
              // pi-ai gives true deltas — concatenate, don't join with newlines
              // (the Claude path joins with `\n\n` because Claude SDK emits
              // discrete assistant messages; pi-ai emits chunked tokens).
              if (!responseTruncated) {
                fullResponse += event.text;
                if (fullResponse.length > MAX_RESPONSE_LENGTH) {
                  fullResponse = fullResponse.slice(0, MAX_RESPONSE_LENGTH) + '\n[Response truncated due to length]';
                  responseTruncated = true;
                }
                if (autonomousOpts.streamToClient !== false) {
                  registry.broadcast({
                    type: 'stream_token',
                    messageId: streamMsgId,
                    token: fullResponse,
                  });
                }
              }
              continue;
            }
            if (event.type === 'thinking_delta') {
              // INVARIANT (Codex T13/T14 pairing): compute providerShape
              // ONCE and use the same value for both `thinkingBlocks.push`
              // (persistence path) and `registry.broadcast` (streaming
              // path). Single source = streaming and persisted segments
              // cannot disagree on shape.
              const providerShape = resolveProviderShape(modelRef.runtime);
              thinkingBlocks.push({
                textOffset: fullResponse.length,
                content: event.text,
                summary: event.summary ?? '',
                providerShape,
              });
              registry.broadcast({
                type: 'thinking',
                content: event.text,
                summary: event.summary ?? '',
                providerShape,
              });
              continue;
            }
            if (event.type === 'auth_required') {
              // Friendly chat-visible message. Set as the response so
              // the standard persistence + broadcast pipeline turns it
              // into a normal companion turn. User sees actionable text
              // instead of a stack trace; clicking Settings → System
              // → Codex (ChatGPT) OAuth re-logs them in.
              fullResponse =
                `Codex needs you to log in again — head to **Settings → System → Codex (ChatGPT) OAuth** ` +
                `and click **Login to Codex**. Once you're signed back in, send your message again.`;
              console.warn(`[Codex] auth_required: ${event.message}`);
              continue;
            }
            if (event.type === 'rate_limit') {
              const retryHint = event.retryAfterMs
                ? ` (retry in ~${Math.ceil(event.retryAfterMs / 1000)}s)`
                : '';
              console.warn(`[Codex] rate-limited${retryHint}`);
              registry.broadcast({
                type: 'rate_limit',
                status: 'rate_limited',
                resetsAt: (event.retryAfterMs
                  ? (Date.now() + event.retryAfterMs) / 1000
                  : undefined) as unknown as number | undefined,
                rateLimitType: 'codex',
                utilization: undefined,
              });
              continue;
            }
            if (event.type === 'provider_diagnostic') {
              console.log(`[Codex diagnostic ${event.code}] ${event.message}`);
              continue;
            }
            if (event.type === 'tool_start') {
              // PR E3b/5: Codex loop driver emits tool_start before
              // dispatch. Mirror the Claude path's PreToolUse-hook
              // pattern: capture insertion at current text offset
              // (interleaves the tool card inline with model text in
              // the rendered transcript) AND broadcast a `tool_use`
              // WS frame so the live UI shows "calling tool..." right
              // away. Input is JSON-stringified to a compact summary —
              // matches the shape the Claude-path tool insertions use.
              const textOffset = fullResponse.length;
              let inputSummary: string;
              try {
                inputSummary = JSON.stringify(event.input);
              } catch {
                inputSummary = String(event.input);
              }
              toolInsertions.push({
                textOffset,
                toolId: event.id,
                toolName: event.name,
                input: inputSummary,
              });
              // Same cap as the Claude path (hooks.ts MAX_TOOL_INSERTIONS).
              if (toolInsertions.length > 50) {
                toolInsertions.splice(0, toolInsertions.length - 50);
              }
              registry.broadcast({
                type: 'tool_use',
                toolId: event.id,
                toolName: event.name,
                input: inputSummary,
                isComplete: false,
                textOffset,
              });
              continue;
            }
            if (event.type === 'tool_result') {
              // Mirror the Claude path's PostToolUse-hook pattern:
              // find the matching insertion by toolId and complete it
              // with output + isError so buildSegments renders the
              // full call/result pair at the right offset. Broadcast
              // a `tool_result` frame so the live UI updates the
              // card from "calling..." to its final state.
              const insertion = toolInsertions.find(
                (t) => t.toolId === event.id,
              );
              if (insertion) {
                const outputStr =
                  typeof event.output === 'string'
                    ? event.output
                    : (() => {
                        try { return JSON.stringify(event.output); }
                        catch { return String(event.output); }
                      })();
                insertion.output = outputStr;
                insertion.isError = event.isError ?? false;
              }
              registry.broadcast({
                type: 'tool_result',
                toolId: event.id,
                output:
                  typeof event.output === 'string'
                    ? event.output
                    : (() => {
                        try { return JSON.stringify(event.output); }
                        catch { return String(event.output); }
                      })(),
                isError: event.isError ?? false,
              });
              continue;
            }
            if (event.type === 'tool_progress') {
              registry.broadcast({
                type: 'tool_progress',
                toolId: event.toolId,
                toolName: event.toolName,
                elapsed: event.elapsedSeconds,
              });
              continue;
            }
            if (event.type === 'done') {
              if (event.finishReason === 'aborted') {
                console.log('[Agent] Codex generation stopped by user');
                registry.broadcast({ type: 'generation_stopped' });
              }
              continue;
            }
            if (event.type === 'error') {
              console.error('[Codex] error:', event.message);
              if (!event.recoverable) {
                fullResponse = fullResponse || `[Codex error: ${event.message}]`;
              }
              continue;
            }
            // usage, text_snapshot, compaction_notice, suppressed —
            // not emitted by CodexRuntime today (no compaction, no
            // snapshot mode, usage handled via session-end path).
            // Quietly ignore.
          }
        } catch (error) {
          // Same safety-net catch as the Claude path — runtime SHOULD
          // emit error/done events instead of throwing, but defense in
          // depth.
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error('Codex stream error:', errMsg, error);
          fullResponse = fullResponse || `[Codex error: ${errMsg}]`;
        }
        // Skip the Claude event handler below — already done.
      } else {
      // PR B3: normalized event-stream loop. `runClaudeTurn` translates
      // SDK message shapes into `AgentRuntimeEvent`s; this loop maps
      // each event type to the appropriate side effects (broadcast /
      // persistence / session bookkeeping). Errors from the runtime
      // surface as `{type: 'error'}` events; aborts as
      // `{type: 'done', finishReason: 'aborted'}`. The runtime aims to
      // never throw — the outer `try/catch` below is a safety net for
      // genuinely unexpected exceptions.
      for await (const event of claudeRuntime.runClaudeTurn({
        prompt: enrichedPrompt,
        model,
        cwd: AGENT_CWD,
        isPulse: isPulseOrientation,
        effectiveEffort,
        appendSystemPromptText: appendText,
        pulseSystemPrompt,
        mcpServers: !isPulseOrientation && Object.keys(mcpServersFromConfig).length > 0
          ? buildMcpServersForQuery(mcpServersFromConfig, content, isAutonomous, isFirstMessage)
          : undefined,
        hooks: isPulseOrientation ? undefined : createHooks(hookContext),
        resumeSessionId,
        abortController: activeAbortController,
      }, modelRef)) {
        if (event.type === 'start') {
          // First event — `dispatchClaudeQuery` has run inside the
          // runtime and `activeQuery` is now populated. Kick off the
          // post-dispatch MCP enforce + refresh dance (was inline
          // immediately after `dispatchClaudeQuery` returned pre-B3).
          if (!isPulseOrientation) {
            const disabledServers = getDisabledMcpServers();
            claudeRuntime.mcpServerStatusLive().then(async (statuses) => {
              if (!statuses) return;
              for (const s of statuses) {
                if (disabledServers.has(s.name) && s.status !== 'disabled') {
                  const toggleResult = await claudeRuntime.toggleMcpServerLive(s.name, false);
                  if (!toggleResult.error) {
                    console.log(`[MCP] Disabled "${s.name}" on query start (persistent preference)`);
                  }
                } else if (!disabledServers.has(s.name) && s.status === 'disabled') {
                  const toggleResult = await claudeRuntime.toggleMcpServerLive(s.name, true);
                  if (!toggleResult.error) {
                    await claudeRuntime.reconnectMcpServerLive(s.name);
                    console.log(`[MCP] Re-enabled "${s.name}" on query start (persistent preference)`);
                  }
                }
              }
            }).catch(() => {});

            claudeRuntime.mcpServerStatusLive().then(statuses => {
              if (!statuses) return;
              cachedMcpStatus = statuses.map(s => ({
                name: s.name,
                status: s.status as McpServerInfo['status'],
                error: s.error,
                toolCount: s.tools?.length ?? 0,
                tools: s.tools?.map(t => ({ name: t.name, description: t.description })),
                scope: s.scope,
              }));
              console.log(`MCP status refreshed: ${cachedMcpStatus.length} servers`);
            }).catch(err => {
              console.warn('Failed to get MCP status:', err instanceof Error ? err.message : err);
            });
          }
          continue;
        }

        if (event.type === 'session') {
          if (event.sessionId !== sessionId) {
            sessionId = event.sessionId;
            // Update hook context so hooks log the correct session
            hookContext.sessionId = sessionId;
          }
          continue;
        }

        if (event.type === 'text_delta') {
          // PR #10: refresh context-usage state on each text tick while
          // the query is still alive (was per-assistant-message pre-B3,
          // which fires at roughly the same cadence as text deltas
          // anyway since text comes via assistant messages). Pulse turns
          // excluded — pulse's tiny session shouldn't bounce the gauge.
          if (!isPulseOrientation) {
            fireContextUsageRefresh();
          }
          if (!responseTruncated) {
            if (fullResponse) fullResponse += '\n\n' + event.text;
            else fullResponse = event.text;

            if (fullResponse.length > MAX_RESPONSE_LENGTH) {
              fullResponse = fullResponse.slice(0, MAX_RESPONSE_LENGTH) + '\n[Response truncated due to length]';
              responseTruncated = true;
            }

            if (autonomousOpts.streamToClient !== false) {
              registry.broadcast({
                type: 'stream_token',
                messageId: streamMsgId,
                token: fullResponse,
              });
            }
          }
          continue;
        }

        if (event.type === 'thinking_delta') {
          // INVARIANT (Codex T13/T14 pairing): single providerShape source
          // for both push and broadcast — see same comment on the other
          // thinking_delta site above.
          const providerShape = resolveProviderShape(modelRef.runtime);
          thinkingBlocks.push({
            textOffset: fullResponse.length,
            content: event.text,
            summary: event.summary ?? '',
            providerShape,
          });
          registry.broadcast({
            type: 'thinking',
            content: event.text,
            summary: event.summary ?? '',
            providerShape,
          });
          continue;
        }

        if (event.type === 'compaction_notice') {
          if (event.phase === 'starting') {
            console.log('[Compaction] Compacting in progress...');
            isCompactionInProgress = true;  // PR #11: set flag — abort path needs to know
          } else {
            // phase === 'complete' — `preTokens` from event when available,
            // fall back to the gauge snapshot (matches pre-B3 fallback).
            const preTokens = event.preTokens || claudeRuntime.getContextUsage().tokensUsed;
            console.log(`[Compaction] Context compacted. Pre-tokens: ${preTokens}`);
            isCompactionInProgress = false;  // PR #11: clear flag — boundary completed normally
            registry.broadcast({
              type: 'compaction_notice',
              preTokens,
              message: `Context compacted (was ${Math.round(preTokens / 1000)}K tokens)`,
              isComplete: true,
            });
            // Context window is fresh post-compaction; reset the gauge counter.
            // Do NOT reset fullResponse / toolInsertions / thinkingBlocks —
            // the model continues writing into the same response buffer, with
            // the strict anti-narration instruction injected by PreCompact
            // (hooks.ts buildPreCompact) preventing meta-event leakage.
            claudeRuntime.resetContextOnCompaction();
          }
          continue;
        }

        if (event.type === 'rate_limit') {
          // Status is optional on AgentRuntimeEvent for provider
          // generality (non-Claude rate-limit signals may not carry
          // it), but the WS protocol requires it. Guard at the
          // broadcast site so non-Claude runtimes that emit a
          // status-less rate_limit just no-op the WS broadcast
          // (rate-limit awareness still surfaces in logs).
          // `resetsAt` flows through as-is — pre-B3 typing was `any`;
          // the cast preserves that loose contract until the WS
          // protocol type is reconciled with the SDK's actual shape.
          if (event.status) {
            registry.broadcast({
              type: 'rate_limit',
              status: event.status,
              resetsAt: event.resetsAt as unknown as number | undefined,
              rateLimitType: event.rateLimitType,
              utilization: event.utilization,
            });
            console.log(`[Agent] Rate limit: ${event.status}, type: ${event.rateLimitType}, resets: ${event.resetsAt}`);
          }
          continue;
        }

        if (event.type === 'tool_progress') {
          registry.broadcast({
            type: 'tool_progress',
            toolId: event.toolId,
            toolName: event.toolName,
            elapsed: event.elapsedSeconds,
          });
          continue;
        }

        if (event.type === 'done') {
          if (event.finishReason === 'aborted') {
            console.log('[Agent] Generation stopped by user');
            // PR #11 / chip #38: if compaction was in flight when the abort
            // fired, the SDK never gets to send compact_boundary, so the
            // frontend's "Context compacting" banner stays pinned forever.
            // Broadcast a synthetic completion notice so the banner exits
            // via the existing 8-second auto-hide path.
            if (isCompactionInProgress) {
              console.log('[Compaction] Abort during compaction — clearing banner');
              registry.broadcast({
                type: 'compaction_notice',
                preTokens: claudeRuntime.getContextUsage().tokensUsed,
                message: 'Context compaction interrupted',
                isComplete: true,
              });
              isCompactionInProgress = false;
            }
            registry.broadcast({ type: 'generation_stopped' });
          }
          // 'stop' / 'length' / 'tool_calls': normal completion. No
          // broadcast here — `stream_end` fires later after createMessage.
          continue;
        }

        if (event.type === 'error') {
          // `recoverable: true` events (currently: SDK `result.subtype !== 'success'`)
          // log but don't surface as the response — matches pre-B3 behavior where
          // the result-message error was logged inline but the user-facing reply
          // was whatever assistant text accumulated. `recoverable: false` events
          // (thrown SDK errors caught by the runtime) set fullResponse to the
          // bracketed error string — matches pre-B3 outer-catch behavior.
          console.error('Agent query error:', event.message);
          if (!event.recoverable) {
            fullResponse = fullResponse || `[Agent error: ${event.message}]`;
          }
          continue;
        }
      }
      } // PR E2: close the `else` for the Claude branch (Codex branch above)
    } catch (error) {
      // Safety net for genuinely unexpected exceptions. The runtime
      // catches SDK errors and emits {type: 'error'} events, so we
      // shouldn't reach here under normal failure modes. Kept for
      // defense in depth (e.g. event-iteration internals throwing).
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('Agent stream error:', errMsg, error);
      fullResponse = fullResponse || `[Agent error: ${errMsg}]`;
    } finally {
      // Clean up active query tracking
      clearTimeout(safetyTimeout);
      activeAbortController = null;
      // PR B2b-2: runtime owns the activeQuery reference; release it
      // here so capability methods short-circuit cleanly until the
      // next dispatch.
      claudeRuntime.clearActiveQuery();
      // Track session transition and update for future resume
      if (sessionId && !isPulseOrientation) {
        const previousSessionId = thread.current_session_id;
        const now = new Date().toISOString();
        const clearPending = this.clearPendingForThread.has(threadId);
        const skipForClearPending = clearPending && isAutonomous;

        if (skipForClearPending) {
          // /clear reserved the next interactive turn as the fresh-session
          // starter. This autonomous turn must not consume that slot —
          // skip ALL session_history bookkeeping for this turn:
          //   - Don't endSessionRecord the previous session from the turn
          //     snapshot; /clear already ended and nulled the thread
          //     pointer.
          //   - Don't createSessionRecord for this autonomous session.
          //     If we created and immediately closed it, the row's
          //     [started_at, ended_at] would both equal `now` (this finally
          //     block runs BEFORE createMessage below) and wouldn't cover
          //     the actual companion message's createdAt. It would also
          //     risk closing someone else's row on a UNIQUE collision via
          //     endSessionRecord({sessionId}). Cleaner to never create it.
          //   - Don't updateThreadSession (the actual /clear reservation
          //     stays intact).
          // The autonomous output still persists via createMessage below;
          // the transcript is intact. Only session_history bookkeeping is
          // skipped.
          console.log(`[Session] autonomous session skipped after /clear for thread "${thread.name}"`);
        } else {
          // End the previous session record (if tracked)
          if (previousSessionId && previousSessionId !== sessionId) {
            try {
              endSessionRecord({ sessionId: previousSessionId, endedAt: now, endReason: 'resumed' });
            } catch { /* Previous session may not have a record yet */ }
          }

          // Create a record for the new session
          if (sessionId !== previousSessionId) {
            try {
              createSessionRecord({
                id: crypto.randomUUID(),
                threadId,
                sessionId,
                sessionType: (thread.session_type as 'v1' | 'v2') || 'v2',
                startedAt: now,
              });
            } catch (err) {
              if (!(err instanceof Error && err.message.includes('UNIQUE'))) {
                console.warn('Failed to create session record:', err);
              }
            }
          }

          updateThreadSession(threadId, sessionId);
          // PR C: write to the per-provider sidecar alongside the
          // legacy fast-path. Both writes survive together — the
          // sidecar is authoritative for future lookups (including
          // non-Claude runtimes), `threads.current_session_id` stays
          // as the Claude-runtime fast-path for back-compat.
          setProviderSession({
            threadId,
            runtimeId: modelRef.runtime,
            provider: modelRef.provider,
            modelRef: modelRef.canonical,
            sessionId,
          });
          if (clearPending) {
            this.clearPendingForThread.delete(threadId);
            console.log(`[Session] interactive turn claimed fresh session after /clear for thread "${thread.name}"`);
          }
        }
      }
      presenceStatus = 'dormant';
      registry.broadcast({ type: 'presence', status: 'dormant' });
    }

    console.log(`[Agent] Response complete: ${thinkingBlocks.length} thinking block(s), ${toolInsertions.length} tool call(s)`);

    // Pre-persist suppression hook (used by orchestrator pulse). When the
    // caller passed a suppressIf predicate and it matches the assembled
    // response, drop the message entirely: skip createMessage, skip push,
    // and tell the client via stream_end { suppressed: true } so any
    // streaming-state / tool / thinking offsets keyed to this messageId
    // get cleaned up on the frontend.
    if (autonomousOpts.suppressIf && autonomousOpts.suppressIf(fullResponse)) {
      const label = autonomousOpts.suppressedLogLabel ?? 'suppressed';
      const preview = fullResponse.slice(0, 120).replace(/\n/g, ' ');
      console.log(`[Agent] ${label}: ${fullResponse.length} chars, ${preview}`);
      registry.broadcast({
        type: 'stream_end',
        messageId: streamMsgId,
        suppressed: true,
      });
      return fullResponse;
    }

    // Build segments for interleaved tool/thinking display
    const segments = buildSegments(fullResponse, toolInsertions, thinkingBlocks);

    const messageMetadata = buildCompanionMessageMetadata(modelRef, segments);

    // Store final message
    const companionMessage = createMessage({
      id: streamMsgId,
      threadId,
      role: 'companion',
      content: fullResponse || '[No response]',
      contentType: 'text',
      platform,
      metadata: messageMetadata,
      createdAt: new Date().toISOString(),
    });

    // End stream
    registry.broadcast({
      type: 'stream_end',
      messageId: streamMsgId,
      final: companionMessage,
    });

    // Push notification for offline user
    if (this.pushService && fullResponse) {
      const preview = fullResponse.substring(0, 120).replace(/\n/g, ' ');
      this.pushService.sendIfOffline({
        title: isAutonomous ? `${cfg.identity.companion_name} (autonomous)` : cfg.identity.companion_name,
        body: preview,
        threadId,
        tag: `msg-${streamMsgId}`,
        url: '/chat',
      }).catch(err => console.error('Push error:', err));
    }

    return fullResponse;
  }
}
