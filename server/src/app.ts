import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiRouter } from './ai/routes.ts';
import { authRouter } from './auth/routes.ts';
import { config } from './config.ts';
import { docsRouter } from './docs/routes.ts';
import { shareRouter } from './docs/shareRoutes.ts';
import { errorMiddleware, notFound } from './http/errors.ts';
import { filesRouter } from './files/routes.ts';
import { SUPPORTED_IMPORTS } from './files/importers.ts';
import { geminiAvailable } from './ai/engine.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '3mb' }));

  // Security headers (single-origin SPA + API; inline styles allowed for React style props).
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    next();
  });

  // Minimal CORS: only needed for the Vite dev server; prod serves web from this process.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && origin === config.clientOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // One line per API request (no bodies, no tokens) - enough to debug without leaking.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'verso', time: new Date().toISOString() });
  });

  // Runtime metadata the client reads at startup (keeps UI copy in sync with server limits).
  app.get('/api/meta', async (_req, res) => {
    res.json({
      supportedImports: SUPPORTED_IMPORTS,
      maxUploadMb: config.maxUploadMb,
      ai: {
        enabled: await geminiAvailable(),
        engine: (await geminiAvailable()) ? 'gemini' : 'heuristic',
        selectionCharLimit: 50_000,
      },
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/docs', docsRouter);
  app.use('/api/docs', shareRouter);
  app.use('/api', filesRouter);
  app.use('/api/ai', aiRouter);

  app.use('/api', (_req, _res, next) => next(notFound('Unknown API route')));

  // In production the server also serves the built web app (single-process deploy).
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: 'index.html', maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use(errorMiddleware);
  return app;
}
