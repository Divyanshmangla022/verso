import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';

/** Operational error with an HTTP status. Anything else is treated as a 500. */
export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg);
export const forbidden = (msg = 'You do not have access to this resource') => new HttpError(403, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, details);

/** Validate a request body against a zod schema, converting failures to 400s. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = formatZodError(result.error);
    // Lead with the first field's own message ("Selection is too long...")
    // instead of a generic "Validation failed" the user can't act on.
    throw badRequest(issues[0]?.message ?? 'Validation failed', issues);
  }
  return result.data;
}

function formatZodError(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Wrap an async route so rejections reach the error middleware. */
export function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/** Messages for the multer failures a client can actually trigger. */
const MULTER_ERRORS: Record<string, { status: number; message: string }> = {
  LIMIT_FILE_SIZE: { status: 413, message: 'File is too large' },
  LIMIT_FILE_COUNT: { status: 400, message: 'Upload one file at a time' },
  LIMIT_UNEXPECTED_FILE: { status: 400, message: 'Unexpected file field - use the field name "file"' },
  LIMIT_PART_COUNT: { status: 400, message: 'Too many parts in the upload' },
  LIMIT_FIELD_KEY: { status: 400, message: 'Upload field name is too long' },
  LIMIT_FIELD_VALUE: { status: 400, message: 'Upload field value is too long' },
  LIMIT_FIELD_COUNT: { status: 400, message: 'Too many fields in the upload' },
};

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...(err.details !== undefined ? { details: err.details } : {}) });
    return;
  }
  // Multer surfaces its failures with a code rather than an HttpError.
  const code = typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
  const multerError = code ? MULTER_ERRORS[code] : undefined;
  if (multerError) {
    res.status(multerError.status).json({ error: multerError.message });
    return;
  }
  // body-parser (and anything else built on http-errors) raises client errors
  // with a status and an `expose` flag - a malformed or oversized JSON body is
  // the caller's problem, not a 500. Without this the client sees an opaque
  // "Internal server error" and retries a request that can never succeed.
  const status = httpErrorStatus(err);
  if (status !== null && status >= 400 && status < 500) {
    const expose = (err as { expose?: boolean }).expose === true;
    const message =
      status === 413
        ? 'That document is too large to save'
        : expose && err instanceof Error && err.message
          ? err.message
          : 'Malformed request';
    res.status(status).json({ error: message });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
}

function httpErrorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const candidate = (err as { status?: unknown; statusCode?: unknown });
  const value = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  return typeof value === 'number' ? value : null;
}

/** Express 5 types path params as string | string[]; normalize to a single string. */
export function pathParam(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[]>)[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
