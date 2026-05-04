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
 * Localhost check that bypasses Express's `trust proxy` setting. Express
 * has `app.set('trust proxy', 1)` (server.ts:72), which means `req.ip`
 * honors the `X-Forwarded-For` header — a remote attacker behind a
 * misconfigured proxy could forge a localhost source IP. For the
 * destructive endpoint's password-optional fallback, we use the actual
 * TCP-level peer address instead, which can't be spoofed via headers.
 */
function isDirectLocalhost(req: Request): boolean {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

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
 * Auth gating:
 * - If `auth.password` is configured in resonant.yaml, the existing
 *   authMiddleware in api.ts has already validated the session by the
 *   time we get here.
 * - If `auth.password` is empty (passwordless mode), require the request
 *   to come from a direct localhost connection. Without this fallback,
 *   any network-reachable client could trigger an `npm install` on a
 *   passwordless deployment — a real risk for VPS installs where the
 *   operator forgot to configure a password.
 *
 * Concurrency: in-memory lock prevents two simultaneous updates.
 */
router.post('/update-sdk', async (req: Request, res: Response) => {
  const cfg = getResonantConfig();
  if (!cfg.auth.password && !isDirectLocalhost(req)) {
    res.status(403).json({
      error: 'SDK update requires either an auth password or a direct localhost connection. Set auth.password in resonant.yaml, or run this from the same host.',
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
