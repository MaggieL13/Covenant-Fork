import { Router } from 'express';
import {
  listTriggers,
  cancelTrigger,
} from '../services/db.js';
import type { Orchestrator } from '../services/orchestrator.js';

const router = Router();

// Get orchestrator task status
router.get('/status', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }
    const tasks = await orchestrator.getStatus();
    res.json({ tasks });
  } catch (error) {
    console.error('Error fetching orchestrator status:', error);
    res.status(500).json({ error: 'Failed to fetch orchestrator status' });
  }
});

// Enable/disable/reschedule a task
router.patch('/tasks/:wakeType', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }

    const { wakeType } = req.params;
    const { enabled, cronExpr } = req.body;

    if (cronExpr !== undefined) {
      if (typeof cronExpr !== 'string') {
        res.status(400).json({ error: 'cronExpr must be a string' });
        return;
      }
      const success = orchestrator.rescheduleTask(wakeType, cronExpr);
      if (!success) {
        res.status(400).json({ error: 'Failed to reschedule — invalid cron expression or unknown task' });
        return;
      }
    }

    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }
      const success = enabled
        ? orchestrator.enableTask(wakeType)
        : orchestrator.disableTask(wakeType);
      if (!success) {
        res.status(404).json({ error: 'Unknown task' });
        return;
      }
    }

    const tasks = await orchestrator.getStatus();
    res.json({ success: true, tasks });
  } catch (error) {
    console.error('Error updating orchestrator task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// Get failsafe config
router.get('/failsafe', (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }
    res.json(orchestrator.getFailsafeConfig());
  } catch (error) {
    console.error('Error fetching failsafe config:', error);
    res.status(500).json({ error: 'Failed to fetch failsafe config' });
  }
});

// Update failsafe config
router.patch('/failsafe', (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }

    const { enabled, gentle, concerned, emergency } = req.body;
    orchestrator.setFailsafeConfig({ enabled, gentle, concerned, emergency });
    res.json({ success: true, ...orchestrator.getFailsafeConfig() });
  } catch (error) {
    console.error('Error updating failsafe config:', error);
    res.status(500).json({ error: 'Failed to update failsafe config' });
  }
});

// Get pulse config
router.get('/pulse', (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }
    res.json(orchestrator.getPulseConfig());
  } catch (error) {
    console.error('Error fetching pulse config:', error);
    res.status(500).json({ error: 'Failed to fetch pulse config' });
  }
});

// Update pulse config. Validates at the route layer (returns 400 on
// bad input) because the underlying setPulseConfig setter silently
// no-ops on invalid frequency rather than throwing — fine for the
// internal CLI surface, wrong for a UI/admin surface.
router.patch('/pulse', (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }

    const { enabled, frequency, model } = req.body;

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }

    if (frequency !== undefined && (
      typeof frequency !== 'number' ||
      !Number.isFinite(frequency) ||
      frequency < 5
    )) {
      res.status(400).json({ error: 'frequency must be a number >= 5' });
      return;
    }

    // PR #10: pulse model. String only; empty string clears the DB
    // override and returns to YAML/default. We don't validate against
    // the model manifest here — the SDK errors on bad model IDs at
    // query time, and the UI uses the manifest dropdown so users can't
    // type freeform values through the standard surface.
    if (model !== undefined && typeof model !== 'string') {
      res.status(400).json({ error: 'model must be a string' });
      return;
    }

    orchestrator.setPulseConfig({ enabled, frequency, model });
    res.json({ success: true, ...orchestrator.getPulseConfig() });
  } catch (error) {
    console.error('Error updating pulse config:', error);
    res.status(500).json({ error: 'Failed to update pulse config' });
  }
});

// Get active triggers
router.get('/triggers', (req, res) => {
  try {
    const kind = req.query.kind as 'impulse' | 'watcher' | undefined;
    const triggers = listTriggers(kind);
    res.json({ triggers });
  } catch (error) {
    console.error('Error fetching triggers:', error);
    res.status(500).json({ error: 'Failed to fetch triggers' });
  }
});

// Cancel a trigger
router.delete('/triggers/:id', (req, res) => {
  try {
    const cancelled = cancelTrigger(req.params.id);
    if (!cancelled) {
      res.status(404).json({ error: 'Trigger not found or already cancelled' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error cancelling trigger:', error);
    res.status(500).json({ error: 'Failed to cancel trigger' });
  }
});

export default router;
