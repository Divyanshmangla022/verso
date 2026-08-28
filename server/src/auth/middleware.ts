import type { NextFunction, Request, Response } from 'express';
import { toObjectId, users, type UserDoc } from '../db.ts';
import { unauthorized } from '../http/errors.ts';
import { verifyToken } from './service.ts';

// Express request augmented with the authenticated user.
declare module 'express-serve-static-core' {
  interface Request {
    user?: UserDoc;
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    next(unauthorized());
    return;
  }
  let userId: string;
  try {
    userId = verifyToken(token);
  } catch (err) {
    next(err);
    return;
  }
  const oid = toObjectId(userId);
  if (!oid) {
    next(unauthorized());
    return;
  }
  users()
    .findOne({ _id: oid })
    .then((user) => {
      if (!user) {
        next(unauthorized('Account no longer exists'));
        return;
      }
      req.user = user;
      next();
    })
    .catch(next);
}

/** Narrowing helper: routes behind requireAuth can assume req.user exists. */
export function currentUser(req: Request): UserDoc {
  if (!req.user) throw unauthorized();
  return req.user;
}
