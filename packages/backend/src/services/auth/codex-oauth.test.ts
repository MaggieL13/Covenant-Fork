import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─────────────────────────────────────────────────────────────────────────
// Mocking pi-ai's OAuth surface.
//
// `loginOpenAICodex` is the long-running flow. We expose the callbacks the
// service hands in (onAuth, onManualCodeInput) so each test can drive the
// flow synchronously: call onAuth to publish a URL, then resolve the manual
// code promise to complete login.
//
// `refreshOpenAICodexToken` is also mocked so we can control refresh
// success/failure without hitting OpenAI.
// ─────────────────────────────────────────────────────────────────────────

interface LoginCapture {
  onAuth: ((info: { url: string }) => void) | null;
  manualCodePromise: Promise<string> | null;
  resolveLogin: ((creds: { refresh: string; access: string; expires: number }) => void) | null;
  rejectLogin: ((err: Error) => void) | null;
}

const loginCapture: LoginCapture = {
  onAuth: null,
  manualCodePromise: null,
  resolveLogin: null,
  rejectLogin: null,
};

const refreshSpy = vi.fn<(refresh: string) => Promise<{ refresh: string; access: string; expires: number }>>();

vi.mock('@earendil-works/pi-ai/oauth', () => ({
  loginOpenAICodex: vi.fn(async (opts: {
    onAuth: (info: { url: string }) => void;
    onManualCodeInput?: () => Promise<string>;
    onProgress?: (msg: string) => void;
  }) => {
    loginCapture.onAuth = opts.onAuth;
    if (opts.onManualCodeInput) {
      loginCapture.manualCodePromise = opts.onManualCodeInput();
    }
    // Fire onAuth synchronously so startCodexLogin's urlReady race resolves quickly.
    opts.onAuth({ url: 'https://oauth.openai.example/authorize?code_challenge=...' });
    // Park until the test drives completion (resolveLogin) or rejection.
    return new Promise((resolve, reject) => {
      loginCapture.resolveLogin = resolve;
      loginCapture.rejectLogin = reject;
    });
  }),
  refreshOpenAICodexToken: (refresh: string) => refreshSpy(refresh),
}));

// Import AFTER mocks are set up.
const oauthMod = await import('./codex-oauth.js');
const {
  getCodexAuthPath,
  getCodexAuthSnapshot,
  getCodexCredentials,
  getCodexAccessToken,
  isCodexLoggedIn,
  startCodexLogin,
  submitManualCode,
  cancelLoginSession,
  logoutCodex,
  getLoginSession,
  CodexAuthRequiredError,
  _resetForTests,
} = oauthMod;

// ─────────────────────────────────────────────────────────────────────────
// Per-test setup: isolated auth file path, clean module state
// ─────────────────────────────────────────────────────────────────────────

let tmpDir: string;
let authPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'codex-oauth-test-'));
  authPath = join(tmpDir, 'codex-auth.json');
  process.env.CODEX_AUTH_PATH = authPath;
  _resetForTests();
  refreshSpy.mockReset();
  loginCapture.onAuth = null;
  loginCapture.manualCodePromise = null;
  loginCapture.resolveLogin = null;
  loginCapture.rejectLogin = null;
});

afterEach(() => {
  delete process.env.CODEX_AUTH_PATH;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function writeAuthFile(creds: { refresh: string; access: string; expires: number }) {
  writeFileSync(authPath, JSON.stringify(creds, null, 2), 'utf8');
}

function farFuture(): number { return Date.now() + 24 * 3600_000; }
function nearExpiry(): number { return Date.now() + 60_000; }  // 1 min — below 5-min refresh threshold

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('codex-oauth — path resolution', () => {
  it('honors CODEX_AUTH_PATH env override', () => {
    expect(getCodexAuthPath()).toBe(authPath);
  });

  it('falls back to PROJECT_ROOT/data/codex-auth.json when env unset', () => {
    delete process.env.CODEX_AUTH_PATH;
    const path = getCodexAuthPath();
    expect(path).toMatch(/[\\/]data[\\/]codex-auth\.json$/);
  });
});

describe('codex-oauth — snapshot when not logged in', () => {
  it('reports loggedIn=false when no auth file exists', async () => {
    const snap = await getCodexAuthSnapshot();
    expect(snap.loggedIn).toBe(false);
    expect(snap.expiresAt).toBeNull();
    expect(snap.refreshable).toBe(false);
    expect(snap.loginSession.status).toBe('idle');
  });

  it('isCodexLoggedIn() returns false when no file exists', () => {
    expect(isCodexLoggedIn()).toBe(false);
  });

  it('reports loggedIn=false when file is malformed JSON', async () => {
    writeFileSync(authPath, '{ garbage', 'utf8');
    const snap = await getCodexAuthSnapshot();
    expect(snap.loggedIn).toBe(false);
  });

  it('reports loggedIn=false when JSON is missing required fields', async () => {
    writeFileSync(authPath, JSON.stringify({ refresh: 'only-refresh' }), 'utf8');
    const snap = await getCodexAuthSnapshot();
    expect(snap.loggedIn).toBe(false);
  });
});

describe('codex-oauth — snapshot when logged in', () => {
  it('reports loggedIn=true and surfaces expiry when file is valid', async () => {
    const expires = farFuture();
    writeAuthFile({ refresh: 'r1', access: 'a1', expires });
    const snap = await getCodexAuthSnapshot();
    expect(snap.loggedIn).toBe(true);
    expect(snap.expiresAt).toBe(expires);
    expect(snap.refreshable).toBe(true);
    expect(snap.authPath).toBe(authPath);
  });

  it('isCodexLoggedIn() returns true when file exists (sync, no JSON parse)', () => {
    writeAuthFile({ refresh: 'r1', access: 'a1', expires: farFuture() });
    expect(isCodexLoggedIn()).toBe(true);
  });
});

describe('codex-oauth — refresh', () => {
  it('refreshes when access token is within the lead-time window', async () => {
    writeAuthFile({ refresh: 'old-refresh', access: 'old-access', expires: nearExpiry() });
    refreshSpy.mockResolvedValueOnce({ refresh: 'new-refresh', access: 'new-access', expires: farFuture() });

    const creds = await getCodexCredentials();
    expect(refreshSpy).toHaveBeenCalledWith('old-refresh');
    expect(creds?.access).toBe('new-access');

    // Persisted: subsequent reads see the new tokens.
    const snap = await getCodexAuthSnapshot();
    expect(snap.expiresAt).toBeGreaterThan(Date.now() + 3600_000);
  });

  it('does NOT refresh when access token has plenty of life left', async () => {
    writeAuthFile({ refresh: 'r1', access: 'a1', expires: farFuture() });
    const creds = await getCodexCredentials();
    expect(creds?.access).toBe('a1');
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('returns null when refresh fails', async () => {
    writeAuthFile({ refresh: 'r1', access: 'a1', expires: nearExpiry() });
    refreshSpy.mockRejectedValueOnce(new Error('refresh failed'));
    const creds = await getCodexCredentials();
    expect(creds).toBeNull();
  });

  it('serializes concurrent refresh attempts (mutex)', async () => {
    writeAuthFile({ refresh: 'r1', access: 'a1', expires: nearExpiry() });
    refreshSpy.mockResolvedValueOnce({ refresh: 'r2', access: 'a2', expires: farFuture() });

    // Fire two concurrent reads; both detect "near expiry" and would each
    // try to refresh without the mutex.
    const [c1, c2] = await Promise.all([getCodexCredentials(), getCodexCredentials()]);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(c1?.access).toBe('a2');
    expect(c2?.access).toBe('a2');
  });
});

describe('codex-oauth — getCodexAccessToken', () => {
  it('throws CodexAuthRequiredError when not logged in', async () => {
    await expect(getCodexAccessToken()).rejects.toBeInstanceOf(CodexAuthRequiredError);
  });

  it('returns access token when logged in', async () => {
    writeAuthFile({ refresh: 'r', access: 'live-access-token', expires: farFuture() });
    expect(await getCodexAccessToken()).toBe('live-access-token');
  });
});

describe('codex-oauth — logout', () => {
  it('deletes the credentials file', async () => {
    writeAuthFile({ refresh: 'r', access: 'a', expires: farFuture() });
    expect(existsSync(authPath)).toBe(true);
    await logoutCodex();
    expect(existsSync(authPath)).toBe(false);
  });

  it('is idempotent when no file exists', async () => {
    await expect(logoutCodex()).resolves.toBeUndefined();
  });
});

describe('codex-oauth — login flow', () => {
  it('startCodexLogin returns URL via onAuth callback', async () => {
    const snap = await startCodexLogin();
    expect(snap.status).toBe('awaiting_browser');
    expect(snap.url).toMatch(/^https:\/\/oauth\.openai\.example/);
  });

  it('a second startCodexLogin while one is in-flight returns the existing session', async () => {
    const first = await startCodexLogin();
    const second = await startCodexLogin();
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.url).toBe(first.url);
  });

  it('submitManualCode resolves the flow and persists credentials', async () => {
    await startCodexLogin();
    expect(loginCapture.manualCodePromise).not.toBeNull();

    const accepted = submitManualCode('test-auth-code');
    expect(accepted).toBe(true);

    // The mock's manualCodePromise should resolve, but our login flow
    // returns a parked promise. Drive it to completion explicitly.
    expect(loginCapture.resolveLogin).not.toBeNull();
    loginCapture.resolveLogin!({
      refresh: 'fresh-refresh',
      access: 'fresh-access',
      expires: farFuture(),
    });

    // Allow the background promise (writeCredentials → status='complete') to run.
    await vi.waitFor(() => {
      expect(getLoginSession().status).toBe('complete');
    });

    // Credentials written.
    expect(existsSync(authPath)).toBe(true);
    const persisted = JSON.parse(await fs.readFile(authPath, 'utf8'));
    expect(persisted.access).toBe('fresh-access');
  });

  it('submitManualCode returns false when no login is awaiting', () => {
    expect(submitManualCode('any-code')).toBe(false);
  });

  it('cancelLoginSession transitions to cancelled and rejects the manual-code promise', async () => {
    await startCodexLogin();
    const promise = loginCapture.manualCodePromise!;

    cancelLoginSession();
    expect(getLoginSession().status).toBe('idle');  // module-level cleared

    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it('a login failure surfaces an error in getLoginSession', async () => {
    await startCodexLogin();
    expect(loginCapture.rejectLogin).not.toBeNull();
    loginCapture.rejectLogin!(new Error('network down'));

    await vi.waitFor(() => {
      const s = getLoginSession();
      expect(s.status).toBe('failed');
      expect(s.error).toContain('network down');
    });
  });
});
