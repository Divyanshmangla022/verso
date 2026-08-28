import { Router } from 'express';
import { z } from 'zod';
import type { AuthResponse } from '@verso/shared';
import { asyncRoute, parseBody } from '../http/errors.ts';
import { ipKey, rateLimit } from '../http/rateLimit.ts';
import { config } from '../config.ts';
import { currentUser, requireAuth } from './middleware.ts';
import { authenticate, registerUser, signToken, toPublicUser } from './service.ts';

const EMAIL = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address'));

const registerSchema = z.object({
  email: EMAIL,
  name: z.string().trim().min(1, 'Name is required').max(80, 'Name is too long'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

const loginSchema = z.object({
  email: EMAIL,
  password: z.string().min(1, 'Password is required'),
});

export const authRouter = Router();

// Per-IP throttle on credential endpoints: blunts brute force and mass signup.
authRouter.use(
  ['/login', '/register'],
  rateLimit({ windowMs: 5 * 60_000, max: config.rateLimitAuthMax, keyFor: ipKey, message: 'Too many attempts. Try again in a few minutes.' }),
);

authRouter.post(
  '/register',
  asyncRoute(async (req, res) => {
    const { email, name, password } = parseBody(registerSchema, req.body);
    const user = await registerUser(email, name, password);
    const body: AuthResponse = { token: signToken(user._id), user: toPublicUser(user) };
    res.status(201).json(body);
  }),
);

authRouter.post(
  '/login',
  asyncRoute(async (req, res) => {
    const { email, password } = parseBody(loginSchema, req.body);
    const user = await authenticate(email, password);
    const body: AuthResponse = { token: signToken(user._id), user: toPublicUser(user) };
    res.json(body);
  }),
);

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: toPublicUser(currentUser(req)) });
});
