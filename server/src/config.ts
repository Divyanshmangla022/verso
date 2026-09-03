/** Central environment configuration. Everything tunable lives here, not inline. */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got "${raw}"`);
  }
  return n;
}

/** Like int(), but 0 is a meaningful value (e.g. "no proxy in front of us"). */
function count(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`Invalid ${name}: expected a non-negative integer, got "${raw}"`);
  }
  return n;
}

const isProd = process.env.NODE_ENV === 'production';

/**
 * JWT secret: required in production. In development, generate a random
 * secret once per machine and persist it to a gitignored file, so sessions
 * survive `node --watch` restarts without a hardcoded fallback in the repo.
 */
function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET ?? '';
  if (isProd) {
    if (fromEnv.length < 24) throw new Error('JWT_SECRET must be set (>= 24 chars) in production');
    return fromEnv;
  }
  if (fromEnv) return fromEnv;
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.local');
  const file = path.join(dir, 'dev-jwt-secret');
  try {
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    mkdirSync(dir, { recursive: true });
    const secret = randomBytes(32).toString('hex');
    writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  } catch {
    // Read-only filesystem (e.g. some CI sandboxes): fall back to ephemeral.
    return randomBytes(32).toString('hex');
  }
}

export const config = {
  isProd,
  port: int('PORT', 4000),
  mongoUri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/verso',
  jwtSecret: resolveJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  maxUploadMb: int('MAX_UPLOAD_MB', 10),
  maxVersionsPerDoc: int('MAX_VERSIONS_PER_DOC', 20),
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.6-flash',
  /** Max characters of document text sent to the AI layer per request. */
  aiContextCharLimit: int('AI_CONTEXT_CHAR_LIMIT', 60_000),
  bcryptRounds: int('BCRYPT_ROUNDS', 10),
  rateLimitAuthMax: int('RATE_LIMIT_AUTH_MAX', 30),
  rateLimitAiMax: int('RATE_LIMIT_AI_MAX', 60),
  rateLimitUploadMax: int('RATE_LIMIT_UPLOAD_MAX', 40),
  /**
   * How many reverse proxies sit in front of this process. Express only reads
   * X-Forwarded-For when it is told how far to trust it; with the default (0)
   * every request behind a proxy reports the proxy's address, which would
   * collapse the per-IP rate limiters into one shared bucket. Render puts a
   * single hop in front of the container, hence the production default.
   * Never use `true`: that lets any client spoof its address.
   */
  trustProxyHops: count('TRUST_PROXY_HOPS', isProd ? 1 : 0),
} as const;
