import { Router } from 'express';
import multer from 'multer';
import { ObjectId } from 'mongodb';
import { Readable } from 'node:stream';
import type { AttachmentMeta, PublicUser } from '@verso/shared';
import { currentUser, requireAuth } from '../auth/middleware.ts';
import { toPublicUser } from '../auth/service.ts';
import { config } from '../config.ts';
import { documents, getBucket, toObjectId, users, type DocumentDoc } from '../db.ts';
import { requireDocAccess } from '../docs/access.ts';
import { asyncRoute, badRequest, notFound, pathParam } from '../http/errors.ts';
import { rateLimit } from '../http/rateLimit.ts';
import { importFile, SUPPORTED_IMPORTS } from './importers.ts';
import { recordRevision } from '../docs/versions.ts';

/** multer decodes filenames as latin1; recover UTF-8 names (é, 中, ...). */
function decodeFilename(name: string): string {
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    // U+FFFD in the result means those bytes were not UTF-8 (e.g. a client that
    // sent RFC 5987 filename*, which busboy already decoded) - keep the original.
    return decoded.includes('\uFFFD') ? name : decoded;
  } catch {
    return name;
  }
}

/** RFC 6266/5987 disposition: an ASCII fallback plus the real UTF-8 name. */
function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
});

export const filesRouter = Router();
filesRouter.use(requireAuth);

// Uploads are buffered in memory before they reach GridFS (and .docx imports are
// inflated on top of that), so request volume - not just per-file size - decides
// peak memory. Cap the write paths per user; reads stay unthrottled.
const uploadLimit = rateLimit({
  windowMs: 5 * 60_000,
  max: config.rateLimitUploadMax,
  keyFor: (req) => req.user?._id.toString() ?? 'anon',
  message: 'Too many uploads. Try again in a few minutes.',
});

// POST /api/docs/import - turn an uploaded .txt/.md/.docx into a new editable document.
filesRouter.post(
  '/docs/import',
  uploadLimit,
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    if (!req.file) throw badRequest(`Attach a file (field name "file"). Supported: ${SUPPORTED_IMPORTS.join(', ')}`);
    const originalName = decodeFilename(req.file.originalname);
    const { title, content, warnings } = await importFile(originalName, req.file.buffer);
    const now = new Date();
    const doc: Omit<DocumentDoc, '_id'> = {
      title,
      ownerId: user._id,
      content,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const result = await documents().insertOne(doc as DocumentDoc);
    await recordRevision({ docId: result.insertedId, version: 1, title, content, savedBy: user._id, at: now });
    res.status(201).json({
      id: result.insertedId.toString(),
      title,
      importedFrom: originalName,
      warnings,
    });
  }),
);

const attachmentToMeta = async (file: {
  _id: ObjectId;
  length: number;
  uploadDate: Date;
  filename: string;
  metadata?: { docId?: ObjectId; uploadedBy?: ObjectId; mimeType?: string };
}): Promise<AttachmentMeta> => {
  let uploadedBy: PublicUser | null = null;
  if (file.metadata?.uploadedBy) {
    const u = await users().findOne({ _id: file.metadata.uploadedBy });
    if (u) uploadedBy = toPublicUser(u);
  }
  return {
    id: file._id.toString(),
    docId: file.metadata?.docId?.toString() ?? '',
    name: file.filename,
    size: file.length,
    mimeType: file.metadata?.mimeType ?? 'application/octet-stream',
    uploadedBy,
    createdAt: file.uploadDate.toISOString(),
  };
};

// POST /api/docs/:id/attachments - attach any file to a document (stored in GridFS).
filesRouter.post(
  '/docs/:id/attachments',
  uploadLimit,
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'editor');
    if (!req.file) throw badRequest('Attach a file (field name "file")');
    const bucket = getBucket();
    const uploadStream = bucket.openUploadStream(decodeFilename(req.file.originalname), {
      metadata: {
        docId: doc._id,
        uploadedBy: user._id,
        mimeType: req.file.mimetype || 'application/octet-stream',
      },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        Readable.from(req.file!.buffer).pipe(uploadStream).on('finish', () => resolve()).on('error', reject);
      });
    } catch (err) {
      // Abort the half-written GridFS file so no orphan chunks remain.
      await uploadStream.abort().catch(() => undefined);
      throw err;
    }
    // The document can be deleted while these bytes are still streaming; the
    // delete cascade would then miss this file and leave it unreachable forever.
    const stillExists = await documents().findOne({ _id: doc._id }, { projection: { _id: 1 } });
    if (!stillExists) {
      await bucket.delete(uploadStream.id).catch(() => undefined);
      throw notFound('Document not found');
    }
    const stored = await bucket.find({ _id: uploadStream.id }).next();
    if (!stored) throw notFound('Upload failed');
    res.status(201).json(await attachmentToMeta(stored));
  }),
);

// GET /api/docs/:id/attachments - list a document's attachments.
filesRouter.get(
  '/docs/:id/attachments',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'viewer');
    const files = await getBucket().find({ 'metadata.docId': doc._id }).sort({ uploadDate: -1 }).toArray();
    res.json(await Promise.all(files.map((f) => attachmentToMeta(f))));
  }),
);

// GET /api/docs/:id/attachments/:fileId - download (access-checked, then streamed).
filesRouter.get(
  '/docs/:id/attachments/:fileId',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'viewer');
    const fileId = toObjectId(pathParam(req, 'fileId'));
    if (!fileId) throw notFound('Attachment not found');
    const bucket = getBucket();
    const file = await bucket.find({ _id: fileId, 'metadata.docId': doc._id }).next();
    if (!file) throw notFound('Attachment not found');
    res.setHeader('Content-Type', file.metadata?.mimeType ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(file.length));
    res.setHeader('Content-Disposition', attachmentDisposition(file.filename));
    bucket.openDownloadStream(fileId).on('error', () => res.destroy()).pipe(res);
  }),
);

// DELETE /api/docs/:id/attachments/:fileId - owner or editor.
filesRouter.delete(
  '/docs/:id/attachments/:fileId',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'editor');
    const fileId = toObjectId(pathParam(req, 'fileId'));
    if (!fileId) throw notFound('Attachment not found');
    const bucket = getBucket();
    const file = await bucket.find({ _id: fileId, 'metadata.docId': doc._id }).next();
    if (!file) throw notFound('Attachment not found');
    await bucket.delete(fileId);
    res.status(204).end();
  }),
);
