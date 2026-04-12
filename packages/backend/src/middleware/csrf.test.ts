import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock config
vi.mock('../config.js', () => ({
  getResonantConfig: vi.fn().mockReturnValue({
    auth: { password: 'test-password' },
  }),
}));

import { generateCsrfToken, csrfProtection } from './csrf.js';
import { getResonantConfig } from '../config.js';

// Helper to create mock Express req/res/next
function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '192.168.1.100' },
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response & { statusCode: number; body: any } {
  const res = {
    statusCode: 200,
    body: null as any,
    status(code: number) { res.statusCode = code; return res; },
    json(data: any) { res.body = data; return res; },
    cookie: vi.fn(),
  } as unknown as Response & { statusCode: number; body: any };
  return res;
}

describe('CSRF Token Generation', () => {
  it('generates a token with token.signature format', () => {
    const token = generateCsrfToken('session-123');
    expect(token).toContain('.');
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBe(64); // 32 bytes hex
    expect(parts[1].length).toBe(64); // SHA-256 hex
  });

  it('generates different tokens each time', () => {
    const a = generateCsrfToken('session-123');
    const b = generateCsrfToken('session-123');
    expect(a).not.toBe(b);
  });

  it('generates different signatures for different sessions', () => {
    const a = generateCsrfToken('session-aaa');
    const b = generateCsrfToken('session-bbb');
    const sigA = a.split('.')[1];
    const sigB = b.split('.')[1];
    expect(sigA).not.toBe(sigB);
  });
});

describe('CSRF Middleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
    // Reset to auth-enabled config
    vi.mocked(getResonantConfig).mockReturnValue({
      auth: { password: 'test-password' },
    } as any);
  });

  // --- Safe methods pass through ---

  it('passes GET requests without any token', () => {
    const req = mockReq({ method: 'GET' });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes HEAD requests without any token', () => {
    const req = mockReq({ method: 'HEAD' });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes OPTIONS requests without any token', () => {
    const req = mockReq({ method: 'OPTIONS' });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  // --- No auth configured = skip ---

  it('passes when no password is configured', () => {
    vi.mocked(getResonantConfig).mockReturnValue({
      auth: { password: '' },
    } as any);
    const req = mockReq({ method: 'POST' });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  // --- Localhost = skip ---

  it('passes localhost requests (127.0.0.1)', () => {
    const req = mockReq({
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' } as any,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes localhost requests (::1)', () => {
    const req = mockReq({
      method: 'POST',
      socket: { remoteAddress: '::1' } as any,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes localhost requests (::ffff:127.0.0.1)', () => {
    const req = mockReq({
      method: 'POST',
      socket: { remoteAddress: '::ffff:127.0.0.1' } as any,
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  // --- Grace period: no CSRF cookie yet ---

  it('grants grace period when no CSRF cookie exists but session is valid', () => {
    const req = mockReq({
      method: 'POST',
      headers: { cookie: 'resonant_session=valid-session-token' },
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
    // Should set the CSRF cookie for next request
    expect(res.cookie).toHaveBeenCalledWith(
      'resonant_csrf',
      expect.any(String),
      expect.objectContaining({ httpOnly: false })
    );
  });

  // --- Missing header = 403 ---

  it('rejects POST with CSRF cookie but no header', () => {
    const sessionToken = 'valid-session';
    const csrfToken = generateCsrfToken(sessionToken);
    const req = mockReq({
      method: 'POST',
      headers: {
        cookie: `resonant_session=${sessionToken}; resonant_csrf=${csrfToken}`,
      },
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('CSRF token missing');
  });

  // --- Mismatched header = 403 ---

  it('rejects POST when header does not match cookie', () => {
    const sessionToken = 'valid-session';
    const csrfToken = generateCsrfToken(sessionToken);
    const req = mockReq({
      method: 'POST',
      headers: {
        cookie: `resonant_session=${sessionToken}; resonant_csrf=${csrfToken}`,
        'x-csrf-token': 'wrong-token-value',
      },
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('CSRF token mismatch');
  });

  // --- Invalid signature = 403 ---

  it('rejects POST with token signed by wrong session', () => {
    const realSession = 'real-session';
    const attackerSession = 'attacker-session';
    const csrfToken = generateCsrfToken(attackerSession); // signed with wrong key
    const req = mockReq({
      method: 'POST',
      headers: {
        cookie: `resonant_session=${realSession}; resonant_csrf=${csrfToken}`,
        'x-csrf-token': csrfToken,
      },
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('CSRF token invalid');
  });

  // --- Valid token = pass ---

  it('passes POST with valid matching cookie and header', () => {
    const sessionToken = 'valid-session';
    const csrfToken = generateCsrfToken(sessionToken);
    const req = mockReq({
      method: 'POST',
      headers: {
        cookie: `resonant_session=${sessionToken}; resonant_csrf=${csrfToken}`,
        'x-csrf-token': csrfToken,
      },
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes PUT with valid matching cookie and header', () => {
    const sessionToken = 'valid-session';
    const csrfToken = generateCsrfToken(sessionToken);
    const req = mockReq({
      method: 'PUT',
      headers: {
        cookie: `resonant_session=${sessionToken}; resonant_csrf=${csrfToken}`,
        'x-csrf-token': csrfToken,
      },
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes DELETE with valid matching cookie and header', () => {
    const sessionToken = 'valid-session';
    const csrfToken = generateCsrfToken(sessionToken);
    const req = mockReq({
      method: 'DELETE',
      headers: {
        cookie: `resonant_session=${sessionToken}; resonant_csrf=${csrfToken}`,
        'x-csrf-token': csrfToken,
      },
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  // --- No cookies at all = 403 ---

  it('rejects POST with no cookies at all', () => {
    const req = mockReq({
      method: 'POST',
      headers: {},
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
