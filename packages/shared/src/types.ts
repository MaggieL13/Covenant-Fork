// Database types — mirror the SQLite schema

import type { ProviderId, RuntimeId } from './model-manifest.js';

export interface Thread {
  id: string;
  name: string;
  type: 'daily' | 'named';
  created_at: string;
  archived_at: string | null;
  current_session_id: string | null;
  session_type: 'v1' | 'v2';
  needs_reground: boolean;
  last_activity_at: string | null;
  unread_count: number;
  pinned_at: string | null;
}

export type Platform = 'web' | 'discord' | 'telegram' | 'api';

export interface Message {
  id: string;
  thread_id: string;
  sequence: number;
  role: 'companion' | 'user' | 'system';
  content: string;
  content_type: 'text' | 'image' | 'audio' | 'file' | 'sticker';
  platform: Platform;
  metadata: Record<string, unknown> | null;
  reply_to_id: string | null;
  reply_to_preview: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  original_content: string | null;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
}

export type ReactionUser = 'companion' | 'user';

export interface Reaction {
  emoji: string;
  user: ReactionUser;
  created_at: string;
}

export interface OutboundMessage {
  id: string;
  thread_id: string;
  message_id: string;
  status: 'pending' | 'delivered' | 'failed';
  push_sent: boolean;
  created_at: string;
}

export interface SessionRecord {
  id: string;
  thread_id: string;
  session_id: string;
  session_type: 'v1' | 'v2';
  started_at: string;
  ended_at: string | null;
  end_reason: 'compaction' | 'reaper' | 'daily_rotation' | 'error' | 'manual' | null;
  tokens_used: number | null;
  cost_usd: number | null;
  peak_memory_mb: number | null;
}

export interface AuditEntry {
  id: string;
  session_id: string;
  thread_id: string;
  tool_name: string;
  tool_input: string | null;
  tool_output: string | null;
  triggering_message_id: string | null;
  created_at: string;
}

export interface WebSession {
  id: string;
  token: string;
  created_at: string;
  expires_at: string;
}

export interface ConfigEntry {
  key: string;
  value: string;
}

export type PresenceStatus = 'active' | 'dormant' | 'waking' | 'offline';

export interface McpServerInfo {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  error?: string;
  toolCount: number;
  tools?: { name: string; description?: string }[];
  scope?: string;
}

export interface OrchestratorTaskStatus {
  wakeType: string;
  label: string;
  cronExpr: string;
  enabled: boolean;
  status: 'scheduled' | 'stopped' | 'running';
  nextRun: string | null;
  category: 'wake' | 'checkin' | 'handoff' | 'failsafe' | 'routine';
}

export interface SystemStatus {
  uptime: number;
  memoryUsage: { rss: number; heapUsed: number; heapTotal: number };
  connections: number;
  userConnected: boolean;
  minutesSinceActivity: number;
  presence: PresenceStatus;
  agentProcessing: boolean;
  orchestratorTasks: OrchestratorTaskStatus[];
  mcpServers: McpServerInfo[];
  discord?: { connected: boolean; guilds: number; messagesProcessed: number; errors: number; deferredPending: number; username: string | null };
  telegram?: { connected: boolean; messagesProcessed: number; errors: number; restarts: number };
  queryQueue?: { processing: boolean; depth: number };
}

export interface Canvas {
  id: string;
  thread_id: string | null;
  title: string;
  content: string;
  content_type: 'markdown' | 'code' | 'text' | 'html';
  language: string | null;
  tags: string[];
  created_by: 'companion' | 'user';
  created_at: string;
  updated_at: string;
}

export interface StickerPack {
  id: string;
  name: string;
  description: string;
  entity_id: string | null;
  user_only: boolean;
  created_at: string;
  updated_at: string;
}

export interface Sticker {
  id: string;
  pack_id: string;
  name: string;
  filename: string;
  aliases: string[];
  sort_order: number;
  url: string;
  created_at: string;
}

/**
 * Per-provider rendering shape for thinking segments. The discriminant lets
 * the renderer pick a provider-specific component without losing fidelity:
 * the Claude SDK surfaces a short summary alongside extended reasoning;
 * Codex (via pi-ai) does not (verified in
 * `shared/codex-runtime-lab-findings-2026-05-19.md`); OR/Ollama are generic
 * until specifically carved out in a future arc.
 */
export type ProviderShape = 'claude' | 'codex' | 'generic';

/**
 * Thinking segment, discriminated by providerShape. Claude variant carries
 * the SDK's surfaced summary; Codex variant drops summary entirely; generic
 * is the OR/Ollama fallback (also used for any unknown future shape).
 *
 * Persisted segments written before the per-provider rendering arc do NOT
 * carry providerShape. Read sites must coerce via
 * `normalizeThinkingSegment`; the default is `'claude'` because every
 * stored thinking segment today was produced by the Claude SDK runtime.
 * Defaulting to `'generic'` would render historically-correct Claude
 * reasoning as a flattened block.
 */
export type ThinkingSegment =
  | { type: 'thinking'; providerShape: 'claude'; content: string; summary: string }
  | { type: 'thinking'; providerShape: 'codex'; content: string }
  | { type: 'thinking'; providerShape: 'generic'; content: string };

export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'tool'; toolId: string; toolName: string; input?: string; output?: string; isError?: boolean }
  | ThinkingSegment;

/**
 * Provenance recorded on companion messages so legacy thinking segments
 * (which lack providerShape) can fall back via the legacy-default rule,
 * and so per-message renderer dispatch survives a model swap mid-thread
 * (existing turns keep their producing-provider shape regardless of which
 * model is active NOW). Persisted in `messages.metadata`.
 */
export interface MessageProvenance {
  runtimeId: RuntimeId;
  providerId: ProviderId;
  /** Canonical provider-qualified ref, e.g. `claude/claude-sonnet-4-6`. */
  modelRef: string;
}

/**
 * Raw thinking-segment shape as it appears in persisted metadata or on a
 * WS frame, BEFORE per-provider discrimination. `providerShape` and
 * `summary` are both optional because pre-arc data carries neither
 * predictably; the normalizer below coerces to the strict union.
 */
export interface RawThinkingSegment {
  type: 'thinking';
  content: string;
  providerShape?: ProviderShape;
  summary?: string;
}

/**
 * Coerce a raw thinking-segment object into the strict discriminated union.
 * Missing `providerShape` defaults to `'claude'` (legacy rule above).
 * A missing `summary` on a claude-shape segment becomes the empty string
 * (legacy WS frames occasionally omit it).
 */
export function normalizeThinkingSegment(raw: RawThinkingSegment): ThinkingSegment {
  const shape: ProviderShape = raw.providerShape ?? 'claude';
  if (shape === 'claude') {
    return { type: 'thinking', providerShape: 'claude', content: raw.content, summary: raw.summary ?? '' };
  }
  if (shape === 'codex') {
    return { type: 'thinking', providerShape: 'codex', content: raw.content };
  }
  return { type: 'thinking', providerShape: 'generic', content: raw.content };
}

/**
 * Coerce a raw `segments` array — typically `message.metadata?.segments`
 * read straight off a persisted companion row — into a strict
 * `MessageSegment[]`. Applies `normalizeThinkingSegment` to thinking
 * entries (so legacy claude-produced segments without `providerShape`
 * default to the claude variant per D1) and passes text/tool segments
 * through unchanged.
 *
 * Returns `null` when the input isn't an array (no segments stored,
 * legacy text-only message, etc.) so the caller can stay
 * `MessageSegment[] | null`-shaped without inventing an empty array.
 *
 * This is the read boundary that lets renderer dispatch on
 * `providerShape` rely on the field being present.
 */
export function normalizeMessageSegments(raw: unknown): MessageSegment[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((seg): MessageSegment => {
    if (seg && typeof seg === 'object' && (seg as { type?: unknown }).type === 'thinking') {
      return normalizeThinkingSegment(seg as RawThinkingSegment);
    }
    return seg as MessageSegment;
  });
}

export interface ThreadSummary {
  id: string;
  name: string;
  type: 'daily' | 'named';
  unread_count: number;
  last_activity_at: string | null;
  last_message_preview: string | null;
  pinned_at: string | null;
}

export interface SearchResult {
  message: Message;
  threadId: string;
  threadName: string;
  highlight: string;
}

export interface TriggerStatus {
  id: string;
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: string;
  prompt: string | null;
  cooldown_minutes: number;
  status: 'pending' | 'waiting' | 'fired' | 'cancelled';
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  fired_at: string | null;
}
