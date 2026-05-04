import { query, AbortError, listSessions, type Options, type Query, type McpServerConfig, type ListSessionsOptions } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerInfo } from '@resonant/shared';
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
 * Resolve the configured model ID for a given tier. Honors the cascade
 * DB config > YAML config > env var > default. Exported so other modules
 * (services/runtime-health.ts, settings UI surfaces) can ask the same
 * question without duplicating the cascade logic.
 *
 * Tier semantics:
 * - interactive: chat turns initiated by the user
 * - autonomous: wakes / timers / watchers / impulses (full-mode autonomous)
 * - pulse: lightweight heartbeat checks (separate cheap-model tier)
 */
export function resolveConfiguredAgentModel(tier: AgentModelTier): string {
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

// Thin wrappers for existing call sites — delegate to the unified resolver.
function getConfiguredModel(isAutonomous: boolean): string {
  return resolveConfiguredAgentModel(isAutonomous ? 'autonomous' : 'interactive');
}

// Pulse runs on its own model tier — heartbeat decisions are extremely
// shallow and fit Haiku's strengths. DB > YAML > default ('claude-haiku-4-5').
// Kept separate from getConfiguredModel so that the autonomous tier (used by
// wakes / impulses / watchers / timers) can stay on Sonnet while pulse drops
// to Haiku without tier-flag gymnastics.
function getConfiguredPulseModel(): string {
  return resolveConfiguredAgentModel('pulse');
}

function getConfiguredThinkingEffort(): string {
  const dbValue = getDbConfig('agent.thinking_effort');
  if (dbValue) return dbValue;
  const cfg = getResonantConfig();
  return cfg.agent.thinking_effort || 'max';
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
    };

    // First message of this session — include static orientation content (tools, skills, vault)
    const isFirstMessage = !thread.current_session_id;

    // Build query options — V1 API (full config support)
    // Three-tier model: pulse uses its own (Haiku by default), autonomous wakes
    // use the autonomous tier, interactive queries use the primary tier.
    // Interactive + autonomous resolve via DB > YAML > env var > default.
    // Pulse resolves via DB > YAML > default (no env var; pulse is narrow
    // enough that operator config doesn't need a third override path).
    const model = isPulseOrientation
      ? getConfiguredPulseModel()
      : getConfiguredModel(isAutonomous);
    const effort = getConfiguredThinkingEffort();
    const effectiveEffort = isPulseOrientation ? 'low' : effort;
    const tier = isPulseOrientation ? 'pulse' : (isAutonomous ? 'autonomous' : 'interactive');
    console.log(`[Agent] Model: ${model} (${tier}, effort: ${effectiveEffort})`);

    // Tool-behavior rule prepended to the system prompt. Lives here
    // rather than in CLAUDE.md so the personal persona file stays
    // untouched. Keep this short — long tool rules pull focus from the
    // companion's voice.
    const TOOL_BEHAVIOR_RULES = [
      '## Tool behavior',
      '',
      'When using the Write tool to save user-facing content (scripts, stories, notes, markdown, ElevenLabs scripts, personal writing), default to the `shared/` folder relative to the project root. Example: `shared/elevenlabs-april-19.md`, not `elevenlabs-april-19.md`.',
      '',
      'Repo-root writes are appropriate only for files that genuinely belong at the root (package.json, README, config, test artifacts explicitly requested). When unsure, prefer `shared/`.',
      '',
      'If the Voice tool returns an error indicating it is unavailable / not configured, send your intended message as a normal chat reply instead. Do NOT improvise by creating a canvas, writing a markdown file, or any other persistence-based workaround for what was meant to be a voice note — a regular chat message is the correct fallback.',
    ].join('\n');

    const appendText = claudeMdContent
      ? `${TOOL_BEHAVIOR_RULES}\n\n${claudeMdContent}`
      : TOOL_BEHAVIOR_RULES;

    const pulseSystemPrompt = [
      `You are ${cfg.identity.companion_name}, running a lightweight internal pulse check for ${cfg.identity.user_name}.`,
      'Your default behavior is silence: output exactly PULSE_OK unless there is a specific, concrete reason to interrupt now.',
      'Do not greet, narrate availability, acknowledge the check, or use tools. If you do reach out, be brief and name the concrete reason first.',
    ].join('\n');

    const options: Options = {
      model,
      systemPrompt: isPulseOrientation
        ? pulseSystemPrompt
        : { type: 'preset', preset: 'claude_code', append: appendText },
      cwd: AGENT_CWD,
      permissionMode: isPulseOrientation ? 'plan' : 'bypassPermissions',
      allowDangerouslySkipPermissions: !isPulseOrientation,
      maxTurns: isPulseOrientation ? 1 : 30,

      includePartialMessages: !isPulseOrientation,
      // `display: 'summarized'` is required to actually see thinking on Opus
      // 4.7+ — those models default `display` to `'omitted'`, which causes the
      // API to return empty `thinking` blocks (only `signature` for continuity).
      // On 4.6 / Sonnet 4.6 the default is already `'summarized'` so this is
      // a no-op. Without it, the streaming capture path at the bottom of this
      // file never sees `thinking_delta` events on 4.7 and the panel logs
      // "0 thinking block(s)" even when the model thought hard.
      // Ref: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
      thinking: isPulseOrientation ? { type: 'disabled' } : { type: 'adaptive', display: 'summarized' },
      effort: effectiveEffort as any,
      tools: isPulseOrientation ? [] : undefined,
      persistSession: isPulseOrientation ? false : undefined,
      hooks: isPulseOrientation ? undefined : createHooks(hookContext),
      // Plugin: native skill discovery from .claude/skills/
      plugins: isPulseOrientation ? undefined : [{ type: 'local' as const, path: join(AGENT_CWD, '.claude').replace(/\\/g, '/') }],
      // Explicitly pass MCP servers — SDK isolation mode doesn't auto-discover .mcp.json
      // Dynamic loading: CC and Mind MCP servers are keyword-gated to reduce token overhead
      ...(!isPulseOrientation && Object.keys(mcpServersFromConfig).length > 0 && {
        mcpServers: buildMcpServersForQuery(mcpServersFromConfig, content, isAutonomous, isFirstMessage),
      }),
    };

    // Resume existing session if available
    if (!isPulseOrientation && thread.current_session_id) {
      options.resume = thread.current_session_id;
    }

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

      // Abort controller for stop_generation support + safety timeout
      activeAbortController = new AbortController();
      options.abortController = activeAbortController;
      const timeoutMs = getResonantConfig().agent.query_timeout_ms || 300000;
      safetyTimeout = setTimeout(() => {
        console.warn(`[Agent] Query timed out after ${timeoutMs / 1000}s, aborting`);
        activeAbortController?.abort();
      }, timeoutMs);

      // File checkpointing for rewind support
      if (!isPulseOrientation) {
        options.enableFileCheckpointing = true;
      }

      // V1 query — single params object with prompt and options
      const result = query({ prompt: enrichedPrompt, options });
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

          // Extract context window usage from result
          if (resultMsg.usage || resultMsg.model_usage) {
            const usage = resultMsg.usage || {};
            const modelUsage = resultMsg.model_usage;

            // Get context window size from model usage if available
            if (modelUsage) {
              for (const model of Object.values(modelUsage) as any[]) {
                if (model?.context_window) {
                  contextWindowSize = model.context_window;
                }
                if (model?.input_tokens) {
                  contextTokensUsed = model.input_tokens + (model.output_tokens || 0);
                }
              }
            } else if (usage.input_tokens) {
              contextTokensUsed = usage.input_tokens + (usage.output_tokens || 0);
            }

            if (contextWindowSize > 0 && contextTokensUsed > 0) {
              const percentage = Math.round((contextTokensUsed / contextWindowSize) * 100);
              console.log(`Context usage: ${contextTokensUsed} / ${contextWindowSize} (${percentage}%)`);
              registry.broadcast({
                type: 'context_usage',
                percentage,
                tokensUsed: contextTokensUsed,
                contextWindow: contextWindowSize,
              });
            }
          }

          if (resultMsg.subtype !== 'success') {
            console.error('Agent error:', resultMsg.subtype, resultMsg.errors);
          }
        } else if (msgType === 'system') {
          const systemMsg = msg as any;
          // Detect compaction boundary
          if (systemMsg.subtype === 'compact_boundary' && systemMsg.compact_metadata) {
            const preTokens = systemMsg.compact_metadata.pre_tokens || contextTokensUsed;
            console.log(`[Compaction] Context compacted. Pre-tokens: ${preTokens}`);
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
