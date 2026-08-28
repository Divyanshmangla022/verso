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
import { extensionOf, importFile, SUPPORTED_IMPORTS } from './importers.ts';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
});

export const filesRouter = Router();
filesRouter.use(requireAuth);

// POST /api/docs/import — turn an uploaded .txt/.md/.docx into a new editable document.
filesRouter.post(
  '/docs/import',
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    if (!req.file) throw badRequest(`Attach a file (field name "file"). Supported: ${SUPPORTED_IMPORTS.join(', ')}`);
    const { title, content } = await importFile(req.file.originalname, req.file.buffer);
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
    res.status(201).json({
      id: result.insertedId.toString(),
      title,
      importedFrom: req.file.originalname,
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

// POST /api/docs/:id/attachments — attach any file to a document (stored in GridFS).
filesRouter.post(
  '/docs/:id/attachments',
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'editor');
    if (!req.file) throw badRequest('Attach a file (field name "file")');
    const bucket = getBucket();
    const uploadStream = bucket.openUploadStream(req.file.originalname, {
      metadata: {
        docId: doc._id,
        uploadedBy: user._id,
        mimeType: req.file.mimetype || 'application/octet-stream',
      },
    });
    await new Promise<void>((resolve, reject) => {
      Readable.from(req.file!.buffer).pipe(uploadStream).on('finish', () => resolve()).on('error', reject);
    });
    const stored = await bucket.find({ _id: uploadStream.id }).next();
    if (!stored) throw notFound('Upload failed');
    res.status(201).json(await attachmentToMeta(stored));
  }),
);

// GET /api/docs/:id/attachments — list a document's attachments.
filesRouter.get(
  '/docs/:id/attachments',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'viewer');
    const files = await getBucket().find({ 'metadata.docId': doc._id }).sort({ uploadDate: -1 }).toArray();
    res.json(await Promise.all(files.map((f) => attachmentToMeta(f))));
  }),
);

// GET /api/docs/:id/attachments/:fileId — download (access-checked, then streamed).
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
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
    bucket.openDownloadStream(fileId).on('error', () => res.destroy()).pipe(res);
  }),
);

// DELETE /api/docs/:id/attachments/:fileId — owner or editor.
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
