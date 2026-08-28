import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import type { AiStreamEvent } from '@verso/shared';
import { currentUser, requireAuth } from '../auth/middleware.ts';
import { requireDocAccess } from '../docs/access.ts';
import { asyncRoute, parseBody } from '../http/errors.ts';
import { rateLimit } from '../http/rateLimit.ts';
import { config } from '../config.ts';
import { docToText } from '../pm/content.ts';
import { runAsk, runAssist, runSummarize, type AiRun } from './engine.ts';

const assistSchema = z.object({
  docId: z.string().min(1),
  action: z.enum(['rewrite', 'shorten', 'expand', 'grammar', 'tone']),
  text: z.string().min(1, 'Select some text first').max(20_000, 'Selection is too long for AI assist'),
  tone: z.string().trim().max(40).optional(),
});

const askSchema = z.object({
  docId: z.string().min(1),
  question: z.string().trim().min(1, 'Ask a question').max(2_000),
});

const summarizeSchema = z.object({ docId: z.string().min(1) });

export const aiRouter = Router();
aiRouter.use(requireAuth);
// Per-user quota: AI calls can bill an upstream API, so cap request volume.
aiRouter.use(
  rateLimit({
    windowMs: 5 * 60_000,
    max: config.rateLimitAiMax,
    keyFor: (req) => req.user?._id.toString() ?? 'anon',
    message: 'AI request limit reached. Try again in a few minutes.',
  }),
);

function sseWrite(res: Response, event: AiStreamEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Stream an AI run as server-sent events over a POST response body. */
async function streamRun(res: Response, run: AiRun): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  sseWrite(res, {
    type: 'meta',
    engine: run.engine,
    ...(run.model ? { model: run.model } : {}),
    ...(run.note ? { note: run.note } : {}),
  });
  try {
    for await (const text of run.stream) {
      if (res.writableEnded || res.destroyed) return;
      sseWrite(res, { type: 'chunk', text });
    }
    sseWrite(res, { type: 'done' });
  } catch (err) {
    console.error('AI stream failed:', err);
    sseWrite(res, { type: 'error', message: 'The AI request failed. Please try again.' });
  } finally {
    res.end();
  }
}

// POST /api/ai/assist — transform a selected passage (rewrite/shorten/expand/grammar/tone).
aiRouter.post(
  '/assist',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(assistSchema, req.body);
    const { doc } = await requireDocAccess(user._id, body.docId, 'viewer');
    const run = await runAssist({ action: body.action, text: body.text, tone: body.tone, docTitle: doc.title });
    await streamRun(res, run);
  }),
);

// POST /api/ai/summarize — summarize the whole document.
aiRouter.post(
  '/summarize',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(summarizeSchema, req.body);
    const { doc } = await requireDocAccess(user._id, body.docId, 'viewer');
    const run = await runSummarize(doc.title, docToText(doc.content));
    await streamRun(res, run);
  }),
);

// POST /api/ai/ask — grounded Q&A over the document content.
aiRouter.post(
  '/ask',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(askSchema, req.body);
    const { doc } = await requireDocAccess(user._id, body.docId, 'viewer');
    const run = await runAsk(doc.title, docToText(doc.content), body.question);
    await streamRun(res, run);
  }),
);
