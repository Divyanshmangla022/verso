/** Central environment configuration. Everything tunable lives here, not inline. */

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got "${raw}"`);
  }
  return n;
}

const isProd = process.env.NODE_ENV === 'production';

const jwtSecret = process.env.JWT_SECRET ?? '';
if (isProd && jwtSecret.length < 24) {
  throw new Error('JWT_SECRET must be set (>= 24 chars) in production');
}

export const config = {
  isProd,
  port: int('PORT', 4000),
  mongoUri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/verso',
  jwtSecret: jwtSecret || 'verso-dev-secret-do-not-use-in-prod',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  maxUploadMb: int('MAX_UPLOAD_MB', 10),
  maxVersionsPerDoc: int('MAX_VERSIONS_PER_DOC', 20),
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  /** Max characters of document text sent to the AI layer per request. */
  aiContextCharLimit: int('AI_CONTEXT_CHAR_LIMIT', 60_000),
  bcryptRounds: int('BCRYPT_ROUNDS', 10),
} as const;
