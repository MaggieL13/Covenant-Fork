import { Router } from 'express';
import type { PushService } from '../services/push.js';
import { registry } from '../services/ws.js';
import {
  loginHandler,
  logoutHandler,
  sessionCheckHandler,
  authMiddleware,
} from '../middleware/auth.js';
import { loginRateLimiter } from '../middleware/security.js';
import { csrfProtection } from '../middleware/csrf.js';
import { getResonantConfig } from '../config.js';
import internalRouter from './internal.js';
import threadsRouter, { markReadHandler } from './threads.js';
import discordAdminRouter from './discord-admin.js';
import orchestratorAdminRouter from './orchestrator-admin.js';
import setupRouter from './setup.js';
import configAdminRouter from './config-admin.js';
import filesRouter from './files.js';
import searchRouter from './search.js';
import stickersRouter from './stickers.js';
import canvasesRouter from './canvases.js';
import pushAdminRouter from './push-admin.js';
import voiceRouter from './voice.js';

const router = Router();

router.get('/health', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memoryUsage: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    connections: registry.getCount(),
  });
});

router.get('/auth/check', sessionCheckHandler);
router.post('/auth/login', loginRateLimiter, loginHandler);
router.post('/auth/logout', logoutHandler);

router.get('/push/vapid-public', (req, res) => {
  const pushService = req.app.locals.pushService as PushService | undefined;
  const publicKey = pushService?.getVapidPublicKey() || null;
  res.json({ publicKey });
});

router.get('/identity', (_req, res) => {
  const config = getResonantConfig();
  res.json({
    companion_name: config.identity.companion_name,
    user_name: config.identity.user_name,
    timezone: config.identity.timezone,
    command_center_enabled: config.command_center?.enabled !== false,
  });
});

router.use(setupRouter);
router.use('/internal', internalRouter);

router.use(authMiddleware);
router.use(csrfProtection);

router.use('/threads', threadsRouter);
router.use(markReadHandler);
router.use('/discord', discordAdminRouter);
router.use('/orchestrator', orchestratorAdminRouter);
router.use(configAdminRouter);
router.use(filesRouter);
router.use(searchRouter);
router.use(stickersRouter);
router.use(canvasesRouter);
router.use(pushAdminRouter);
router.use(voiceRouter);

/** Call after loadConfig() to mount Command Center routes */
export async function initCcRoutes() {
  try {
    if (getResonantConfig().command_center.enabled) {
      const { default: ccRoutes } = await import('./cc-routes.js');
      router.use('/cc', ccRoutes);
    }
  } catch (error) {
    console.warn('[CC] Failed to mount Command Center routes:', (error as Error).message);
  }
}

export default router;
