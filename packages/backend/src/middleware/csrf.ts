import { Request, Response, NextFunction } from 'express';
import { parse as parseCookie } from 'cookie';
import crypto from 'crypto';
import { getResonantConfig } from '../config.js';

const CSRF_COOKIE = 'resonant_csrf';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Generate a CSRF token signed with the session token via HMAC-SHA256.
 * Returns "token.signature" — the frontend sends this back as a header,
 * and the backend verifies the signature matches the session.
 */
export function generateCsrfToken(sessionToken: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const signature = crypto
    .createHmac('sha256', sessionToken)
    .update(token)
    .digest('hex');
  return `${token}.${signature}`;
}

/**
 * Verify a CSRF token's signature against the session token.
 */
function verifyCsrfToken(csrfValue: string, sessionToken: string): boolean {
  const dotIndex = csrfValue.indexOf('.');
  if (dotIndex === -1) return false;

  const token = csrfValue.slice(0, dotIndex);
  const signature = csrfValue.slice(dotIndex + 1);

  const expected = crypto
    .createHmac('sha256', sessionToken)
    .update(token)
    .digest('hex');

  // Timing-safe comparison
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Set the CSRF cookie on a response. Called after login and on first
 * authenticated request if cookie is missing (grace period).
 */
export function setCsrfCookie(res: Response, csrfToken: string, isSecure: boolean): void {
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false, // frontend must read this
    secure: isSecure,
    sameSite: isSecure ? 'strict' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // match session duration
    path: '/',
  });
}

/**
 * Clear the CSRF cookie. Called on logout.
 */
export function clearCsrfCookie(res: Response): void {
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

/**
 * CSRF protection middleware (double-submit cookie pattern).
 *
 * Mount AFTER authMiddleware. Skips:
 * - Safe methods (GET, HEAD, OPTIONS)
 * - Requests when no password is configured (auth disabled)
 * - Localhost requests (agent CLI / internal tools)
 * - First request after login when cookie hasn't propagated yet (grace period)
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  // Skip safe methods — no state changes
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // Skip if auth is not configured (no password = no sessions = no CSRF risk)
  const config = getResonantConfig();
  if (!config.auth.password) {
    next();
    return;
  }

  // Skip localhost requests (agent CLI, internal tools)
  const remoteAddr = req.socket.remoteAddress || '';
  const isLocalhost = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
  if (isLocalhost) {
    next();
    return;
  }

  // Get session token from cookie (already validated by authMiddleware)
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    res.status(403).json({ error: 'CSRF validation failed' });
    return;
  }

  const cookies = parseCookie(cookieHeader);
  const sessionToken = cookies['resonant_session'];
  const csrfCookie = cookies[CSRF_COOKIE];
  const csrfHeader = req.headers[CSRF_HEADER] as string | undefined;

  // Grace period: if no CSRF cookie exists yet (first request after login
  // before cookie round-trips), set the cookie and let this request through
  if (!csrfCookie) {
    if (sessionToken) {
      const newToken = generateCsrfToken(sessionToken);
      setCsrfCookie(res, newToken, req.headers['x-forwarded-proto'] === 'https');
    }
    next();
    return;
  }

  // Require the header
  if (!csrfHeader) {
    res.status(403).json({ error: 'CSRF token missing' });
    return;
  }

  // Cookie and header must match
  if (csrfCookie !== csrfHeader) {
    res.status(403).json({ error: 'CSRF token mismatch' });
    return;
  }

  // Verify the token signature against the session
  if (!sessionToken || !verifyCsrfToken(csrfCookie, sessionToken)) {
    res.status(403).json({ error: 'CSRF token invalid' });
    return;
  }

  next();
}
