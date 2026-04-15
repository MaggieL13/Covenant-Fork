import { Router } from 'express';
import { completeFirstRunSetup, getSetupStatus } from '../services/config-files.js';

const router = Router();

router.get('/setup/status', (_req, res) => {
  res.json(getSetupStatus());
});

router.post('/setup/complete', (req, res) => {
  try {
    completeFirstRunSetup(req.body || {});
    res.json({ success: true });
  } catch (error) {
    console.error('Setup failed:', error);
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Setup failed' });
  }
});

export default router;
