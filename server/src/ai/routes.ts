import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { AI_TONES, type AiStreamEvent } from '@verso/shared';
import { currentUser, requireAuth } from '../auth/middleware.ts';
import { requireDocAccess } from '../docs/access.ts';
import { asyncRoute, parseBody } from '../http/errors.ts';
import { rateLimit } from '../http/rateLimit.ts';
import { config } from '../config.ts';
import { docToText } from '../pm/content.ts';
import { checkAi, describeAiError, runAsk, runAssist, runSummarize, runTitleSuggest, type AiRun } from './engine.ts';

const assistSchema = z.object({
  docId: z.string().min(1),
  action: z.enum(['rewrite', 'shorten', 'expand', 'grammar', 'tone']),
  text: z
    .string()
    .min(1, 'Select some text first')
    .max(50_000, 'That selection is too long for AI assist (limit 50,000 characters). Select a smaller passage.'),
  tone: z.enum(AI_TONES).optional(),
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

/** Abort when the client disconnects or the request outlives its budget. */
function requestSignal(res: Response, ms = 60_000): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  return AbortSignal.any([controller.signal, AbortSignal.timeout(ms)]);
}

/**
 * Stream an AI run as server-sent events over a POST response body.
 * Every path that leaves this function while the client is still connected
 * sends exactly one terminal event ('done' or 'error') - the client's UI stays
 * in its "running" state until it sees one.
 */
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
  let chunks = 0;
  try {
    for await (const text of run.stream) {
      if (res.writableEnded || res.destroyed) return;
      chunks += 1;
      sseWrite(res, { type: 'chunk', text });
    }
    if (chunks === 0) {
      // A model can finish without emitting text (safety stop, or reasoning that
      // consumed the whole output budget). Saying so beats an empty result box.
      sseWrite(res, {
        type: 'error',
        message: 'The AI returned no text for this request. Try again, or select a shorter passage.',
      });
      return;
    }
    sseWrite(res, { type: 'done' });
  } catch (err) {
    if (res.destroyed) return; // client went away; nothing to tell anyone
    if ((err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError') {
      sseWrite(res, { type: 'error', message: 'The AI request took too long and was stopped. Please try again.' });
      return;
    }
    console.error('AI stream failed:', err);
    sseWrite(res, { type: 'error', message: 'The AI request failed. Please try again.', reason: describeAiError(err) });
  } finally {
    res.end();
  }
}

// POST /api/ai/assist - transform a selected passage (rewrite/shorten/expand/grammar/tone).
aiRouter.post(
  '/assist',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(assistSchema, req.body);
    const { doc } = await requireDocAccess(user._id, body.docId, 'viewer');
    const run = await runAssist(
      { action: body.action, text: body.text, tone: body.tone, docTitle: doc.title },
      requestSignal(res),
    );
    await streamRun(res, run);
  }),
);

// POST /api/ai/summarize - summarize the whole document.
aiRouter.post(
  '/summarize',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(summarizeSchema, req.body);
    const { doc } = await requireDocAccess(user._id, body.docId, 'viewer');
    const run = await runSummarize(doc.title, docToText(doc.content), requestSignal(res));
    await streamRun(res, run);
  }),
);

// POST /api/ai/ask - grounded Q&A over the document content.
aiRouter.post(
  '/ask',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(askSchema, req.body);
    const { doc } = await requireDocAccess(user._id, body.docId, 'viewer');
    const run = await runAsk(doc.title, docToText(doc.content), body.question, requestSignal(res));
    await streamRun(res, run);
  }),
);

// POST /api/ai/title - suggest 3 titles for the document (JSON, not streamed).
aiRouter.post(
  '/title',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(summarizeSchema, req.body);
    const { doc } = await requireDocAccess(user._id, body.docId, 'viewer');
    const result = await runTitleSuggest(doc.title, docToText(doc.content));
    res.json(result);
  }),
);

// GET /api/ai/status - live self-check of the configured engine (auth required).
aiRouter.get(
  '/status',
  asyncRoute(async (_req, res) => {
    res.json(await checkAi());
  }),
);
