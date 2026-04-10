import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'fs';
import { basename, join, resolve } from 'path';
import yaml from 'js-yaml';
import {
  getAllConfig,
  setConfig,
  createCanvas,
  getCanvas,
  listCanvases,
  updateCanvasContent,
  updateCanvasTitle,
  deleteCanvas,
  addPushSubscription,
  removePushSubscription,
  listPushSubscriptions,
  searchMessages,
  getDb,
} from '../services/db.js';
import {
  loginHandler,
  logoutHandler,
  sessionCheckHandler,
} from '../middleware/auth.js';
import { loginRateLimiter } from '../middleware/security.js';
import { authMiddleware } from '../middleware/auth.js';
import { getRecentAuditEntries } from '../services/audit.js';
import { saveFile, getFile, deleteFile, listFiles } from '../services/files.js';
import { registry } from '../services/ws.js';
import { getResonantConfig, reloadConfig, PROJECT_ROOT } from '../config.js';
import type { VoiceService } from '../services/voice.js';
import type { PushService } from '../services/push.js';
import type { AgentService } from '../services/agent.js';
import { markForReinit } from '../services/agent.js';
import rateLimit from 'express-rate-limit';

// Sub-routers
import internalRouter from './internal.js';
import threadsRouter, { markReadHandler } from './threads.js';
import discordAdminRouter from './discord-admin.js';
import orchestratorAdminRouter from './orchestrator-admin.js';
// CC routes imported lazily below (after config loads)

const router = Router();

// --- Public routes (no auth) ---

// Health check (public — minimal response)
router.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memoryUsage: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    connections: registry.getCount(),
  });
});

// Auth endpoints
router.get('/auth/check', sessionCheckHandler);
router.post('/auth/login', loginRateLimiter, loginHandler);
router.post('/auth/logout', logoutHandler);

// Push VAPID public key (no auth — needed before subscription)
router.get('/push/vapid-public', (req, res) => {
  const pushService = req.app.locals.pushService as PushService | undefined;
  const publicKey = pushService?.getVapidPublicKey() || null;
  res.json({ publicKey });
});

// Identity endpoint — companion/user names and timezone for frontend personalization
router.get('/identity', (req, res) => {
  const config = getResonantConfig();
  res.json({
    companion_name: config.identity.companion_name,
    user_name: config.identity.user_name,
    timezone: config.identity.timezone,
    command_center_enabled: config.command_center?.enabled !== false,
  });
});

// --- Setup routes (public) ---

// Check if first-run setup is needed
router.get('/setup/status', (req, res) => {
  const configExists = existsSync(join(PROJECT_ROOT, 'resonant.yaml'));
  const claudeMdExists = existsSync(join(PROJECT_ROOT, 'CLAUDE.md'));
  const mcpJsonExists = existsSync(join(PROJECT_ROOT, '.mcp.json'));
  res.json({
    needsSetup: !configExists,
    hasClaudeMd: claudeMdExists,
    hasMcpJson: mcpJsonExists,
  });
});

// Complete first-run setup (creates config files)
router.post('/setup/complete', (req, res) => {
  const configPath = join(PROJECT_ROOT, 'resonant.yaml');

  // Safety: don't overwrite existing config
  if (existsSync(configPath)) {
    return res.status(409).json({ error: 'Setup already completed' });
  }

  const {
    companionName = 'Echo',
    userName = 'User',
    timezone = 'UTC',
    password = '',
    personality = '',  // CLAUDE.md content (raw or assembled from guided)
  } = req.body || {};

  try {
    // 1. Create resonant.yaml
    const yamlConfig = {
      identity: {
        companion_name: companionName,
        user_name: userName,
        timezone: timezone,
      },
      server: { port: 3002, host: '127.0.0.1' },
      auth: { password: password },
      agent: { model: 'claude-sonnet-4-6' },
      orchestrator: { enabled: true },
      command_center: { enabled: true },
    };
    writeFileSync(configPath, yaml.dump(yamlConfig, { lineWidth: -1 }), 'utf-8');

    // 2. Create CLAUDE.md
    const claudeMdPath = join(PROJECT_ROOT, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
      if (personality.trim()) {
        writeFileSync(claudeMdPath, personality, 'utf-8');
      } else {
        // Copy example
        const examplePath = join(PROJECT_ROOT, 'examples', 'CLAUDE.md');
        if (existsSync(examplePath)) {
          copyFileSync(examplePath, claudeMdPath);
        } else {
          writeFileSync(claudeMdPath, `# ${companionName}\n\nYou are ${companionName}, a warm and genuine AI companion.\n`, 'utf-8');
        }
      }
    }

    // 3. Create .mcp.json
    const mcpPath = join(PROJECT_ROOT, '.mcp.json');
    if (!existsSync(mcpPath)) {
      writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf-8');
    }

    // 4. Create prompts/ directory with wake.md
    const promptsDir = join(PROJECT_ROOT, 'prompts');
    if (!existsSync(promptsDir)) {
      mkdirSync(promptsDir, { recursive: true });
    }
    const wakePath = join(promptsDir, 'wake.md');
    if (!existsSync(wakePath)) {
      const exWake = join(PROJECT_ROOT, 'examples', 'wake-prompts.md');
      if (existsSync(exWake)) {
        let content = readFileSync(exWake, 'utf-8');
        content = content.replace(/\{user_name\}/g, userName);
        writeFileSync(wakePath, content, 'utf-8');
      }
    }

    // 5. Hot-reload config
    reloadConfig();

    res.json({ success: true });
  } catch (err) {
    console.error('Setup failed:', err);
    res.status(500).json({ error: 'Setup failed' });
  }
});

// --- Internal routes (localhost-only, no auth) ---
router.use('/internal', internalRouter);

// --- Protected routes (auth required when password is set) ---
router.use(authMiddleware);

// --- Mount authenticated sub-routers ---
router.use('/threads', threadsRouter);
router.use(markReadHandler);
router.use('/discord', discordAdminRouter);
router.use('/orchestrator', orchestratorAdminRouter);

// --- Command Center (mounted via initCcRoutes after config loads) ---

// --- Config management (auth required) ---

// CLAUDE.md editor
router.get('/config/claude-md', (req, res) => {
  const claudePath = join(PROJECT_ROOT, 'CLAUDE.md');
  const examplePath = join(PROJECT_ROOT, 'examples', 'CLAUDE.md');
  const templatePath = join(PROJECT_ROOT, 'examples', 'CLAUDE.md.template');

  res.json({
    content: existsSync(claudePath) ? readFileSync(claudePath, 'utf-8') : '',
    example: existsSync(examplePath) ? readFileSync(examplePath, 'utf-8') : '',
    template: existsSync(templatePath) ? readFileSync(templatePath, 'utf-8') : '',
  });
});

router.put('/config/claude-md', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  try {
    writeFileSync(join(PROJECT_ROOT, 'CLAUDE.md'), content, 'utf-8');
    // Mark agent for re-init so it picks up new personality
    markForReinit();
    res.json({ success: true, message: 'Personality updated. Takes effect on next message.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save' });
  }
});

// .mcp.json editor
router.get('/config/mcp-json', (req, res) => {
  const mcpPath = join(PROJECT_ROOT, '.mcp.json');
  const examplePath = join(PROJECT_ROOT, 'examples', '.mcp.json');
  res.json({
    content: existsSync(mcpPath) ? readFileSync(mcpPath, 'utf-8') : '{"mcpServers":{}}',
    example: existsSync(examplePath) ? readFileSync(examplePath, 'utf-8') : '',
  });
});

router.put('/config/mcp-json', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  try {
    const parsed = JSON.parse(content);
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      return res.status(400).json({ error: 'JSON must contain a "mcpServers" object' });
    }
    writeFileSync(join(PROJECT_ROOT, '.mcp.json'), JSON.stringify(parsed, null, 2), 'utf-8');
    res.json({ success: true, message: 'MCP config saved. Restart server for changes to take effect.' });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    res.status(500).json({ error: 'Failed to save' });
  }
});

// --- Preferences (resonant.yaml) ---

function findConfigPath(): string | null {
  for (const name of ['resonant.yaml', 'resonant.yml']) {
    const p = resolve(name);
    if (existsSync(p)) return p;
  }
  return null;
}

router.get('/preferences', (req, res) => {
  try {
    const configPath = findConfigPath();
    if (!configPath) {
      res.json({ error: 'No config file found' });
      return;
    }
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown> || {};
    // Only expose safe, editable fields — not server internals
    const config = getResonantConfig();
    res.json({
      identity: {
        companion_name: config.identity.companion_name,
        user_name: config.identity.user_name,
        timezone: config.identity.timezone,
      },
      agent: {
        model: config.agent.model,
        model_autonomous: config.agent.model_autonomous,
      },
      orchestrator: {
        enabled: (parsed as any)?.orchestrator?.enabled ?? config.orchestrator.enabled,
      },
      voice: {
        enabled: (parsed as any)?.voice?.enabled ?? config.voice.enabled,
      },
      discord: {
        enabled: (parsed as any)?.discord?.enabled ?? config.discord.enabled,
      },
      telegram: {
        enabled: (parsed as any)?.telegram?.enabled ?? config.telegram.enabled,
      },
      auth: {
        has_password: !!config.auth.password,
      },
    });
  } catch (err) {
    console.error('Failed to read preferences:', err);
    res.status(500).json({ error: 'Failed to read preferences' });
  }
});

router.put('/preferences', (req, res) => {
  try {
    const configPath = findConfigPath();
    if (!configPath) {
      res.status(404).json({ error: 'No config file found' });
      return;
    }
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = (yaml.load(raw) as Record<string, any>) || {};
    const updates = req.body as Record<string, any>;

    // Merge only allowed fields
    if (updates.identity) {
      if (!parsed.identity) parsed.identity = {};
      if (updates.identity.companion_name !== undefined) parsed.identity.companion_name = updates.identity.companion_name;
      if (updates.identity.user_name !== undefined) parsed.identity.user_name = updates.identity.user_name;
      if (updates.identity.timezone !== undefined) parsed.identity.timezone = updates.identity.timezone;
    }
    if (updates.agent) {
      if (!parsed.agent) parsed.agent = {};
      if (updates.agent.model !== undefined) parsed.agent.model = updates.agent.model;
      if (updates.agent.model_autonomous !== undefined) parsed.agent.model_autonomous = updates.agent.model_autonomous;
    }
    if (updates.orchestrator) {
      if (!parsed.orchestrator) parsed.orchestrator = {};
      if (updates.orchestrator.enabled !== undefined) parsed.orchestrator.enabled = updates.orchestrator.enabled;
    }
    if (updates.voice) {
      if (!parsed.voice) parsed.voice = {};
      if (updates.voice.enabled !== undefined) parsed.voice.enabled = updates.voice.enabled;
    }
    if (updates.discord) {
      if (!parsed.discord) parsed.discord = {};
      if (updates.discord.enabled !== undefined) parsed.discord.enabled = updates.discord.enabled;
    }
    if (updates.telegram) {
      if (!parsed.telegram) parsed.telegram = {};
      if (updates.telegram.enabled !== undefined) parsed.telegram.enabled = updates.telegram.enabled;
    }
    if (updates.auth) {
      if (!parsed.auth) parsed.auth = {};
      if (updates.auth.password !== undefined) parsed.auth.password = updates.auth.password;
    }

    // Write back
    const newYaml = yaml.dump(parsed, { lineWidth: -1, quotingType: '"', forceQuotes: true });
    writeFileSync(configPath, newYaml, 'utf-8');

    res.json({ success: true, message: 'Preferences saved. Restart server for some changes to take effect.' });
  } catch (err) {
    console.error('Failed to save preferences:', err);
    res.status(500).json({ error: 'Failed to save preferences' });
  }
});

// On-demand TTS — user clicks "read aloud" on a companion message
router.post('/tts', async (req, res) => {
  try {
    const { text } = req.body as { text?: string };
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const voiceService = req.app.locals.voiceService as VoiceService | undefined;
    if (!voiceService?.canTTS) {
      res.status(503).json({ error: 'TTS not configured — set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env' });
      return;
    }

    // Strip markdown for cleaner speech
    const cleanText = text
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')  // bold/italic
      .replace(/`[^`]+`/g, '')                     // inline code
      .replace(/```[\s\S]*?```/g, '')              // code blocks
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')     // links
      .replace(/^#+\s*/gm, '')                     // headings
      .replace(/^[-*]\s+/gm, '')                   // list markers
      .replace(/\n{2,}/g, '\n')                    // excess newlines
      .trim();

    if (!cleanText) {
      res.status(400).json({ error: 'No speakable text after stripping markup' });
      return;
    }

    // Truncate to ~5000 chars (ElevenLabs limit / cost control)
    const truncated = cleanText.length > 5000 ? cleanText.slice(0, 5000) : cleanText;
    const audioBuffer = await voiceService.generateTTS(truncated);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length.toString());
    res.send(audioBuffer);
  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ error: 'TTS generation failed' });
  }
});

// --- File upload/download ---

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many uploads, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
});

// File upload
router.post('/files', uploadRateLimiter, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const rawName = req.file.originalname || 'unnamed';
    const safeName = basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
    const fileMeta = saveFile(req.file.buffer, safeName, req.file.mimetype);
    res.json(fileMeta);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Upload failed';
    console.error('File upload error:', msg);
    res.status(400).json({ error: msg });
  }
});

// File listing (MUST be before /files/:id)
router.get('/files/list', (req, res) => {
  try {
    const files = listFiles();

    // Scan messages for fileId references to determine in-use status
    const db = getDb();
    const rows = db.prepare('SELECT metadata FROM messages WHERE metadata IS NOT NULL AND deleted_at IS NULL').all() as Array<{ metadata: string }>;
    const usedFileIds = new Set<string>();
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata);
        if (meta.fileId) usedFileIds.add(meta.fileId);
      } catch { /* skip */ }
    }

    const enriched = files.map(f => ({
      ...f,
      inUse: usedFileIds.has(f.fileId),
    }));

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const orphanCount = enriched.filter(f => !f.inUse).length;

    res.json({ files: enriched, totalSize, totalCount: files.length, orphanCount });
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// Delete a file
router.delete('/files/:id', (req, res) => {
  try {
    const deleted = deleteFile(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// File download
router.get('/files/:id', (req, res) => {
  try {
    const file = getFile(req.params.id);
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=86400'); // 24h cache
    res.sendFile(file.path);
  } catch (error) {
    console.error('File download error:', error);
    res.status(500).json({ error: 'Failed to retrieve file' });
  }
});

// Message search
router.get('/search', (req, res) => {
  try {
    const q = req.query.q as string;
    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Search query required' });
    }
    const threadId = req.query.threadId as string | undefined;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const { messages: rows, total } = searchMessages({ query: q.trim(), threadId, limit, offset });

    const results = rows.map(row => {
      // Build highlight snippet around match
      const idx = row.content.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, idx - 40);
      const end = Math.min(row.content.length, idx + q.length + 40);
      const highlight = (start > 0 ? '...' : '') + row.content.slice(start, end) + (end < row.content.length ? '...' : '');

      return {
        messageId: row.id,
        threadId: row.thread_id,
        threadName: row.thread_name,
        role: row.role,
        content: row.content.substring(0, 200),
        highlight,
        createdAt: row.created_at,
      };
    });

    res.json({ results, total });
  } catch (error) {
    console.error('Error searching messages:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Audit log entries
router.get('/audit', (req, res) => {
  try {
    const { limit } = req.query;
    const entries = getRecentAuditEntries(limit ? parseInt(limit as string, 10) : 50);
    res.json({ entries });
  } catch (error) {
    console.error('Error fetching audit log:', error);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// Agent sessions (via SDK listSessions)
router.get('/sessions', async (req, res) => {
  try {
    const { limit } = req.query;
    const agentService = req.app.locals.agentService as AgentService;
    const sessions = await agentService.listSessions(limit ? parseInt(limit as string, 10) : 50);
    res.json({ sessions });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// --- Settings endpoints ---

// Get all config
router.get('/settings', (req, res) => {
  try {
    const config = getAllConfig();
    res.json({ config });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update a config value
router.put('/settings', (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || typeof key !== 'string' || typeof value !== 'string') {
      res.status(400).json({ error: 'key and value (strings) required' });
      return;
    }
    setConfig(key, value);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating setting:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// Get config endpoint — returns companion/user names plus all DB config
router.get('/config', (req, res) => {
  try {
    const resonantConfig = getResonantConfig();
    const dbConfig = getAllConfig();
    res.json({
      companion_name: resonantConfig.identity.companion_name,
      user_name: resonantConfig.identity.user_name,
      timezone: resonantConfig.identity.timezone,
      config: dbConfig,
    });
  } catch (error) {
    console.error('Error fetching config:', error);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// Get skills from agent CWD
router.get('/skills', (req, res) => {
  try {
    const config = getResonantConfig();
    const agentCwd = config.agent.cwd;
    const skillsDir = join(agentCwd, '.claude', 'skills');

    if (!existsSync(skillsDir)) {
      res.json({ skills: [] });
      return;
    }

    const skills: Array<{ name: string; description: string }> = [];
    const dirs = readdirSync(skillsDir, { withFileTypes: true });

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const skillFile = join(skillsDir, dir.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const content = readFileSync(skillFile, 'utf-8');

      // Parse YAML frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;

      const fm = fmMatch[1];
      const nameMatch = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m);
      const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);

      skills.push({
        name: nameMatch?.[1] || dir.name,
        description: descMatch?.[1] || '',
      });
    }

    res.json({ skills });
  } catch (error) {
    console.error('Error reading skills:', error);
    res.status(500).json({ error: 'Failed to read skills' });
  }
});

// --- Canvas REST routes ---

// List canvases
router.get('/canvases', (req, res) => {
  try {
    const canvases = listCanvases();
    res.json({ canvases });
  } catch (error) {
    console.error('Error listing canvases:', error);
    res.status(500).json({ error: 'Failed to list canvases' });
  }
});

// Create canvas
router.post('/canvases', (req, res) => {
  try {
    const { title, contentType, language, threadId } = req.body;
    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'title is required' });
      return;
    }

    const now = new Date().toISOString();
    const canvas = createCanvas({
      id: crypto.randomUUID(),
      threadId: threadId || undefined,
      title,
      contentType: contentType || 'markdown',
      language: language || undefined,
      createdBy: 'user',
      createdAt: now,
    });

    registry.broadcast({ type: 'canvas_created', canvas });
    res.json({ canvas });
  } catch (error) {
    console.error('Error creating canvas:', error);
    res.status(500).json({ error: 'Failed to create canvas' });
  }
});

// Get canvas
router.get('/canvases/:id', (req, res) => {
  try {
    const canvas = getCanvas(req.params.id);
    if (!canvas) {
      res.status(404).json({ error: 'Canvas not found' });
      return;
    }
    res.json({ canvas });
  } catch (error) {
    console.error('Error fetching canvas:', error);
    res.status(500).json({ error: 'Failed to fetch canvas' });
  }
});

// Update canvas
router.patch('/canvases/:id', (req, res) => {
  try {
    const canvas = getCanvas(req.params.id);
    if (!canvas) {
      res.status(404).json({ error: 'Canvas not found' });
      return;
    }

    const now = new Date().toISOString();
    const { title, content } = req.body;

    if (title !== undefined) {
      updateCanvasTitle(req.params.id, title, now);
    }
    if (content !== undefined) {
      updateCanvasContent(req.params.id, content, now);
      registry.broadcast({ type: 'canvas_updated', canvasId: req.params.id, content, updatedAt: now });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating canvas:', error);
    res.status(500).json({ error: 'Failed to update canvas' });
  }
});

// Delete canvas
router.delete('/canvases/:id', (req, res) => {
  try {
    const deleted = deleteCanvas(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Canvas not found' });
      return;
    }
    registry.broadcast({ type: 'canvas_deleted', canvasId: req.params.id });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting canvas:', error);
    res.status(500).json({ error: 'Failed to delete canvas' });
  }
});

// --- Push subscription endpoints ---

// Subscribe to push notifications
router.post('/push/subscribe', (req, res) => {
  try {
    const { endpoint, keys, deviceLabel } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      res.status(400).json({ error: 'endpoint and keys (p256dh, auth) required' });
      return;
    }

    const id = crypto.randomUUID();
    addPushSubscription({
      id,
      endpoint,
      keysP256dh: keys.p256dh,
      keysAuth: keys.auth,
      deviceName: deviceLabel,
    });

    res.json({ success: true, id });
  } catch (error) {
    console.error('Error subscribing to push:', error);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// Unsubscribe from push notifications
router.post('/push/unsubscribe', (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      res.status(400).json({ error: 'endpoint required' });
      return;
    }

    const removed = removePushSubscription(endpoint);
    res.json({ success: true, removed });
  } catch (error) {
    console.error('Error unsubscribing from push:', error);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// List push subscriptions (truncated endpoints for display)
router.get('/push/subscriptions', (req, res) => {
  try {
    const subs = listPushSubscriptions();
    const display = subs.map(s => ({
      id: s.id,
      deviceName: s.device_name,
      endpoint: s.endpoint ? s.endpoint.slice(0, 60) + '...' : null,
      createdAt: s.created_at,
      lastUsedAt: s.last_used_at,
    }));
    res.json({ subscriptions: display });
  } catch (error) {
    console.error('Error listing push subscriptions:', error);
    res.status(500).json({ error: 'Failed to list subscriptions' });
  }
});

// Send test push notification
router.post('/push/test', async (req, res) => {
  try {
    const pushService = req.app.locals.pushService as PushService | undefined;
    if (!pushService?.isConfigured()) {
      res.status(503).json({ error: 'Push notifications not configured — set VAPID keys in .env' });
      return;
    }

    const config = getResonantConfig();
    await pushService.sendPush({
      title: config.identity.companion_name,
      body: 'Push notifications are working!',
      tag: 'test',
      url: '/chat',
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error sending test push:', error);
    res.status(500).json({ error: 'Failed to send test push' });
  }
});

/** Call after loadConfig() to mount Command Center routes */
export async function initCcRoutes() {
  try {
    if (getResonantConfig().command_center.enabled) {
      const { default: ccRoutes } = await import('./cc-routes.js');
      router.use('/cc', ccRoutes);
    }
  } catch (e) {
    console.warn('[CC] Failed to mount Command Center routes:', (e as Error).message);
  }
}

export default router;
