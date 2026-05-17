import { query, AbortError, listSessions, type Query, type McpServerConfig, type ListSessionsOptions } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerInfo } from '@resonant/shared';
import { MODELS, resolveEffortForModel, normalizeModelRef, unwrapModelRefForClaudeSdk, findModelByRef, type ModelRef, type ModelCapabilities } from '@resonant/shared';
import { ClaudeAgentRuntime } from './runtimes/claude-sdk.js';
import type { AgentRuntime } from './runtimes/types.js';
import { createMessage, updateThreadSession, clearAllThreadSessions, getThread, updateThreadActivity, createSessionRecord, endSessionRecord, getConfig as getDbConfig, setConfig as setDbConfig, getMessages } from './db.js';
import { registry } from './registry.js';
import { createHooks, buildOrientationContext, buildPulseOrientationContext, type HookContext, type ToolInsertion } from './hooks.js';
import type { MessageSegment } from '@resonant/shared';
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

/** Three independent model-resolution tiers. */
export type AgentModelTier = 'interactive' | 'autonomous' | 'pulse';

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
 */
function resolveConfiguredRawModel(tier: AgentModelTier): string {
  if (tier === 'pulse') {
    const dbValue = getDbConfig('agent.model_pulse');
    if (dbValue) return dbValue;
    const cfg = getResonantConfig();
    if (cfg.agent.model_pulse) return cfg.agent.model_pulse;
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
 * **PR B1 status:** the only runtime wired up is `claude-sdk` (via the
 * scaffold `ClaudeAgentRuntime`). No caller in the codebase dispatches
 * through this resolver yet — `AgentService.processMessage` /
 * `processAutonomous` still call `_processQuery` which calls
 * `@anthropic-ai/claude-agent-sdk.query()` directly. This function
 * exists so the resolver shape is in place for PR B2/B3 wiring.
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
 * upcoming runtime extraction (PR B2) harder — every site that imports
 * the SDK has to be considered when the abstraction lands. Consolidating
 * the SDK surface into `agent.ts` now means PR B2 only has one place to
 * change.
 *
 * **Why not `ClaudeAgentRuntime.runTurn` instead:** the runtime stub
 * landed in PR B1 throws on `runTurn` and won't have a real
 * implementation until PR B2. Once B2 lands, `runOneShotQuery` can
 * become a thin wrapper that constructs an `AgentTurnInput` and
 * dispatches through the runtime — without touching `digest.ts` at all.
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

  for await (const message of query({
    prompt: opts.prompt,
    options: {
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      maxTurns: opts.maxTurns ?? 1,
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

// Context window tracking
let contextTokensUsed = 0;
let contextWindowSize = 0;

// Active query tracking (for abort, MCP control, rewind)
let activeAbortController: AbortController | null = null;
let activeQuery: Query | null = null;

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

// Extract a short summary from thinking text (first sentence, capped at ~120 chars)
function extractThinkingSummary(text: string): string {
  const trimmed = text.replace(/^\s+/, '');
  // Find first sentence boundary
  const match = trimmed.match(/^(.+?(?:\.\s|!\s|\?\s|\n))/);
  if (match) {
    const sentence = match[1].trim();
    if (sentence.length <= 120) return sentence;
    return sentence.slice(0, 117) + '...';
  }
  // No sentence boundary found — take first 120 chars
  if (trimmed.length <= 120) return trimmed;
  return trimmed.slice(0, 117) + '...';
}

interface ThinkingInsertion {
  textOffset: number;
  content: string;
  summary: string;
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

// Build interleaved text/tool/thinking segments from response text + insertions
function buildSegments(fullResponse: string, toolInsertions: ToolInsertion[], thinkingBlocks: ThinkingInsertion[] = []): MessageSegment[] {
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
      segments.push({
        type: 'thinking',
        content: ins.data.content,
        summary: ins.data.summary,
      });
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
    return { tokensUsed: contextTokensUsed, contextWindow: contextWindowSize };
  }

  stopGeneration(): boolean {
    if (activeAbortController) {
      activeAbortController.abort();
      return true;
    }
    return false;
  }

  async reconnectMcpServer(name: string): Promise<{ success: boolean; error?: string }> {
    if (!activeQuery) {
      return { success: false, error: 'No active session — will apply on next message' };
    }
    try {
      await activeQuery.reconnectMcpServer(name);
      // Refresh cached status
      const statuses = await activeQuery.mcpServerStatus();
      cachedMcpStatus = statuses.map(s => ({
        name: s.name, status: s.status, error: s.error,
        toolCount: s.tools?.length ?? 0,
        tools: s.tools?.map(t => ({ name: t.name, description: t.description })),
        scope: s.scope,
      }));
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
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

      // If there's an active query, also toggle in the live session (best-effort)
      if (activeQuery) {
        try {
          await activeQuery.toggleMcpServer(name, enabled);
          const statuses = await activeQuery.mcpServerStatus();
          cachedMcpStatus = statuses.map(s => ({
            name: s.name, status: s.status, error: s.error,
            toolCount: s.tools?.length ?? 0,
            tools: s.tools?.map(t => ({ name: t.name, description: t.description })),
            scope: s.scope,
          }));
        } catch { /* best-effort */ }
      }

      // Re-enabling requires a fresh session to fully reconnect SDK-managed servers.
      // Clear all active sessions so the next message starts clean.
      if (enabled) {
        try {
          clearAllThreadSessions();
          console.log(`[MCP] Cleared sessions to force MCP reconnect on next message`);
        } catch { /* best-effort */ }
      }

      console.log(`[MCP] ${name} ${enabled ? 'enabled' : 'disabled'} (persistent)`);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async rewindFiles(userMessageId: string, dryRun?: boolean): Promise<{ canRewind: boolean; filesChanged?: string[]; insertions?: number; deletions?: number; error?: string }> {
    if (!activeQuery) {
      return { canRewind: false, error: 'No active session' };
    }
    try {
      return await activeQuery.rewindFiles(userMessageId, { dryRun });
    } catch (err) {
      return { canRewind: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listSessions(limit = 50): Promise<unknown[]> {
    ensureInit();
    try {
      const sessions = await listSessions({ dir: AGENT_CWD, limit });
      return sessions;
    } catch (err) {
      console.error('Failed to list sessions:', err);
      return [];
    }
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
    let currentThinkingAccum = '';

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
    try {
      model = isPulseOrientation
        ? getConfiguredPulseModel()
        : getConfiguredModel(isAutonomous);
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
    const effectiveEffort = isPulseOrientation
      ? 'low'
      : resolveEffortForModel(model, configuredEffort);
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

      const enrichedPrompt = `[Context]\n${orientation}\n[/Context]${historyBlock}\n\n${content}`;

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

      // PR B2a: SDK call site moved into ClaudeAgentRuntime. Behavior is
      // byte-identical to the pre-B2a inline assembly — the runtime
      // builds the same Options shape, calls query() with the same
      // prompt, returns the same Query result for the stream loop
      // below to iterate. PR B3 will further normalize this so
      // AgentService consumes AgentRuntimeEvent instead of SDK shapes.
      const result = claudeRuntime.dispatchClaudeQuery({
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
        resumeSessionId: !isPulseOrientation && thread.current_session_id
          ? thread.current_session_id
          : undefined,
        abortController: activeAbortController,
      });
      activeQuery = result;

      if (!isPulseOrientation) {
        // Enforce MCP server preferences on query start
        const disabledServers = getDisabledMcpServers();
        result.mcpServerStatus().then(async (statuses) => {
          for (const s of statuses) {
            if (disabledServers.has(s.name) && s.status !== 'disabled') {
              // Disable servers that should be off
              try {
                await result.toggleMcpServer(s.name, false);
                console.log(`[MCP] Disabled "${s.name}" on query start (persistent preference)`);
              } catch { /* best-effort */ }
            } else if (!disabledServers.has(s.name) && s.status === 'disabled') {
              // Re-enable servers that should be on (were disabled in a previous message)
              try {
                await result.toggleMcpServer(s.name, true);
                await result.reconnectMcpServer(s.name);
                console.log(`[MCP] Re-enabled "${s.name}" on query start (persistent preference)`);
              } catch { /* best-effort */ }
            }
          }
        }).catch(() => {});

        // Refresh MCP server status (non-blocking — caches for settings panel)
        result.mcpServerStatus().then(statuses => {
          cachedMcpStatus = statuses.map(s => ({
            name: s.name,
            status: s.status,
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

      // PR #10: fire-and-forget context-usage refresh, called from the
      // assistant-message handler on each tick. Debounced — at most one
      // outstanding control request at a time. Each successful fetch
      // updates the module-level state that /cost, /status, and the
      // context_usage WS event read from. The last successful fetch
      // before the SDK closes the stream wins.
      let pendingContextRefresh = false;
      // (isCompactionInProgress moved earlier in scope so hookContext can
      // capture it via onCompactionStart — see PR #11 review fix.)
      //
      // PR #12: dedupe by value. Each assistant tick fires a refresh, but
      // between subagent ticks the prompt context often hasn't grown, so
      // getContextUsage() returns the same totalTokens repeatedly. Without
      // dedupe we logged AND broadcast each duplicate, flooding both the
      // backend terminal and the WS stream. Tracking the last reported
      // value and skipping unchanged refreshes makes the gauge emit only
      // when something actually changed — real progress (numbers climbing)
      // still emits, identical-value redundant ticks stay silent.
      let lastReportedTokens = -1;
      const fireContextUsageRefresh = () => {
        if (pendingContextRefresh) return;
        pendingContextRefresh = true;
        result.getContextUsage().then((usage) => {
          if (
            usage
            && typeof usage.totalTokens === 'number'
            && typeof usage.maxTokens === 'number'
            && usage.maxTokens > 0
          ) {
            // Dedupe: skip both log and broadcast when totalTokens hasn't
            // changed since the last successful refresh.
            if (usage.totalTokens === lastReportedTokens) return;
            lastReportedTokens = usage.totalTokens;
            contextTokensUsed = usage.totalTokens;
            contextWindowSize = usage.maxTokens;
            const percentage = typeof usage.percentage === 'number'
              ? Math.round(usage.percentage)
              : Math.round((usage.totalTokens / usage.maxTokens) * 100);
            console.log(`Context usage: ${contextTokensUsed} / ${contextWindowSize} (${percentage}%) [${usage.model ?? '?'}]`);
            registry.broadcast({
              type: 'context_usage',
              percentage,
              tokensUsed: contextTokensUsed,
              contextWindow: contextWindowSize,
            });
          }
        }).catch((err) => {
          // Defensive: getContextUsage() can fail if the query closed
          // between our request and the response. Don't blow up; PR #9's
          // /cost "unknown" fallback covers the user-facing surface when
          // state stays at 0.
          //
          // PR #12: the LAST refresh tick on any turn races the SDK's
          // stream-close — that's not actually a failure, it's the
          // expected end-of-stream condition. Suppress that specific
          // message at the log level so the terminal isn't noisy with
          // a "failure" line on every successful turn. Other failure
          // reasons (e.g. mid-stream errors) still surface.
          const msg = err instanceof Error ? err.message : String(err);
          if (!/Query closed before response received/i.test(msg)) {
            console.warn('[Agent] getContextUsage failed:', msg);
          }
        }).finally(() => {
          pendingContextRefresh = false;
        });
      };

      // Simplified stream loop — hooks handle tool activity, audit, images
      // Inner try/catch for AbortError (stop_generation)
      try {
      for await (const msg of result) {
        // Capture session ID from any message
        if (msg && typeof msg === 'object' && 'session_id' in msg) {
          const newSessionId = msg.session_id as string;
          if (newSessionId && newSessionId !== sessionId) {
            sessionId = newSessionId;
            // Update hook context so hooks log the correct session
            hookContext.sessionId = sessionId;
          }
        }

        if (!msg || typeof msg !== 'object' || !('type' in msg)) continue;

        const msgType = (msg as any).type;
        // Capture thinking from raw stream events (SDK strips them from assistant messages)
        if (msgType === 'stream_event') {
          const streamEvent = (msg as any).event;
          if (streamEvent?.type === 'content_block_start' && streamEvent?.content_block?.type === 'thinking') {
            currentThinkingAccum = '';
          } else if (streamEvent?.type === 'content_block_delta' && streamEvent?.delta?.type === 'thinking_delta') {
            const thinkingText = streamEvent.delta.thinking || '';
            if (thinkingText) {
              currentThinkingAccum += thinkingText;
            }
          } else if (streamEvent?.type === 'content_block_stop' && currentThinkingAccum) {
            const summary = extractThinkingSummary(currentThinkingAccum);
            thinkingBlocks.push({
              textOffset: fullResponse.length,
              content: currentThinkingAccum,
              summary,
            });
            registry.broadcast({ type: 'thinking', content: currentThinkingAccum, summary });
            currentThinkingAccum = '';
          }
        }

        if (msgType === 'assistant') {
          // PR #10: refresh context-usage state on each assistant tick
          // while the query is still alive. Calling getContextUsage()
          // from the `result` handler races the SDK's stream-close (it
          // fires `Query closed before response received`); calling here
          // succeeds because we're still mid-stream.
          //
          // Fire-and-forget — do NOT await. We don't want to delay the
          // assistant message handling below for a metrics round-trip.
          // The helper debounces via `pendingContextRefresh` so multiple
          // assistant ticks in a single turn don't pile up control
          // requests. Last successful fetch in the turn wins, which is
          // what the chat-header / /cost surfaces want.
          //
          // Pulse turns deliberately excluded — pulse's tiny session
          // shouldn't bounce the gauge away from the real chat/autonomous
          // session value.
          if (!isPulseOrientation) {
            fireContextUsageRefresh();
          }

          const assistantMsg = msg as any;
          if (assistantMsg.message?.content) {
            for (const block of assistantMsg.message.content) {
              if (block.type === 'text' && block.text) {
                if (!responseTruncated) {
                  if (fullResponse) fullResponse += '\n\n' + block.text;
                  else fullResponse = block.text;

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
              }
              // Thinking blocks are captured from stream_event, not here (avoids duplicates)
            }
          }
        } else if (msgType === 'result') {
          const resultMsg = msg as any;
          // Context-usage state is populated by the assistant-message
          // handler via fireContextUsageRefresh() (defined below). The
          // result message arrives as the SDK closes the stream, so
          // calling getContextUsage() here races the close — see the
          // fire-and-forget pattern in the assistant branch for the
          // working timing.

          if (resultMsg.subtype !== 'success') {
            console.error('Agent error:', resultMsg.subtype, resultMsg.errors);
          }
        } else if (msgType === 'system') {
          const systemMsg = msg as any;
          // Detect compaction boundary
          if (systemMsg.subtype === 'compact_boundary' && systemMsg.compact_metadata) {
            const preTokens = systemMsg.compact_metadata.pre_tokens || contextTokensUsed;
            console.log(`[Compaction] Context compacted. Pre-tokens: ${preTokens}`);
            isCompactionInProgress = false;  // PR #11: clear flag — boundary completed normally
            registry.broadcast({
              type: 'compaction_notice',
              preTokens,
              message: `Context compacted (was ${Math.round(preTokens / 1000)}K tokens)`,
              isComplete: true,
            });
            // Context window is fresh post-compaction; reset only the tracking
            // counter. Do NOT reset fullResponse / toolInsertions / thinkingBlocks
            // — the model continues writing into the same response buffer, with
            // the strict anti-narration instruction injected by PreCompact
            // (hooks.ts buildPreCompact) preventing meta-event leakage. The
            // previous resets defended against re-grounding monologue leaking
            // into Discord/phone replies; that defense is now in the prompt
            // itself, unified across all platforms, so the user's in-flight
            // response is preserved across the compaction boundary.
            contextTokensUsed = 0;
          } else if (systemMsg.status === 'compacting') {
            console.log('[Compaction] Compacting in progress...');
            isCompactionInProgress = true;  // PR #11: set flag — abort path needs to know
          }
        } else if (msgType === 'rate_limit_event') {
          const rle = msg as any;
          const info = rle.rate_limit_info;
          if (info && (info.status === 'rejected' || info.status === 'allowed_warning')) {
            registry.broadcast({
              type: 'rate_limit',
              status: info.status,
              resetsAt: info.resetsAt,
              rateLimitType: info.rateLimitType,
              utilization: info.utilization,
            });
            console.log(`[Agent] Rate limit: ${info.status}, type: ${info.rateLimitType}, resets: ${info.resetsAt}`);
          }
        } else if (msgType === 'tool_progress') {
          const tp = msg as any;
          registry.broadcast({
            type: 'tool_progress',
            toolId: tp.tool_use_id,
            toolName: tp.tool_name,
            elapsed: tp.elapsed_time_seconds,
          });
        }
      }
      } catch (abortErr) {
        if (abortErr instanceof AbortError || (abortErr instanceof Error && abortErr.name === 'AbortError')) {
          console.log('[Agent] Generation stopped by user');
          // PR #11 / chip #38: if compaction was in flight when the abort
          // fired, the SDK never gets to send compact_boundary, so the
          // frontend's "Context compacting" banner stays pinned forever.
          // Broadcast a synthetic completion notice so the banner exits
          // via the existing 8-second auto-hide path (same way a real
          // boundary message clears it). Without this the banner is a
          // zombie until a manual page reload.
          if (isCompactionInProgress) {
            console.log('[Compaction] Abort during compaction — clearing banner');
            registry.broadcast({
              type: 'compaction_notice',
              preTokens: contextTokensUsed,
              message: 'Context compaction interrupted',
              isComplete: true,
            });
            isCompactionInProgress = false;
          }
          registry.broadcast({ type: 'generation_stopped' });
        } else {
          throw abortErr; // Re-throw non-abort errors to outer catch
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('Agent query error:', errMsg, error);
      fullResponse = fullResponse || `[Agent error: ${errMsg}]`;
    } finally {
      // Clean up active query tracking
      clearTimeout(safetyTimeout);
      activeAbortController = null;
      activeQuery = null;
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
    const messageMetadata: Record<string, unknown> | undefined =
      segments.length > 0 ? { segments } : undefined;

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
