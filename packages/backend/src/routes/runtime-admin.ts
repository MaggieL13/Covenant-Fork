import { Router, type Request, type Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PROJECT_ROOT, getResonantConfig } from '../config.js';
import {
  getRuntimeHealth,
  getActiveRuntimeVersion,
  getInstalledRuntimeVersion,
} from '../services/runtime-health.js';

const execFileAsync = promisify(execFile);
const router = Router();

// Module-level lock — prevents two concurrent SDK updates from racing.
// Survives across HTTP requests but NOT across backend restarts (which
// is the right behavior — restart effectively releases the lock since
// any in-flight install was either complete or interrupted).
const updateSdkLock = { running: false };

/**
 * Read-only health snapshot. Active runtime (cached at module load),
 * installed runtime (fresh from disk), system Claude Code, computed
 * minimum requirement across all configured tiers, restart-required flag.
 */
router.get('/health', (_req: Request, res: Response) => {
  try {
    res.json(getRuntimeHealth());
  } catch (error) {
    console.error('Runtime health read error:', error);
    res.status(500).json({ error: 'Failed to read runtime health' });
  }
});

/**
 * Destructive: runs `npm install @anthropic-ai/claude-agent-sdk@latest`
 * in the repo root. Modifies `package-lock.json` and possibly
 * `packages/backend/package.json`. Backend restart required after.
 *
 * Auth gating: requires `auth.password` to be configured in resonant.yaml.
 * The existing authMiddleware in api.ts validates the session before this
 * handler runs. We deliberately do NOT fall back to a "direct localhost"
 * check in passwordless mode: when the backend sits behind a same-host
 * reverse proxy (e.g. nginx forwarding from a public interface to
 * 127.0.0.1), the TCP peer is always loopback, so any localhost-based
 * fallback would expose this destructive endpoint to the public internet.
 * Setting a password is the only safe gate here.
 *
 * Concurrency: in-memory lock prevents two simultaneous updates.
 */
router.post('/update-sdk', async (_req: Request, res: Response) => {
  const cfg = getResonantConfig();
  if (!cfg.auth.password) {
    res.status(403).json({
      error: 'Set auth.password in resonant.yaml before using in-app SDK updates. Passwordless deployments cannot trigger destructive runtime changes (a same-host reverse proxy would otherwise make this endpoint publicly reachable).',
    });
    return;
  }

  if (updateSdkLock.running) {
    res.status(409).json({ error: 'An SDK update is already in progress' });
    return;
  }
  updateSdkLock.running = true;

  try {
    // Platform-aware npm command — `npm.cmd` on Windows, `npm` elsewhere.
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    const result = await execFileAsync(
      npm,
      ['install', '@anthropic-ai/claude-agent-sdk@latest', '--workspace=packages/backend'],
      { cwd: PROJECT_ROOT, timeout: 5 * 60_000 },
    );

    res.json({
      success: true,
      newInstalledVersion: getInstalledRuntimeVersion(),
      activeVersion: getActiveRuntimeVersion(),
      restartRequired: true,
      message: 'SDK updated. Restart the backend for the new bundled runtime to load.',
      stdoutTail: result.stdout.slice(-2000),
    });
  } catch (error) {
    // Surface stderr/stdout tails — distinguishes "network failed" vs
    // "permission denied" vs "lockfile sad" without making the user
    // tail logs manually.
    const err = error as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer };
    res.status(500).json({
      success: false,
      error: err?.message ?? String(error),
      stderrTail: err?.stderr ? String(err.stderr).slice(-2000) : undefined,
      stdoutTail: err?.stdout ? String(err.stdout).slice(-2000) : undefined,
    });
  } finally {
    updateSdkLock.running = false;
  }
});

export default router;
