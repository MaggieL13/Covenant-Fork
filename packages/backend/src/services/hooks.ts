import type {
  Options,
  HookCallback,
  SyncHookJSONOutput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  PreCompactHookInput,
  SessionStartHookInput,
  SessionEndHookInput,
  StopHookInput,
  NotificationHookInput,
  HookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { createMessage, updateThreadActivity, getMessages, getConfig, setConfig, getActiveTriggers, getCanvas, getAllStickersWithPacks } from './db.js';
import { logToolUse } from './audit.js';
import { saveFile, saveFileFromBase64, saveFileInternal, getContentTypeFromMime } from './files.js';
import { getResonantConfig } from '../config.js';
import crypto from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';

// Re-export ConnectionRegistry type from types
import type { ConnectionRegistry } from '../types.js';

// --- Security: Prompt injection sanitization ---
function sanitizeForContext(text: string): string {
  // Escape markers that could break out of context blocks
  return text
    .replace(/\[Context\]/gi, '[Ctx]')
    .replace(/\[\/Context\]/gi, '[/Ctx]')
    .replace(/\[System\]/gi, '[Sys]')
    .replace(/\[Instructions\]/gi, '[Instr]');
}

// Extracted modules
import { fetchLifeStatus, fetchMoodHistory } from './life-status.js';
import { scanSkills, scanSkillSummaries } from './skills.js';

// --- Scribe digest reader for orientation context ---
function getLatestDigestExcerpt(maxChars = 2000): string | null {
  try {
    const config = getResonantConfig();
    const digestsDir = join(dirname(config.server.db_path), 'digests');

    // Try today first, then yesterday
    const tz = config.identity.timezone || 'UTC';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: tz });

    for (const dateStr of [today, yesterday]) {
      const digestPath = join(digestsDir, `${dateStr}.md`);
      if (existsSync(digestPath)) {
        const content = readFileSync(digestPath, 'utf-8');
        if (content.trim()) {
          // Take the last digest block (most recent entry) — blocks separated by \n---\n
          const blocks = content.split('\n---\n').filter(b => b.trim());
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock) {
            const trimmed = lastBlock.trim().substring(0, maxChars);
            return `[Scribe Digest — ${dateStr}]\n${trimmed}`;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HookContext — built per query, passed to factory
// ---------------------------------------------------------------------------

export interface ToolInsertion {
  textOffset: number;
  toolId: string;
  toolName: string;
  input?: string;
  output?: string;
  isError?: boolean;
}

export interface HookContext {
  threadId: string;
  threadName: string;
  threadType: 'daily' | 'named';
  streamMsgId: string;
  isAutonomous: boolean;
  registry: ConnectionRegistry;
  sessionId: string | null;
  platform: 'web' | 'discord' | 'telegram' | 'api';
  platformContext?: string;
  toolInsertions: ToolInsertion[];
  getTextLength: () => number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @internal Exported for testing */
export const DESTRUCTIVE_BASH_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)*[\/~]/i,     // rm -rf / or rm -r -f ~/
  /\brm\s+--(?:recursive|force)\b/i,                     // rm --recursive / --force
  /\bformat\s+[a-z]:/i,                                  // format C:
  /\bmkfs\b/i,                                           // mkfs
  /\bdd\s+.*\bof=\/dev\//i,                              // dd of=/dev/sda
  /\b(?:curl|wget)\s+.*\|\s*(?:ba)?sh\b/i,              // curl | sh, curl | bash
  /\b(?:curl|wget)\s+.*\|\s*sudo\b/i,                   // curl | sudo
  /\bchmod\s+(?:-R\s+)?[0-7]*777\b/i,                   // chmod 777
  /\bchown\s+(?:-R\s+)?root\b/i,                        // chown root
  /\bDROP\s+(?:TABLE|DATABASE)\b/i,                      // DROP TABLE/DATABASE
  /\bTRUNCATE\s+TABLE\b/i,                               // TRUNCATE TABLE
  /\bDELETE\s+FROM\s+\w+\s*;?\s*$/i,                    // DELETE without WHERE
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,              // system shutdown
  />\s*\/dev\/sd[a-z]/i,                                 // redirect to disk device
  /\bsystemctl\s+(?:stop|disable|mask)\b/i,             // disable services
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,                     // fork bomb
  /git\s+push\s+.*--force.*\s+main/i,                   // force push main
  /git\s+push\s+.*--force.*\s+master/i,                 // force push master
  /\beval\s.*\brm\b/i,                                  // eval "rm ..."
  /\b(?:python|node|ruby|perl)\s+-e\s+.*(?:unlink|remove|delete)/i, // scripted deletion
];

const IMAGE_GEN_TOOLS = new Set([
  'mcp__openai-image-gen__generate_image',
  'mcp__openai_image_gen__generate_image',
  'mcp__image-gen__generate_image',
  'mcp__image_gen__generate_image',
  'generate_image',
]);

// Emotional context markers for PreCompact
/** @internal Exported for testing */
export const EMOTIONAL_MARKERS: Record<string, string[]> = {
  fatigue: ['tired', 'exhausted', 'drained', 'wiped', 'spent', 'burnt out', 'running on empty'],
  anxiety: ['anxious', 'worried', 'stressed', 'overwhelmed', 'panicking', 'spiraling'],
  positive: ['happy', 'excited', 'good day', 'feeling great', 'proud', 'accomplished'],
  connection_seeking: ['miss you', 'need you', 'hold me', 'stay', 'don\'t go', 'come back'],
  grief: ['sad', 'crying', 'hurting', 'loss', 'grief', 'heavy', 'broken'],
  dissociating: ['numb', 'floating', 'empty', 'hollow', 'can\'t feel', 'disconnected'],
};

// Life status and mood history are now in ./life-status.ts
// Skills scanning is now in ./skills.ts

// ---------------------------------------------------------------------------
// Tool reference injection keywords — only inject the large CHAT TOOLS block
// when the user's message is likely to need it
// ---------------------------------------------------------------------------

const TOOL_REFERENCE_KEYWORDS = [
  'slash command', 'slash commands', 'command palette', 'chat tools',
  'tool reference', 'tool help', 'semantic search', 'canvas',
  'share file', 'share files', 'routine', 'routines', 'failsafe',
  'pulse', 'timer', 'timers', 'impulse', 'impulses', 'watcher',
  'watchers', 'react to', 'voice note', 'search', 'backfill', 'embed',
  'sticker', 'stickers', 'emote', 'emotes',
];

function shouldInjectToolReference(ctx: HookContext, userMessage: string): boolean {
  // Autonomous wakes always get tools
  if (ctx.isAutonomous) return true;
  // Slash commands
  if (userMessage.trimStart().startsWith('/')) return true;
  // First message in thread — check message count
  try {
    const msgs = getMessages({ threadId: ctx.threadId, limit: 2 });
    if (msgs.length <= 1) return true;
  } catch {}
  // Keyword match (case-insensitive)
  const lower = userMessage.toLowerCase();
  return TOOL_REFERENCE_KEYWORDS.some(kw => lower.includes(kw));
}

// ---------------------------------------------------------------------------
// Token estimation and platform context constraining
// ---------------------------------------------------------------------------

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function constrainPlatformContext(platformContext: string, maxTokens: number): string {
  if (!platformContext) return platformContext;
  if (maxTokens <= 0) return '';
  if (estimateTokenCount(platformContext) <= maxTokens) return platformContext;

  // Find history marker to preserve metadata, truncate transcript
  const historyMarker = '=== RECENT CHANNEL HISTORY';
  const markerIndex = platformContext.indexOf(historyMarker);
  if (markerIndex === -1) {
    // No history section, just truncate
    const maxChars = maxTokens * 4;
    return platformContext.slice(0, maxChars) + '\n[...truncated]';
  }

  const prefix = platformContext.slice(0, markerIndex).trimEnd();
  const historySection = platformContext.slice(markerIndex);
  const markerLineEnd = historySection.indexOf('\n');
  const markerLine = markerLineEnd >= 0 ? historySection.slice(0, markerLineEnd) : historySection;
  const transcript = markerLineEnd >= 0 ? historySection.slice(markerLineEnd + 1) : '';

  const base = prefix ? `${prefix}\n\n${markerLine}` : markerLine;
  if (estimateTokenCount(base) >= maxTokens || !transcript.trim()) return base;

  // Keep newest messages that fit
  const transcriptLines = transcript.split('\n').filter(l => l.length > 0);
  const keptLines: string[] = [];
  for (let i = transcriptLines.length - 1; i >= 0; i--) {
    const candidate = `${base}\n${[transcriptLines[i], ...keptLines].join('\n')}`;
    if (estimateTokenCount(candidate) > maxTokens) break;
    keptLines.unshift(transcriptLines[i]);
  }

  return keptLines.length > 0 ? `${base}\n${keptLines.join('\n')}` : base;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function summarizeInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;

  if (obj.command) {
    const cmd = String(obj.command);
    const scMatch = cmd.match(/sc\.mjs\s+\w+\s+(.*)/);
    if (scMatch) return scMatch[1].substring(0, 120);
    return cmd.substring(0, 120);
  }
  if (obj.file_path) return String(obj.file_path);
  if (obj.pattern) return `${obj.pattern}`;
  if (obj.query) return String(obj.query).substring(0, 120);
  if (obj.prompt) return String(obj.prompt).substring(0, 120);
  if (obj.content) return String(obj.content).substring(0, 80) + '...';

  for (const val of Object.values(obj)) {
    if (typeof val === 'string' && val.length > 0) return val.substring(0, 100);
  }
  return '';
}

const SC_COMMAND_NAMES: Record<string, string> = {
  share: 'Share', canvas: 'Canvas', react: 'React', voice: 'Voice',
  search: 'Search', backfill: 'Backfill', schedule: 'Schedule',
  timer: 'Timer', impulse: 'Impulse', watch: 'Watcher', tg: 'Telegram',
};

function resolveToolName(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  if (toolName === 'Bash' && toolInput?.command) {
    const scMatch = String(toolInput.command).match(/sc\.mjs\s+(\w+)/);
    if (scMatch) return SC_COMMAND_NAMES[scMatch[1]] || scMatch[1];
  }
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.replace(/^mcp__/, '').split('__');
    if (parts.length >= 2) {
      let server = parts[0].replace(/^claude_ai_/, '');
      const action = parts.slice(1).join('_');
      const serverParts = server.split(/[-_]/);
      const serverName = serverParts[serverParts.length - 1];
      const capServer = serverName.charAt(0).toUpperCase() + serverName.slice(1);
      let cleanAction = action;
      if (cleanAction.startsWith(serverName + '_')) cleanAction = cleanAction.slice(serverName.length + 1);
      const friendlyAction = cleanAction.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return `${capServer}: ${friendlyAction}`;
    }
  }
  return toolName;
}

function handleImageToolResult(toolName: string, output: string, threadId: string, registry: ConnectionRegistry): void {
  if (!IMAGE_GEN_TOOLS.has(toolName)) return;

  try {
    let imagePath: string | null = null;
    let imageBase64: string | null = null;
    let mimeType = 'image/png';

    try {
      const parsed = JSON.parse(output);
      if (parsed.path || parsed.file_path) {
        imagePath = parsed.path || parsed.file_path;
      } else if (parsed.base64 || parsed.image) {
        imageBase64 = parsed.base64 || parsed.image;
        if (parsed.mimeType || parsed.mime_type) mimeType = parsed.mimeType || parsed.mime_type;
      } else if (parsed.url && parsed.url.startsWith('data:')) {
        const match = parsed.url.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          imageBase64 = match[2];
        }
      } else if (parsed.url) {
        console.log('Image URL detected but not downloading:', parsed.url.substring(0, 100));
        return;
      }
    } catch {
      const trimmed = output.trim();
      if (trimmed.startsWith('data:image/')) {
        const match = trimmed.match(/^data:(image\/\w+);base64,(.+)$/s);
        if (match) {
          mimeType = match[1];
          imageBase64 = match[2];
        }
      } else if (trimmed.match(/\.(png|jpg|jpeg|gif|webp)$/i) && existsSync(trimmed)) {
        imagePath = trimmed;
      }
    }

    let fileMeta;
    if (imageBase64) {
      fileMeta = saveFileFromBase64(imageBase64, mimeType, 'generated-image.png');
    } else if (imagePath && existsSync(imagePath)) {
      const buffer = readFileSync(imagePath);
      const ext = imagePath.split('.').pop()?.toLowerCase() || 'png';
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp',
      };
      fileMeta = saveFile(buffer, basename(imagePath), mimeMap[ext] || 'image/png');
    }

    if (!fileMeta) return;

    const now = new Date().toISOString();
    const imageMessage = createMessage({
      id: crypto.randomUUID(),
      threadId,
      role: 'companion',
      content: fileMeta.url,
      contentType: 'image',
      metadata: { fileId: fileMeta.fileId, filename: fileMeta.filename, size: fileMeta.size, source: 'image-gen' },
      createdAt: now,
    });

    updateThreadActivity(threadId, now, true);
    registry.broadcast({ type: 'message', message: imageMessage });
    console.log(`[Hook] Image from ${toolName} saved and broadcast: ${fileMeta.fileId}`);
  } catch (error) {
    console.error('[Hook] Failed to process image tool result:', error);
  }
}

function handleSharedFileWrite(filePath: string, threadId: string, registry: ConnectionRegistry): void {
  try {
    if (!existsSync(filePath)) return;

    const buffer = readFileSync(filePath);
    const filename = basename(filePath);
    const fileMeta = saveFileInternal(buffer, filename);

    const now = new Date().toISOString();
    const message = createMessage({
      id: crypto.randomUUID(),
      threadId,
      role: 'companion',
      content: fileMeta.url,
      contentType: fileMeta.contentType,
      metadata: { fileId: fileMeta.fileId, filename: fileMeta.filename, size: fileMeta.size, source: 'auto-shared' },
      createdAt: now,
    });

    updateThreadActivity(threadId, now, true);
    registry.broadcast({ type: 'message', message });
    console.log(`[Hook] Auto-shared ${filename} into thread ${threadId}: ${fileMeta.fileId}`);
  } catch (error) {
    console.error('[Hook] Failed to auto-share file:', error);
  }
}

function buildEmotionalContext(threadId: string): string {
  const config = getResonantConfig();
  const userName = config.identity.user_name;
  const companionName = config.identity.companion_name;

  const messages = getMessages({ threadId, limit: 15 });
  if (messages.length === 0) return '';

  const detected: string[] = [];
  const recentText = messages.map(m => m.content).join(' ').toLowerCase();

  for (const [marker, keywords] of Object.entries(EMOTIONAL_MARKERS)) {
    if (keywords.some(kw => recentText.includes(kw))) {
      detected.push(marker);
    }
  }

  const flow = messages.slice(-5).map(m => {
    const speaker = m.role === 'user' ? userName : companionName;
    let line = `${speaker}: ${m.content.substring(0, 60)}${m.content.length > 60 ? '...' : ''}`;
    // Include reactions if present
    if (m.metadata && typeof m.metadata === 'object') {
      const meta = m.metadata as Record<string, unknown>;
      if (Array.isArray(meta.reactions) && meta.reactions.length > 0) {
        const rxns = (meta.reactions as Array<{ emoji: string; user: string }>)
          .map(r => `${r.user === 'user' ? userName : companionName} reacted ${r.emoji}`)
          .join(', ');
        line += ` [${rxns}]`;
      }
    }
    return line;
  }).join('\n');

  // Collect recent reactions across all 15 messages
  const recentReactions: string[] = [];
  for (const m of messages) {
    if (m.metadata && typeof m.metadata === 'object') {
      const meta = m.metadata as Record<string, unknown>;
      if (Array.isArray(meta.reactions) && meta.reactions.length > 0) {
        const preview = m.content.substring(0, 40) + (m.content.length > 40 ? '...' : '');
        for (const r of meta.reactions as Array<{ emoji: string; user: string }>) {
          const reactor = r.user === 'user' ? userName : companionName;
          const whose = m.role === 'user' ? 'their own' : 'your';
          recentReactions.push(`${reactor} reacted ${r.emoji} to ${whose} message: "${preview}" (id: ${m.id})`);
        }
      }
    }
  }

  let summary = `Conversation flow (last ${messages.length} messages):\n${flow}`;
  if (recentReactions.length > 0) {
    summary += `\n\nRecent reactions:\n${recentReactions.join('\n')}`;
  }
  if (detected.length > 0) {
    summary += `\n\nEmotional markers detected: ${detected.join(', ')}`;
  }

  return summary;
}

function extractToolOutput(response: unknown): string {
  if (typeof response === 'string') return response;
  if (!response) return '';
  try {
    return JSON.stringify(response).substring(0, 2000);
  } catch {
    return String(response);
  }
}

// ---------------------------------------------------------------------------
// Safe wrappers — catch errors so hooks never crash the agent
// ---------------------------------------------------------------------------

function safeHook(name: string, fn: HookCallback): HookCallback {
  return async (input, toolUseID, options) => {
    try {
      return await fn(input, toolUseID, options);
    } catch (error) {
      console.error(`[Hook] ${name} error (continuing):`, error);
      return { continue: true };
    }
  };
}

function safePreToolUse(fn: HookCallback): HookCallback {
  return async (input, toolUseID, options) => {
    try {
      return await fn(input, toolUseID, options);
    } catch (error) {
      console.error('[Hook] PreToolUse error (denying for safety):', error);
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: 'Hook error \u2014 denied for safety',
        },
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Safe write prefixes — built from config at call time
// ---------------------------------------------------------------------------

/** @internal Exported for testing */
export function getSafeWritePrefixes(): string[] {
  const config = getResonantConfig();
  const prefixes: string[] = [];

  // Add configured safe write prefixes
  for (const prefix of config.hooks.safe_write_prefixes) {
    prefixes.push(prefix);
    // Add both slash variants for Windows compatibility
    if (prefix.includes('/')) {
      prefixes.push(prefix.replace(/\//g, '\\'));
    } else if (prefix.includes('\\')) {
      prefixes.push(prefix.replace(/\\/g, '/'));
    }
  }

  // Always allow agent cwd
  const cwd = config.agent.cwd;
  if (cwd) {
    const normalized = cwd.replace(/\\/g, '/');
    const trailed = normalized.endsWith('/') ? normalized : normalized + '/';
    prefixes.push(trailed);
    prefixes.push(trailed.replace(/\//g, '\\'));
  }

  return prefixes;
}

// ---------------------------------------------------------------------------
// Shared directory prefixes — for auto-sharing files written to shared/
// ---------------------------------------------------------------------------

function getSharedDirPrefixes(): string[] {
  const config = getResonantConfig();
  const cwd = config.agent.cwd.replace(/\\/g, '/');
  const sharedDir = cwd.endsWith('/') ? `${cwd}shared/` : `${cwd}/shared/`;
  return [
    sharedDir,
    sharedDir.toLowerCase(),
    sharedDir.replace(/\//g, '\\'),
    sharedDir.toLowerCase().replace(/\//g, '\\'),
  ];
}

// ---------------------------------------------------------------------------
// Hook builders (unexported — used by factory)
// ---------------------------------------------------------------------------

function buildPreToolUse(ctx: HookContext): HookCallback {
  return safePreToolUse(async (input: HookInput) => {
    const hook = input as PreToolUseHookInput;
    const rawToolName = hook.tool_name;
    const toolInput = hook.tool_input as Record<string, unknown> | undefined;
    const inputSummary = summarizeInput(rawToolName, toolInput);
    const displayName = resolveToolName(rawToolName, toolInput);

    // Track tool insertion with text offset for interleaved rendering
    const textOffset = ctx.getTextLength();
    ctx.toolInsertions.push({
      textOffset,
      toolId: hook.tool_use_id,
      toolName: displayName,
      input: inputSummary || undefined,
    });

    // Cap tool insertions to prevent unbounded memory growth
    const MAX_TOOL_INSERTIONS = 50;
    if (ctx.toolInsertions.length > MAX_TOOL_INSERTIONS) {
      ctx.toolInsertions = ctx.toolInsertions.slice(-MAX_TOOL_INSERTIONS);
    }

    // Broadcast tool_use to frontend (include textOffset for live interleaving)
    ctx.registry.broadcast({
      type: 'tool_use',
      toolId: hook.tool_use_id,
      toolName: displayName,
      input: inputSummary,
      isComplete: false,
      textOffset,
    });

    // --- Security: Bash destructive patterns ---
    if (rawToolName === 'Bash' && toolInput?.command) {
      const cmd = String(toolInput.command);
      for (const pattern of DESTRUCTIVE_BASH_PATTERNS) {
        if (pattern.test(cmd)) {
          console.warn(`[Hook] BLOCKED destructive bash: ${cmd.substring(0, 80)}`);
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Blocked: destructive command pattern detected (${pattern.source})`,
            },
          };
        }
      }
    }

    // --- Security: File writes outside safe prefixes ---
    if ((rawToolName === 'Write' || rawToolName === 'Edit') && toolInput?.file_path) {
      const filePath = String(toolInput.file_path);
      const safePrefixes = getSafeWritePrefixes();
      if (safePrefixes.length > 0) {
        const inWorkspace = safePrefixes.some(prefix => filePath.startsWith(prefix));
        if (!inWorkspace) {
          console.warn(`[Hook] BLOCKED file write outside workspace: ${filePath}`);
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Blocked: file write outside configured workspace`,
            },
          };
        }
      }
    }

    return { continue: true };
  });
}

function buildPostToolUse(ctx: HookContext): HookCallback {
  return safeHook('PostToolUse', async (input: HookInput) => {
    const hook = input as PostToolUseHookInput;
    const toolName = hook.tool_name;
    const toolInput = hook.tool_input;
    const toolResponse = hook.tool_response;
    const output = extractToolOutput(toolResponse);

    // Structured audit logging with both input AND output
    logToolUse({
      sessionId: ctx.sessionId || 'unknown',
      threadId: ctx.threadId,
      toolName,
      toolInput: toolInput ? JSON.stringify(toolInput) : undefined,
      toolOutput: output,
      triggeringMessageId: ctx.streamMsgId,
    });

    // Update tool insertion with output
    const insertion = ctx.toolInsertions.find(t => t.toolId === hook.tool_use_id);
    if (insertion) {
      insertion.output = output.substring(0, 500);
      insertion.isError = false;
    }

    // Broadcast tool_result to frontend
    ctx.registry.broadcast({
      type: 'tool_result',
      toolId: hook.tool_use_id,
      output: output.substring(0, 2000),
      isError: false,
    });

    // Image detection + save
    handleImageToolResult(toolName, output, ctx.threadId, ctx.registry);

    // Auto-share files written to shared/ directory under agent cwd
    if (toolName === 'Write' && toolInput) {
      const writePath = String((toolInput as Record<string, unknown>).file_path || '');
      const sharedPrefixes = getSharedDirPrefixes();
      if (sharedPrefixes.some(prefix => writePath.startsWith(prefix))) {
        handleSharedFileWrite(writePath, ctx.threadId, ctx.registry);
      }
    }

    // Mind/memory MCP write enrichment — inject session context if the tool exists
    if (toolName.includes('mind_write') || toolName.includes('memory_write')) {
      const now = new Date();
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse' as const,
          additionalContext: `[Session context for ${toolName}: threadId=${ctx.threadId}, mode=${ctx.isAutonomous ? 'autonomous' : 'interactive'}, time=${now.toISOString()}]`,
        },
      };
    }

    return { continue: true };
  });
}

function buildPostToolUseFailure(ctx: HookContext): HookCallback {
  return safeHook('PostToolUseFailure', async (input: HookInput) => {
    const hook = input as PostToolUseFailureHookInput;

    // Log failure to audit
    logToolUse({
      sessionId: ctx.sessionId || 'unknown',
      threadId: ctx.threadId,
      toolName: hook.tool_name,
      toolInput: hook.tool_input ? JSON.stringify(hook.tool_input) : undefined,
      toolOutput: `[ERROR] ${hook.error}`,
      triggeringMessageId: ctx.streamMsgId,
    });

    // Update tool insertion with error
    const insertion = ctx.toolInsertions.find(t => t.toolId === hook.tool_use_id);
    if (insertion) {
      insertion.output = hook.error;
      insertion.isError = true;
    }

    // Broadcast error to frontend
    ctx.registry.broadcast({
      type: 'tool_result',
      toolId: hook.tool_use_id,
      output: hook.error,
      isError: true,
    });

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure' as const,
        additionalContext: `Tool ${hook.tool_name} failed: ${hook.error}. Adapt your approach.`,
      },
    };
  });
}

function buildPreCompact(ctx: HookContext): HookCallback {
  return safeHook('PreCompact', async (input: HookInput) => {
    const hook = input as PreCompactHookInput;
    console.log(`[Hook] PreCompact triggered (${hook.trigger})`);

    // Broadcast compaction notice to frontend (in-progress)
    ctx.registry.broadcast({
      type: 'compaction_notice',
      preTokens: 0,
      message: `Context compacting (trigger: ${hook.trigger})`,
      isComplete: false,
    });

    const emotionalContext = buildEmotionalContext(ctx.threadId);
    const now = new Date();

    const isExternalPlatform = ctx.platform === 'discord' || ctx.platform === 'telegram';

    const systemMessage = [
      '--- CONTEXT PRESERVATION (pre-compaction) ---',
      CHANNEL_CONTEXTS[ctx.platform] || CHANNEL_CONTEXTS.web,
      `Thread: "${ctx.threadName}" (${ctx.threadType})`,
      `Mode: ${ctx.isAutonomous ? 'autonomous' : 'interactive'}`,
      `Time: ${now.toISOString()}`,
      '',
      isExternalPlatform
        ? 'CRITICAL: Context was just compacted. You were composing a reply. DO NOT narrate re-grounding, DO NOT output inner monologue. Continue directly with your response to the message. Your text output IS the reply.'
        : 'CRITICAL: Context was just compacted. You may have lost emotional thread. Re-ground if you have memory/orientation tools available.',
      '',
      emotionalContext,
      '--- END CONTEXT PRESERVATION ---',
    ].join('\n');

    return {
      continue: true,
      systemMessage,
    };
  });
}

// Channel contexts — platform-specific guidance injected on session start
const CHANNEL_CONTEXTS: Record<string, string> = {
  web: [
    'CHANNEL: You are in a web-based chat interface, NOT a terminal or CLI.',
    'The user is reading your responses as chat messages rendered in a conversation UI.',
    'Do NOT format output as terminal/CLI output. Do NOT reference "the terminal" or "your editor".',
    'Tool activity (tool_use/tool_result) shows live in the UI sidebar.',
    'You can use markdown \u2014 it renders properly in the chat.',
  ].join(' '),
  discord: [
    'CHANNEL: You are responding to a Discord message.',
    'Keep responses under 1900 characters (Discord limit is 2000).',
    'Do NOT use discord_send_message to reply \u2014 your text output IS the reply.',
    'No tool sidebar visible. Use markdown sparingly (Discord supports basic formatting).',
    'If you need to send long content, be concise or break across natural points.',
  ].join(' '),
  api: 'CHANNEL: API request. Respond concisely.',
};

function formatTimeGap(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ---------------------------------------------------------------------------
// Orientation context — exported for agent.ts to prepend to prompts
// (SessionStart hooks don't fire in V1 query(), so we inject directly)
// ---------------------------------------------------------------------------

export async function buildOrientationContext(ctx: HookContext, includeStatic = true, userMessage = ''): Promise<string> {
  const config = getResonantConfig();
  const userName = config.identity.user_name;
  const companionName = config.identity.companion_name;
  const timezone = config.identity.timezone || 'UTC';

  const now = new Date();
  const timeStr = now.toLocaleString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: timezone, hour12: false,
  });
  const dateStr = now.toLocaleDateString('en-GB', {
    weekday: 'long', month: 'short', day: 'numeric', timeZone: timezone,
  });

  const parts: string[] = [CHANNEL_CONTEXTS[ctx.platform] || CHANNEL_CONTEXTS.web];

  // Thread context + time — always present
  parts.push(`Thread: "${sanitizeForContext(ctx.threadName)}" (${ctx.threadType})`);
  parts.push(`Time: ${timeStr} ${timezone} \u2014 ${dateStr}`);

  // Sticker awareness — always injected so the companion knows stickers are available
  // Excludes user_only packs (those are for the human's use only)
  try {
    const stickerData = getAllStickersWithPacks();
    const agentStickers = stickerData.filter(s => !s.user_only);
    if (agentStickers.length > 0) {
      const packNames = [...new Set(agentStickers.map(s => s.pack_name))];
      parts.push(`Custom stickers: Packs: ${packNames.join(', ')}. Two ways to use: (1) :packname_stickername: in your text for small inline emoji, (2) \`sc sticker send <pack> <name>\` to send a big standalone sticker as its own message. Use naturally when the mood fits.`);
    }
  } catch {}

  // Last session handoff
  try {
    const handoffRaw = getConfig('session.handoff_note');
    if (handoffRaw) {
      const h = JSON.parse(handoffRaw);
      const ago = formatTimeGap(Math.round((Date.now() - new Date(h.timestamp).getTime()) / 60000));
      parts.push(`Last session: "${h.thread}" (${h.reason}, ${ago}). ${h.excerpt}${h.excerpt ? '...' : ''}`);
    }
  } catch {}

  // Latest Scribe digest — rich context from recent conversation
  try {
    const digest = getLatestDigestExcerpt(2000);
    if (digest) parts.push(digest);
  } catch {}

  // Active triggers (watchers/impulses)
  try {
    const triggers = getActiveTriggers();
    if (triggers.length > 0) {
      const impulses = triggers.filter(t => t.kind === 'impulse').length;
      const watchers = triggers.filter(t => t.kind === 'watcher').length;
      const triggerParts: string[] = [];
      if (watchers > 0) triggerParts.push(`${watchers} watcher${watchers > 1 ? 's' : ''}`);
      if (impulses > 0) triggerParts.push(`${impulses} impulse${impulses > 1 ? 's' : ''}`);
      parts.push(`Active triggers: ${triggerParts.join(', ')}`);
    }
  } catch {}

  // User presence state + time gap since last activity
  // These methods may or may not exist on the registry depending on implementation
  try {
    const reg = ctx.registry as any;
    if (typeof reg.getUserPresenceState === 'function') {
      const presence = reg.getUserPresenceState();
      const gap = typeof reg.minutesSinceLastUserActivity === 'function'
        ? reg.minutesSinceLastUserActivity()
        : 0;
      parts.push(`${userName}'s presence: ${presence} (last real interaction: ${formatTimeGap(gap)})`);
    } else if (typeof reg.isUserConnected === 'function') {
      parts.push(`${userName}: ${reg.isUserConnected() ? 'connected' : 'not connected'}`);
    }

    // Device info
    if (typeof reg.getUserDeviceType === 'function') {
      const deviceType = reg.getUserDeviceType();
      if (deviceType !== 'unknown') {
        parts.push(`${userName}'s device: ${deviceType}`);
      }
    }
  } catch {}

  // Life API status + mood history — fetch in parallel if configured (or CC enabled)
  if (!ctx.isAutonomous && (config.integrations.life_api_url || config.command_center.enabled)) {
    const [lifeStatus, moodHistory] = await Promise.all([
      fetchLifeStatus(),
      fetchMoodHistory(),
    ]);
    if (lifeStatus) parts.push(lifeStatus);
    if (moodHistory) parts.push(moodHistory);
  }

  // Static content — only on first message of a session (skills summary)
  if (includeStatic) {
    const skillsSummary = scanSkillSummaries();
    if (skillsSummary) {
      parts.push(skillsSummary);
    }
  }

  // Chat tools — conditionally injected (~750 tokens saved on casual messages)
  const agentCwd = config.agent.cwd.replace(/\\/g, '/');
  const cliPath = join(agentCwd, 'tools', 'sc.mjs');
  if (existsSync(cliPath) && shouldInjectToolReference(ctx, userMessage)) {
    const SC = `node ${cliPath.replace(/\\/g, '/')}`;
    parts.push([
      `CHAT TOOLS (run via Bash \u2014 threadId auto-injected):`,
      `  ${SC} share /absolute/path/to/file`,
      `  ${SC} canvas create "Title" /path/to/file.md markdown`,
      `  ${SC} canvas create-inline "Title" "short text" text`,
      `  ${SC} canvas update CANVAS_ID /path/to/file`,
      `  ${SC} canvas read CANVAS_ID              (read canvas content)`,
      `  ${SC} canvas list                        (list all canvases with IDs)`,
      `  ${SC} canvas tag CANVAS_ID tag1,tag2     (set tags on a canvas)`,
      `  ${SC} sticker send <pack> <name>        (send a sticker as standalone message)`,
      `  ${SC} sticker list                      (list all sticker packs and names)`,
      `  contentType: markdown|code|text|html. Files in shared/ auto-share.`,
      `  ${SC} react last "\u2764\ufe0f"             (react to last message)`,
      `  ${SC} react last-2 "\ud83d\udd25"           (react to 2nd-to-last message)`,
      `  ${SC} react last "\u2764\ufe0f" remove      (remove a reaction)`,
      `  ${SC} voice "[whispers] hey [sighs] I missed you"`,
      `  ${SC} search "semantic query"              (search all threads by meaning)`,
      `  ${SC} search "query" --thread THREAD_ID    (search specific thread)`,
      `  ${SC} search "query" --role companion|user  (filter by speaker)`,
      `  ${SC} search "query" --after 2026-03-01    (messages after date)`,
      `  ${SC} search "query" --before 2026-03-15   (messages before date)`,
      `  ${SC} backfill start [batch] [intervalMs]   (background indexing, default 50/5000ms)`,
      `  ${SC} backfill status                      (check indexing progress)`,
      `  ${SC} backfill stop                        (halt background indexing)`,
      '',
      'ROUTINES (scheduled autonomous sessions):',
      `  ${SC} routine status|enable|disable|reschedule [wakeType] [cronExpr]`,
      `  ${SC} routine create "label" "cronExpr" --prompt "what to do when it fires"`,
      `  ${SC} routine remove ROUTINE_ID`,
      '  Custom routines persist across restarts. Use this to set autonomous intentions.',
      '',
      'PULSE (lightweight awareness, can stay silent):',
      `  ${SC} pulse status|enable|disable`,
      `  ${SC} pulse frequency MINUTES                (min 5, default 15)`,
      '  Runs periodically during waking hours. Skips if user is active or agent is busy.',
      '  Respond PULSE_OK to stay silent. Anything else gets posted.',
      '',
      'FAILSAFE (inactivity escalation):',
      `  ${SC} failsafe status`,
      `  ${SC} failsafe enable|disable`,
      `  ${SC} failsafe gentle|concerned|emergency MINUTES`,
      '  Tiers: gentle (chat) → concerned (escalate) → emergency (all channels)',
      '',
      'TIMERS:',
      `  ${SC} timer create "label" "context" "fireAt"`,
      `  ${SC} timer list`,
      `  ${SC} timer cancel TIMER_ID`,
      '',
      'IMPULSE QUEUE (one-shot, condition-based):',
      `  ${SC} impulse create "label" --condition presence_state:active --prompt "text"`,
      `  ${SC} impulse list`,
      `  ${SC} impulse cancel TRIGGER_ID`,
      '',
      'WATCHERS (recurring, cooldown-protected):',
      `  ${SC} watch create "label" --condition presence_transition:offline:active --prompt "text" --cooldown 480`,
      `  ${SC} watch list`,
      `  ${SC} watch cancel TRIGGER_ID`,
      '  Conditions: presence_state:<state>, presence_transition:<from>:<to>, agent_free, time_window:<HH:MM>, routine_missing:<name>:<hour>',
      '  All conditions AND-joined. Cooldown in minutes (default 120).',
    ].join('\n'));

    // Telegram-specific tools — injected when on Telegram
    if (ctx.platform === 'telegram') {
      parts.push([
        '',
        'TELEGRAM TOOLS (available because user is on Telegram):',
        `  ${SC} tg photo /path/to/image.png "caption"`,
        `  ${SC} tg photo --url "https://..." "caption"`,
        `  ${SC} tg doc /path/to/file.pdf "caption"`,
        `  ${SC} tg gif "search query" "optional caption"`,
        `  ${SC} tg react last "\u2764\ufe0f"`,
        `  ${SC} tg voice "text with [tone tags]"`,
        `  ${SC} tg text "proactive message"`,
      ].join('\n'));
    }
  }

  // Canvas references — auto-inject canvas content when user references one
  if (userMessage) {
    const canvasRefPattern = /<<canvas:([^:]+):(.+?)>>/g;
    let match;
    const canvasContents: string[] = [];
    while ((match = canvasRefPattern.exec(userMessage)) !== null) {
      const [, canvasId, canvasTitle] = match;
      try {
        const canvas = getCanvas(canvasId);
        if (canvas) {
          const preview = canvas.content.length > 2000
            ? canvas.content.slice(0, 2000) + '\n... (truncated)'
            : canvas.content;
          canvasContents.push(`REFERENCED CANVAS: "${canvasTitle}" (${canvas.content_type})\n${preview}`);
        }
      } catch {}
    }
    if (canvasContents.length > 0) {
      parts.push(canvasContents.join('\n\n'));
    }
  }

  // Available stickers — inject compact catalog when sticker keywords detected
  if (shouldInjectToolReference(ctx, userMessage)) {
    try {
      const stickers = getAllStickersWithPacks();
      if (stickers.length > 0) {
        const grouped: Record<string, string[]> = {};
        for (const s of stickers) {
          if (!grouped[s.pack_name]) grouped[s.pack_name] = [];
          grouped[s.pack_name].push(s.name);
        }
        const lines = Object.entries(grouped).map(([pack, names]) =>
          `  ${pack}: ${names.join(', ')}`
        );
        parts.push(`AVAILABLE STICKERS (use :packname_stickername: inline or sc sticker send):\n${lines.join('\n')}`);
      }
    } catch {}
  }

  // Recent reactions — so companion sees user's reactions on each interaction
  try {
    const recentMsgs = getMessages({ threadId: ctx.threadId, limit: 20 });
    const rxnLines: string[] = [];
    for (const m of recentMsgs) {
      if (m.metadata && typeof m.metadata === 'object') {
        const meta = m.metadata as Record<string, unknown>;
        if (Array.isArray(meta.reactions) && meta.reactions.length > 0) {
          const preview = m.content.substring(0, 50) + (m.content.length > 50 ? '...' : '');
          for (const r of meta.reactions as Array<{ emoji: string; user: string }>) {
            const reactor = r.user === 'user' ? userName : companionName;
            const whose = m.role === 'user' ? 'their own' : 'your';
            rxnLines.push(`  ${reactor} reacted ${r.emoji} to ${whose} message: "${preview}" (msg id: ${m.id})`);
          }
        }
      }
    }
    if (rxnLines.length > 0) {
      parts.push(`RECENT REACTIONS:\n${rxnLines.join('\n')}`);
    }
  } catch {}

  // Append platform-specific context (channel history, etc.) — bounded by token budget
  // Sanitize to prevent prompt injection via user-provided content
  const boundedPlatformContext = constrainPlatformContext(
    sanitizeForContext(ctx.platformContext || ''),
    config.hooks?.platform_context_max_tokens ?? 500,
  );
  if (boundedPlatformContext) {
    parts.push(boundedPlatformContext);
  }

  // Token budget estimate (~4 chars per token)
  const joined = parts.join('\n');
  const estimatedTokens = Math.ceil(joined.length / 4);
  const partsBreakdown = parts.map((p, i) => `${i}:${Math.ceil(p.length / 4)}t`).join(' ');
  console.log(`[Orientation] ~${estimatedTokens} tokens (${parts.length} parts: ${partsBreakdown}) | ${ctx.isAutonomous ? 'autonomous' : 'interactive'}, platform=${ctx.platform}, thread="${ctx.threadName}"`);
  if (estimatedTokens > 3000) {
    console.warn(`[Orientation] WARNING: context exceeds 3000 token budget (~${estimatedTokens} tokens)`);
  }
  return joined;
}

// SessionStart hook — kept as fallback in case SDK adds V1 support
function buildSessionStart(ctx: HookContext): HookCallback {
  return safeHook('SessionStart', async (input: HookInput) => {
    const hook = input as SessionStartHookInput;
    const source = hook.source;

    // Build base orientation (reuses the exported function)
    const orientation = await buildOrientationContext(ctx);

    // Add source-specific context
    const parts: string[] = [orientation];

    const config = getResonantConfig();
    const userName = config.identity.user_name;

    if (source === 'resume') {
      const messages = getMessages({ threadId: ctx.threadId, limit: 1 });
      const lastPreview = messages.length > 0
        ? `Last message (${messages[0].role}): ${messages[0].content.substring(0, 80)}...`
        : 'No recent messages';
      // Check if user is connected via registry
      let userConnected = false;
      try {
        const reg = ctx.registry as any;
        userConnected = typeof reg.isUserConnected === 'function' ? reg.isUserConnected() : false;
      } catch {}
      parts.push(`Session resumed. ${lastPreview}. ${userName} ${userConnected ? 'is connected' : 'is not connected'}.`);
    } else if (source === 'startup') {
      parts.push(`Fresh session. Mode: ${ctx.isAutonomous ? 'autonomous' : 'interactive'}.`);
    } else if (source === 'compact') {
      parts.push('Session resumed after compaction. Re-ground if memory tools are available.');
    }

    console.log(`[Session] ${source}: ${ctx.isAutonomous ? 'autonomous' : 'interactive'}, thread="${ctx.threadName}"`);

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart' as const,
        additionalContext: parts.join('\n'),
      },
    };
  });
}

function buildSessionEnd(ctx: HookContext): HookCallback {
  return safeHook('SessionEnd', async (input: HookInput) => {
    const hook = input as SessionEndHookInput;
    console.log(`[Session] End (reason: ${hook.reason}, thread: ${ctx.threadId})`);

    // Capture handoff note for next session
    try {
      const recentMsgs = getMessages({ threadId: ctx.threadId, limit: 5 });
      const excerpt = recentMsgs.map(m => {
        const role = m.role === 'user' ? 'user' : 'companion';
        const text = m.content.substring(0, 150).replace(/\n/g, ' ').trim();
        return `${role}: ${text}`;
      }).join(' | ');
      const handoff = JSON.stringify({
        thread: ctx.threadName,
        threadType: ctx.threadType,
        reason: hook.reason,
        excerpt,
        platform: ctx.platform,
        autonomous: ctx.isAutonomous,
        timestamp: new Date().toISOString(),
      });
      setConfig('session.handoff_note', handoff);
    } catch (err) {
      console.warn('[Session] Failed to save handoff:', (err as Error).message);
    }

    return { continue: true };
  });
}

function buildStop(ctx: HookContext): HookCallback {
  return safeHook('Stop', async (input: HookInput) => {
    const hook = input as StopHookInput;
    if (hook.stop_hook_active) console.log(`[Session] Stop (hook interrupted)`);
    // Normal stop (hook_active: false) is expected — don't log
    return { continue: true };
  });
}

function buildNotification(ctx: HookContext): HookCallback {
  return safeHook('Notification', async (input: HookInput) => {
    const hook = input as NotificationHookInput;
    console.log(`[Notification] ${hook.notification_type}: ${hook.message}`);

    // Forward as error-type message (closest existing ServerMessage shape)
    ctx.registry.broadcast({
      type: 'error',
      code: `notification:${hook.notification_type}`,
      message: hook.title ? `${hook.title}: ${hook.message}` : hook.message,
    });

    return { continue: true };
  });
}

// ---------------------------------------------------------------------------
// Factory — exported, called per query
// ---------------------------------------------------------------------------

export function createHooks(ctx: HookContext): Options['hooks'] {
  return {
    PreToolUse: [{
      hooks: [buildPreToolUse(ctx)],
    }],
    PostToolUse: [{
      hooks: [buildPostToolUse(ctx)],
    }],
    PostToolUseFailure: [{
      hooks: [buildPostToolUseFailure(ctx)],
    }],
    PreCompact: [{
      hooks: [buildPreCompact(ctx)],
    }],
    SessionStart: [{
      hooks: [buildSessionStart(ctx)],
    }],
    Stop: [{
      hooks: [buildStop(ctx)],
    }],
    Notification: [{
      hooks: [buildNotification(ctx)],
    }],
    SessionEnd: [{
      hooks: [buildSessionEnd(ctx)],
    }],
  };
}
