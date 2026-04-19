import { Router } from 'express';
import { getAllConfig, getConfig, setConfig, clearAllThreadSessions } from '../services/db.js';
import { getResonantConfig } from '../config.js';
import { markForReinit } from '../services/agent.js';
import { scanSkills } from '../services/skills.js';
import {
  getClaudeMdData,
  getMcpJsonData,
  readPreferences,
  saveClaudeMd,
  savePreferences,
  validateAndSaveMcpJson,
} from '../services/config-files.js';
import { listTimezonesWithMetadata } from '../services/time.js';

// Cache — the list is pure data derived from moment-timezone and Intl,
// neither of which change at runtime. Built once on first request.
let cachedTimezones: ReturnType<typeof listTimezonesWithMetadata> | null = null;

const router = Router();

router.get('/config/claude-md', (_req, res) => {
  res.json(getClaudeMdData());
});

router.put('/config/claude-md', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content must be a string' });
    return;
  }

  try {
    saveClaudeMd(content);
    markForReinit();
    res.json({ success: true, message: 'Personality updated. Takes effect on next message.' });
  } catch {
    res.status(500).json({ error: 'Failed to save' });
  }
});

router.get('/config/mcp-json', (_req, res) => {
  res.json(getMcpJsonData());
});

router.put('/config/mcp-json', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content must be a string' });
    return;
  }

  try {
    validateAndSaveMcpJson(content);
    res.json({ success: true, message: 'MCP config saved. Restart server for changes to take effect.' });
  } catch (error) {
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }

    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Failed to save' });
  }
});

router.get('/timezones', (_req, res) => {
  if (!cachedTimezones) cachedTimezones = listTimezonesWithMetadata();
  res.json(cachedTimezones);
});

router.get('/preferences', (_req, res) => {
  try {
    res.json(readPreferences());
  } catch (error) {
    console.error('Failed to read preferences:', error);
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Failed to read preferences' });
  }
});

router.put('/preferences', (req, res) => {
  try {
    savePreferences(req.body as Record<string, any>);
    res.json({ success: true, message: 'Preferences saved. Restart server for some changes to take effect.' });
  } catch (error) {
    console.error('Failed to save preferences:', error);
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Failed to save preferences' });
  }
});

router.get('/settings', (_req, res) => {
  try {
    const config = getAllConfig();
    res.json({ config });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.put('/settings', (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || typeof key !== 'string' || typeof value !== 'string') {
      res.status(400).json({ error: 'key and value (strings) required' });
      return;
    }

    if (key === 'agent.model') {
      const previous = getConfig('agent.model');
      if (previous !== value) {
        clearAllThreadSessions();
      }
    }

    setConfig(key, value);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating setting:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

router.get('/config', (_req, res) => {
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

router.get('/skills', (_req, res) => {
  try {
    const skills = scanSkills().map(({ name, description }) => ({ name, description }));
    res.json({ skills });
  } catch (error) {
    console.error('Error reading skills:', error);
    res.status(500).json({ error: 'Failed to read skills' });
  }
});

export default router;
