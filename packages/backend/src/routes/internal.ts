import { Router } from 'express';
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { basename, resolve, normalize } from 'path';
import rateLimit from 'express-rate-limit';
import { PROJECT_ROOT } from '../config.js';
import {
  listThreads,
  getThread,
  createMessage,
  getMessages,
  getMessage,
  updateThreadActivity,
  getDb,
  createCanvas,
  getCanvas,
  listCanvases,
  updateCanvasContent,
  updateCanvasTags,
  createTimer,
  listPendingTimers,
  cancelTimer,
  addReaction,
  removeReaction,
  createTrigger,
  listTriggers,
  cancelTrigger,
  getUnembeddedMessages,
  saveEmbedding,
  getEmbeddingCount,
  getMessageContext,
} from '../services/db.js';
import type { TriggerCondition } from '../services/db.js';
import { embed, vectorToBuffer } from '../services/embeddings.js';
import { searchVectors, getCacheStats, type SearchFilter } from '../services/vector-cache.js';
import { saveFileInternal } from '../services/files.js';
import { registry } from '../services/ws.js';
import { getResonantConfig } from '../config.js';
import { requireLocalhost } from '../middleware/localhost.js';
import type { Orchestrator } from '../services/orchestrator.js';
import type { VoiceService } from '../services/voice.js';
import type { TelegramService } from '../services/telegram/index.js';

// --- Input validation helpers ---

function validateString(val: unknown, maxLen: number = 10000): string | null {
  if (typeof val !== 'string') return null;
  return val.slice(0, maxLen);
}

function validateInt(val: unknown, min: number = 0, max: number = Number.MAX_SAFE_INTEGER): number | null {
  const n = typeof val === 'string' ? parseInt(val, 10) : Number(val);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.floor(n);
}

const router = Router();

// Apply localhost guard to ALL internal routes
router.use(requireLocalhost);

// --- Security: Path containment validation ---
function isPathAllowed(filePath: string): boolean {
  if (filePath.includes('\0')) return false;
  const resolvedPath = resolve(filePath);
  const safePrefixes = [PROJECT_ROOT, resolve(PROJECT_ROOT, '..')];
  return safePrefixes.some(prefix => resolvedPath.startsWith(prefix + '/') || resolvedPath.startsWith(prefix + '\\'));
}

// --- Rate limiter for TTS endpoint ---
const ttsRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'TTS rate limit exceeded. Try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// TTS endpoint — companion sends voice notes via curl from localhost
router.post('/tts', ttsRateLimiter, async (req, res) => {
  const text = validateString(req.body.text, 10000);
  const explicitThreadId = validateString(req.body.threadId, 200);
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  const voiceService = req.app.locals.voiceService as VoiceService | undefined;
  if (!voiceService?.canTTS) {
    res.status(500).json({ error: 'ElevenLabs not configured — set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env' });
    return;
  }

  // If threadId not provided, use the most recently active thread
  let threadId = explicitThreadId;
  if (!threadId) {
    const threads = listThreads({ includeArchived: false, limit: 1 });
    if (threads.length === 0) {
      res.status(404).json({ error: 'No active threads found' });
      return;
    }
    threadId = threads[0].id;
  }

  const thread = getThread(threadId);
  if (!thread) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }

  try {
    const result = await voiceService.generateTTSForMessage(text, threadId);
    res.json({ success: true, messageId: result.messageId, fileId: result.fileId });
  } catch (error) {
    console.error('TTS error:', error);
    const msg = error instanceof Error ? error.message : 'TTS generation failed';
    res.status(500).json({ error: msg });
  }
});

// Share a file into chat — companion shares files from disk into a thread
router.post('/share', (req, res) => {
  const { path: filePath, threadId: explicitThreadId, caption } = req.body;
  if (!filePath || typeof filePath !== 'string') {
    res.status(400).json({ error: 'path is required' });
    return;
  }

  if (filePath.includes('\0')) {
    res.status(400).json({ error: 'Invalid file path' });
    return;
  }

  if (!isPathAllowed(filePath)) {
    res.status(403).json({ error: 'Path outside allowed directory' });
    return;
  }

  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'File not found on disk' });
    return;
  }

  // Resolve thread
  let threadId = explicitThreadId;
  if (!threadId) {
    const threads = listThreads({ includeArchived: false, limit: 1 });
    if (threads.length === 0) {
      res.status(404).json({ error: 'No active threads found' });
      return;
    }
    threadId = threads[0].id;
  }

  const thread = getThread(threadId);
  if (!thread) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }

  try {
    const buffer = readFileSync(filePath);
    const filename = basename(filePath);
    const fileMeta = saveFileInternal(buffer, filename);

    const now = new Date().toISOString();
    const message = createMessage({
      id: crypto.randomUUID(),
      threadId,
      role: 'companion',
      content: caption || fileMeta.url,
      contentType: fileMeta.contentType,
      metadata: { fileId: fileMeta.fileId, filename: fileMeta.filename, size: fileMeta.size, source: 'shared' },
      createdAt: now,
    });

    updateThreadActivity(threadId, now, true);
    registry.broadcast({ type: 'message', message });

    res.json({ success: true, fileId: fileMeta.fileId, messageId: message.id, url: fileMeta.url });
  } catch (error) {
    console.error('Share file error:', error);
    const msg = error instanceof Error ? error.message : 'Failed to share file';
    res.status(500).json({ error: msg });
  }
});

// Telegram send — send files/photos/voice to user via Telegram
router.post('/telegram-send', async (req, res) => {
  const telegramService = req.app.locals.telegramService as TelegramService | undefined;
  if (!telegramService?.isConnected()) {
    res.status(503).json({ error: 'Telegram not connected' });
    return;
  }

  const { type, text, path: filePath, url, caption, filename, query, target, emoji } = req.body;

  try {
    switch (type) {
      case 'text':
        if (!text) { res.status(400).json({ error: 'text is required' }); return; }
        await telegramService.sendToOwner(text);
        break;

      case 'voice':
        if (!text) { res.status(400).json({ error: 'text is required for TTS' }); return; }
        await telegramService.sendVoiceToOwner(text);
        break;

      case 'photo': {
        if (filePath && !isPathAllowed(filePath)) { res.status(403).json({ error: 'Path outside allowed directory' }); return; }
        const source = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
        if (!source) { res.status(400).json({ error: 'url or valid path required' }); return; }
        await telegramService.sendPhotoToOwner(source, caption);
        break;
      }

      case 'document': {
        if (filePath && !isPathAllowed(filePath)) { res.status(403).json({ error: 'Path outside allowed directory' }); return; }
        const docSource = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
        if (!docSource) { res.status(400).json({ error: 'url or valid path required' }); return; }
        await telegramService.sendDocumentToOwner(docSource, filename || basename(filePath || 'file'), caption);
        break;
      }

      case 'animation': {
        if (filePath && !isPathAllowed(filePath)) { res.status(403).json({ error: 'Path outside allowed directory' }); return; }
        const animSource = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
        if (!animSource) { res.status(400).json({ error: 'url or valid path required' }); return; }
        await telegramService.sendAnimationToOwner(animSource, caption);
        break;
      }

      case 'gif':
        if (!query) { res.status(400).json({ error: 'query is required for gif search' }); return; }
        await telegramService.sendGifToOwner(query, caption);
        break;

      case 'react':
        if (!target || !emoji) { res.status(400).json({ error: 'target and emoji are required' }); return; }
        await telegramService.reactToMessage(target, emoji);
        break;

      default:
        res.status(400).json({ error: `Unknown type: ${type}. Use text, voice, photo, document, animation, gif, or react.` });
        return;
    }

    res.json({ success: true, type });
  } catch (error) {
    console.error('[API] Telegram send error:', error);
    const msg = error instanceof Error ? error.message : 'Telegram send failed';
    res.status(500).json({ error: msg });
  }
});

// Canvas — internal endpoint for agent to create/update canvases
router.post('/canvas', (req, res) => {
  const config = getResonantConfig();
  const { action, canvasId, title, content, filePath, contentType, language, threadId } = req.body;
  const now = new Date().toISOString();

  // Resolve content: filePath takes priority over inline content
  let resolvedContent = content || '';
  if (filePath && typeof filePath === 'string') {
    if (filePath.includes('\0')) {
      res.status(400).json({ error: 'Invalid file path' });
      return;
    }
    if (!isPathAllowed(filePath)) {
      res.status(403).json({ error: 'Path outside allowed directory' });
      return;
    }
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }
    resolvedContent = readFileSync(filePath, 'utf-8');
  }

  try {
    if (action === 'create') {
      if (!title) {
        res.status(400).json({ error: 'title is required' });
        return;
      }

      const canvas = createCanvas({
        id: crypto.randomUUID(),
        threadId: threadId || undefined,
        title,
        content: resolvedContent,
        contentType: contentType || 'markdown',
        language: language || undefined,
        createdBy: 'companion',
        createdAt: now,
      });

      registry.broadcast({ type: 'canvas_created', canvas });

      // System message in chat if threadId provided
      if (threadId) {
        const thread = getThread(threadId);
        if (thread) {
          const sysMsg = createMessage({
            id: crypto.randomUUID(),
            threadId,
            role: 'system',
            content: `${config.identity.companion_name} opened a canvas: ${title}`,
            createdAt: now,
          });
          registry.broadcast({ type: 'message', message: sysMsg });
        }
      }

      res.json({ success: true, canvas });
    } else if (action === 'update') {
      if (!canvasId || (resolvedContent === '' && !filePath)) {
        res.status(400).json({ error: 'canvasId and content (or filePath) are required' });
        return;
      }
      updateCanvasContent(canvasId, resolvedContent, now);
      registry.broadcast({ type: 'canvas_updated', canvasId, content: resolvedContent, updatedAt: now });
      res.json({ success: true });
    } else if (action === 'read') {
      if (!canvasId) {
        res.status(400).json({ error: 'canvasId is required' });
        return;
      }
      const canvas = getCanvas(canvasId);
      if (!canvas) {
        res.status(404).json({ error: 'Canvas not found' });
        return;
      }
      res.json({ success: true, canvas });
    } else if (action === 'list') {
      const allCanvases = listCanvases();
      res.json({ success: true, canvases: allCanvases });
    } else if (action === 'tag') {
      if (!canvasId || !Array.isArray(req.body.tags)) {
        res.status(400).json({ error: 'canvasId and tags (array) are required' });
        return;
      }
      updateCanvasTags(canvasId, req.body.tags, now);
      const updated = getCanvas(canvasId);
      registry.broadcast({ type: 'canvas_updated', canvasId, content: updated?.content || '', updatedAt: now, tags: req.body.tags });
      res.json({ success: true, canvas: updated });
    } else {
      res.status(400).json({ error: 'Unknown action. Use "create", "update", "read", "list", or "tag".' });
    }
  } catch (error) {
    console.error('Internal canvas error:', error);
    res.status(500).json({ error: 'Canvas operation failed' });
  }
});

// Orchestrator self-management — companion manages schedule via curl
router.post('/orchestrator', async (req, res) => {
  const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not available' });
    return;
  }

  const { action, wakeType, cronExpr, label, prompt, enabled, gentle, concerned, emergency, frequency } = req.body;

  try {
    switch (action) {
      case 'status': {
        const tasks = await orchestrator.getStatus();
        res.json({ tasks });
        break;
      }
      case 'enable': {
        if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
        const success = orchestrator.enableTask(wakeType);
        if (!success) { res.status(404).json({ error: 'Unknown wake type' }); return; }
        res.json({ success: true, wakeType, enabled: true });
        break;
      }
      case 'disable': {
        if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
        const success = orchestrator.disableTask(wakeType);
        if (!success) { res.status(404).json({ error: 'Unknown wake type' }); return; }
        res.json({ success: true, wakeType, enabled: false });
        break;
      }
      case 'reschedule': {
        if (!wakeType || !cronExpr) { res.status(400).json({ error: 'wakeType and cronExpr required' }); return; }
        const success = orchestrator.rescheduleTask(wakeType, cronExpr);
        if (!success) { res.status(400).json({ error: 'Failed — invalid cron or unknown wake type' }); return; }
        res.json({ success: true, wakeType, cronExpr });
        break;
      }
      case 'create_routine': {
        if (!wakeType || !cronExpr || !label) { res.status(400).json({ error: 'wakeType, label, and cronExpr required' }); return; }
        const crSuccess = orchestrator.addRoutine({ wakeType, label, cronExpr, prompt: prompt || `Custom routine: ${label}` });
        if (!crSuccess) { res.status(400).json({ error: 'Failed — invalid cron, missing prompt, or wakeType already exists' }); return; }
        res.json({ success: true, wakeType, label, cronExpr });
        break;
      }
      case 'remove_routine': {
        if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
        const rrSuccess = orchestrator.removeRoutine(wakeType);
        if (!rrSuccess) { res.status(400).json({ error: 'Failed — unknown routine or cannot remove default task' }); return; }
        res.json({ success: true, wakeType });
        break;
      }
      case 'pulse_status': {
        res.json(orchestrator.getPulseConfig());
        break;
      }
      case 'pulse_config': {
        orchestrator.setPulseConfig({ enabled, frequency });
        res.json({ success: true, ...orchestrator.getPulseConfig() });
        break;
      }
      case 'failsafe_status': {
        res.json(orchestrator.getFailsafeConfig());
        break;
      }
      case 'failsafe_config': {
        orchestrator.setFailsafeConfig({ enabled, gentle, concerned, emergency });
        res.json({ success: true, ...orchestrator.getFailsafeConfig() });
        break;
      }
      default:
        res.status(400).json({ error: 'Unknown action. Use: status, enable, disable, reschedule, create_routine, remove_routine, pulse_status, pulse_config, failsafe_status, failsafe_config' });
    }
  } catch (error) {
    console.error('Orchestrator internal error:', error);
    res.status(500).json({ error: 'Orchestrator operation failed' });
  }
});

// Timer/Reminder — companion sets contextual reminders via curl
router.post('/timer', (req, res) => {
  const { action } = req.body;

  try {
    switch (action) {
      case 'create': {
        const label = validateString(req.body.label, 500);
        const fireAt = validateString(req.body.fireAt, 100);
        const threadId = validateString(req.body.threadId, 200);
        const context = validateString(req.body.context, 5000);
        const prompt = validateString(req.body.prompt, 10000);
        if (!label || !fireAt || !threadId) {
          res.status(400).json({ error: 'label, fireAt, and threadId required' });
          return;
        }

        // Validate fireAt is a valid ISO date
        const fireDate = new Date(fireAt);
        if (isNaN(fireDate.getTime())) {
          res.status(400).json({ error: 'fireAt must be a valid ISO date' });
          return;
        }

        // Validate thread exists
        const thread = getThread(threadId);
        if (!thread) {
          res.status(404).json({ error: 'Thread not found' });
          return;
        }

        const timer = createTimer({
          id: crypto.randomUUID(),
          label,
          context: context ?? undefined,
          fireAt: fireDate.toISOString(),
          threadId,
          prompt: prompt ?? undefined,
          createdAt: new Date().toISOString(),
        });

        res.json({ success: true, timer });
        break;
      }
      case 'list': {
        const timers = listPendingTimers();
        res.json({ timers });
        break;
      }
      case 'cancel': {
        const { timerId } = req.body;
        if (!timerId) {
          res.status(400).json({ error: 'timerId required' });
          return;
        }
        const cancelled = cancelTimer(timerId);
        if (!cancelled) {
          res.status(404).json({ error: 'Timer not found or already fired/cancelled' });
          return;
        }
        res.json({ success: true, timerId });
        break;
      }
      default:
        res.status(400).json({ error: 'Unknown action. Use: create, list, cancel' });
    }
  } catch (error) {
    console.error('Timer internal error:', error);
    res.status(500).json({ error: 'Timer operation failed' });
  }
});

// Trigger management (internal — agent use via CLI)
router.post('/trigger', (req, res) => {
  const { action } = req.body;

  try {
    switch (action) {
      case 'create': {
        const kind = validateString(req.body.kind, 50);
        const label = validateString(req.body.label, 500);
        const { conditions } = req.body;
        const prompt = validateString(req.body.prompt, 10000);
        const threadId = validateString(req.body.threadId, 200);
        const cooldownMinutes = req.body.cooldownMinutes;
        if (!kind || !label || !conditions) {
          res.status(400).json({ error: 'kind, label, and conditions required' });
          return;
        }
        if (kind !== 'impulse' && kind !== 'watcher') {
          res.status(400).json({ error: 'kind must be "impulse" or "watcher"' });
          return;
        }
        if (!Array.isArray(conditions) || conditions.length === 0) {
          res.status(400).json({ error: 'conditions must be a non-empty array' });
          return;
        }

        // Validate thread exists if specified
        if (threadId) {
          const thread = getThread(threadId);
          if (!thread) {
            res.status(404).json({ error: 'Thread not found' });
            return;
          }
        }

        const trigger = createTrigger({
          id: crypto.randomUUID(),
          kind,
          label,
          conditions: conditions as TriggerCondition[],
          prompt: prompt ?? undefined,
          threadId: threadId ?? undefined,
          cooldownMinutes: cooldownMinutes ? parseInt(cooldownMinutes, 10) : undefined,
          createdAt: new Date().toISOString(),
        });

        res.json({ success: true, trigger });
        break;
      }
      case 'list': {
        const { kind } = req.body;
        const triggers = listTriggers(kind);
        res.json({ triggers });
        break;
      }
      case 'cancel': {
        const { triggerId } = req.body;
        if (!triggerId) {
          res.status(400).json({ error: 'triggerId required' });
          return;
        }
        const cancelled = cancelTrigger(triggerId);
        if (!cancelled) {
          res.status(404).json({ error: 'Trigger not found or already fired/cancelled' });
          return;
        }
        res.json({ success: true, triggerId });
        break;
      }
      default:
        res.status(400).json({ error: 'Unknown action. Use: create, list, cancel' });
    }
  } catch (error) {
    console.error('Trigger internal error:', error);
    res.status(500).json({ error: 'Trigger operation failed' });
  }
});

// React to a message (internal — agent use via CLI)
router.post('/react', (req, res) => {
  try {
    let { messageId, emoji, action, threadId, target } = req.body;
    if (!emoji) {
      res.status(400).json({ error: 'emoji required' });
      return;
    }

    // Resolve target shorthand: "last", "last-2", "last-3" etc.
    // When companion reacts, target only USER messages (they'd never react to their own)
    if (!messageId && threadId && target) {
      const offset = target === 'last' ? 0 : parseInt(target.replace('last-', ''), 10) - 1;
      if (isNaN(offset) || offset < 0) {
        res.status(400).json({ error: 'Invalid target. Use "last", "last-2", "last-3" etc.' });
        return;
      }
      const msgs = getMessages({ threadId, limit: 30 });
      // Filter to user messages only, then count from the end
      const userMsgs = msgs.filter(m => m.role === 'user');
      const idx = userMsgs.length - 1 - offset;
      if (idx < 0) {
        res.status(404).json({ error: 'No user message at that position' });
        return;
      }
      messageId = userMsgs[idx].id;
    }

    if (!messageId) {
      res.status(400).json({ error: 'messageId or (threadId + target) required' });
      return;
    }

    if (action === 'remove') {
      removeReaction(messageId, emoji, 'companion');
      registry.broadcast({
        type: 'message_reaction_removed',
        messageId,
        emoji,
        user: 'companion',
      });
    } else {
      addReaction(messageId, emoji, 'companion');
      registry.broadcast({
        type: 'message_reaction_added',
        messageId,
        emoji,
        user: 'companion',
        createdAt: new Date().toISOString(),
      });
    }

    res.json({ success: true, messageId });
  } catch (error) {
    console.error('React internal error:', error);
    res.status(500).json({ error: 'React operation failed' });
  }
});

// --- Semantic search (localhost-only, pre-auth) ---

router.post('/search-semantic', async (req, res) => {
  try {
    const { query, threadId, role, after, before, limit = 10 } = req.body as {
      query?: string; threadId?: string; role?: string;
      after?: string; before?: string; limit?: number;
    };
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'query is required' });
      return;
    }

    const queryVector = await embed(query);

    const filter: SearchFilter = {};
    if (threadId) filter.threadId = threadId;
    if (role) filter.role = role;
    if (after) filter.after = after;
    if (before) filter.before = before;

    const topResults = searchVectors(queryVector, Math.min(limit, 50), filter);
    const contextSize = Math.min((req.body as Record<string, unknown>).context as number || 2, 10);

    const sessionStmt = getDb().prepare(`
      SELECT sh.session_id, sh.started_at, sh.ended_at
      FROM session_history sh
      WHERE sh.thread_id = ? AND sh.started_at <= ? AND (sh.ended_at IS NULL OR sh.ended_at >= ?)
      LIMIT 1
    `);

    const results = topResults.map(r => {
      const surrounding = getMessageContext(r.messageId, contextSize);

      let session: { sessionId: string; startedAt: string; endedAt: string | null } | null = null;
      try {
        const row = sessionStmt.get(r.threadId, r.createdAt, r.createdAt) as {
          session_id: string; started_at: string; ended_at: string | null;
        } | undefined;
        if (row) session = { sessionId: row.session_id, startedAt: row.started_at, endedAt: row.ended_at };
      } catch { /* best-effort */ }

      return {
        messageId: r.messageId,
        threadId: r.threadId,
        threadName: r.threadName,
        similarity: Math.round(r.similarity * 1000) / 1000,
        createdAt: r.createdAt,
        role: r.role,
        session,
        context: surrounding.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content.length > 500 ? m.content.slice(0, 500) + '\u2026' : m.content,
          createdAt: m.created_at,
          isMatch: m.id === r.messageId,
        })),
      };
    });

    const cache = getCacheStats();
    const { embedded, total } = getEmbeddingCount();
    res.json({ results, indexed: embedded, totalMessages: total, cache });
  } catch (error) {
    console.error('Semantic search error:', error);
    res.status(500).json({ error: 'Semantic search failed' });
  }
});

// Background backfill state
let backfillRunning = false;
let backfillProcessed = 0;
let backfillErrors = 0;

async function runBackfillLoop(batchSize: number, intervalMs: number): Promise<void> {
  if (backfillRunning) return;
  backfillRunning = true;
  backfillProcessed = 0;
  backfillErrors = 0;
  console.log(`[backfill] Starting background indexing (batch=${batchSize}, interval=${intervalMs}ms)`);

  const tick = async () => {
    if (!backfillRunning) return;
    const unembedded = getUnembeddedMessages(batchSize);
    if (unembedded.length === 0) {
      backfillRunning = false;
      const { embedded, total } = getEmbeddingCount();
      console.log(`[backfill] Complete. ${embedded}/${total} messages indexed (${backfillErrors} errors).`);
      return;
    }
    for (const msg of unembedded) {
      if (!backfillRunning) return;
      try {
        const vector = await embed(msg.content);
        saveEmbedding(msg.id, vectorToBuffer(vector));
        backfillProcessed++;
      } catch {
        backfillErrors++;
      }
    }
    if (backfillProcessed % 500 === 0) {
      const { embedded, total } = getEmbeddingCount();
      console.log(`[backfill] Progress: ${embedded}/${total}`);
    }
    setTimeout(tick, intervalMs);
  };
  tick();
}

router.post('/embed-backfill', async (req, res) => {
  try {
    const rawBatch = req.body?.batchSize;
    const batchSize = Math.min(typeof rawBatch === 'number' ? rawBatch : 50, 200);
    const background = req.body?.background === true;
    const action = req.body?.action as string | undefined;

    if (batchSize === 0 || action === 'status') {
      const { embedded, total } = getEmbeddingCount();
      res.json({
        processed: backfillProcessed, remaining: total - embedded,
        indexed: embedded, totalMessages: total,
        running: backfillRunning, errors: backfillErrors,
      });
      return;
    }

    if (action === 'stop') {
      backfillRunning = false;
      const { embedded, total } = getEmbeddingCount();
      res.json({ stopped: true, processed: backfillProcessed, indexed: embedded, totalMessages: total });
      return;
    }

    if (background) {
      if (backfillRunning) {
        const { embedded, total } = getEmbeddingCount();
        res.json({ alreadyRunning: true, processed: backfillProcessed, indexed: embedded, totalMessages: total });
        return;
      }
      const interval = Math.max((req.body?.intervalMs as number) || 5000, 1000);
      runBackfillLoop(batchSize, interval);
      const { embedded, total } = getEmbeddingCount();
      res.json({ started: true, batchSize, intervalMs: interval, indexed: embedded, totalMessages: total });
      return;
    }

    const unembedded = getUnembeddedMessages(batchSize);
    let processed = 0;
    for (const msg of unembedded) {
      try {
        const vector = await embed(msg.content);
        saveEmbedding(msg.id, vectorToBuffer(vector));
        processed++;
      } catch (err) {
        console.error(`[backfill] Failed to embed ${msg.id}:`, err);
      }
    }

    const { embedded, total } = getEmbeddingCount();
    res.json({ processed, remaining: total - embedded, indexed: embedded, totalMessages: total });
  } catch (error) {
    console.error('Backfill error:', error);
    res.status(500).json({ error: 'Backfill failed' });
  }
});

export default router;
