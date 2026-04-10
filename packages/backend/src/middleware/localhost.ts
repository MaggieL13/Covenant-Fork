import type { Request, Response, NextFunction } from 'express';

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLocalhostIp(req: Request): boolean {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return LOCALHOST_IPS.has(ip);
}

export function requireLocalhost(req: Request, res: Response, next: NextFunction): void {
  if (!isLocalhostIp(req)) {
    res.status(403).json({ error: 'Forbidden: localhost only' });
    return;
  }
  next();
}
