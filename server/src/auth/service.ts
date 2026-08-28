import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { ObjectId } from 'mongodb';
import type { PublicUser } from '@verso/shared';
import { config } from '../config.ts';
import { users, type UserDoc } from '../db.ts';
import { conflict, unauthorized } from '../http/errors.ts';

export function toPublicUser(u: UserDoc): PublicUser {
  return { id: u._id.toString(), email: u.email, name: u.name };
}

export function signToken(userId: ObjectId): string {
  return jwt.sign({ sub: userId.toString() }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): string {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (typeof payload === 'string' || typeof payload.sub !== 'string') throw new Error('bad payload');
    return payload.sub;
  } catch {
    throw unauthorized('Invalid or expired session - please log in again');
  }
}

export async function registerUser(email: string, name: string, password: string): Promise<UserDoc> {
  const normalized = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  const doc: Omit<UserDoc, '_id'> = {
    email: normalized,
    name: name.trim(),
    passwordHash,
    createdAt: new Date(),
  };
  try {
    const result = await users().insertOne(doc as UserDoc);
    return { ...(doc as UserDoc), _id: result.insertedId };
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
      throw conflict('An account with this email already exists');
    }
    throw err;
  }
}

export async function authenticate(email: string, password: string): Promise<UserDoc> {
  const user = await users().findOne({ email: email.trim().toLowerCase() });
  // Compare against a constant hash on miss so response time doesn't leak account existence.
  const hash = user?.passwordHash ?? '$2b$10$C6UzMDM.H6dfI/f/IKcEeO7ZDzsMDMwlrzUnpVvIvBBlUC2rnoIcm';
  const ok = await bcrypt.compare(password, hash);
  if (!user || !ok) throw unauthorized('Incorrect email or password');
  return user;
}
