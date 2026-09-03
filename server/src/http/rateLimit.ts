import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './errors.ts';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window in-memory rate limiter. Suited to this deployment shape
 * (single process); swap for a shared store if the app ever scales out.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  /** Key by IP (pre-auth routes) or user id (authed routes). */
  keyFor: (req: Request) => string;
  message: string;
}) {
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    // Periodically drop expired buckets so the map cannot grow unbounded.
    if (now - lastSweep > options.windowMs) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
      lastSweep = now;
    }
    const key = options.keyFor(req);
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      // Tell the caller when it is worth trying again instead of making it guess.
      res.setHeader?.('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      next(new HttpError(429, options.message));
      return;
    }
    next();
  };
}

export function ipKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
