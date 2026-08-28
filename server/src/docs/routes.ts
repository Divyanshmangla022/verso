import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import type { DocDetail, DocListResponse, DocSummary, PublicUser, SaveContentResponse, ShareEntry, VersionMeta } from '@verso/shared';
import { currentUser, requireAuth } from '../auth/middleware.ts';
import { toPublicUser } from '../auth/service.ts';
import { documents, shares, users, versions, getBucket, type DocumentDoc, type UserDoc } from '../db.ts';
import { asyncRoute, badRequest, conflict, notFound, parseBody, pathParam } from '../http/errors.ts';
import { docToMarkdown, docToText, emptyDoc, validateContent, wordCount } from '../pm/content.ts';
import { requireDocAccess } from './access.ts';
import { recordRevision } from './versions.ts';

const titleSchema = z.object({
  title: z.string().trim().min(1, 'Title cannot be empty').max(200, 'Title is too long'),
});

const createSchema = z.object({
  title: z.string().trim().max(200).optional(),
});

const saveSchema = z.object({
  content: z.unknown(),
  baseVersion: z.number().int().nonnegative(),
});

export const docsRouter = Router();
docsRouter.use(requireAuth);

/** Batch-load users into a map keyed by id string. */
async function loadUsers(ids: ObjectId[]): Promise<Map<string, UserDoc>> {
  if (ids.length === 0) return new Map();
  const found = await users().find({ _id: { $in: ids } }).toArray();
  return new Map(found.map((u) => [u._id.toString(), u]));
}

function summary(doc: DocumentDoc, owner: PublicUser, myRole: DocSummary['myRole'], sharedWithCount: number): DocSummary {
  return {
    id: doc._id.toString(),
    title: doc.title,
    owner,
    myRole,
    version: doc.version,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    sharedWithCount,
  };
}

// GET /api/docs - the dashboard split: documents I own vs. documents shared with me.
docsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);

    const owned = await documents().find({ ownerId: user._id }).sort({ updatedAt: -1 }).toArray();
    const ownedIds = owned.map((d) => d._id);
    const shareCounts = new Map<string, number>();
    if (ownedIds.length > 0) {
      const grouped = await shares()
        .aggregate<{ _id: ObjectId; count: number }>([
          { $match: { docId: { $in: ownedIds } } },
          { $group: { _id: '$docId', count: { $sum: 1 } } },
        ])
        .toArray();
      for (const g of grouped) shareCounts.set(g._id.toString(), g.count);
    }

    const myShares = await shares().find({ userId: user._id }).toArray();
    const sharedDocs = myShares.length
      ? await documents().find({ _id: { $in: myShares.map((s) => s.docId) } }).toArray()
      : [];
    const roleByDoc = new Map(myShares.map((s) => [s.docId.toString(), s.role]));
    const ownerMap = await loadUsers(sharedDocs.map((d) => d.ownerId));

    const me = toPublicUser(user);
    const body: DocListResponse = {
      owned: owned.map((d) => summary(d, me, 'owner', shareCounts.get(d._id.toString()) ?? 0)),
      shared: sharedDocs
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map((d) => {
          const owner = ownerMap.get(d.ownerId.toString());
          return summary(
            d,
            owner ? toPublicUser(owner) : { id: d.ownerId.toString(), email: 'unknown', name: 'Unknown user' },
            roleByDoc.get(d._id.toString()) ?? 'viewer',
            0,
          );
        }),
    };
    res.json(body);
  }),
);

// POST /api/docs - create a blank document.
docsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { title } = parseBody(createSchema, req.body);
    const now = new Date();
    const doc: Omit<DocumentDoc, '_id'> = {
      title: title || 'Untitled document',
      ownerId: user._id,
      content: emptyDoc(),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const result = await documents().insertOne(doc as DocumentDoc);
    await recordRevision({ docId: result.insertedId, version: 1, title: doc.title, content: doc.content, savedBy: user._id, at: now });
    res.status(201).json(detail({ ...(doc as DocumentDoc), _id: result.insertedId }, toPublicUser(user), 'owner', []));
  }),
);

function detail(doc: DocumentDoc, owner: PublicUser, myRole: DocDetail['myRole'], sharedWith: ShareEntry[] | null): DocDetail {
  const base = summary(doc, owner, myRole, sharedWith?.length ?? 0);
  return { ...base, content: doc.content, ...(sharedWith ? { sharedWith } : {}) };
}

// GET /api/docs/:id - full document, plus the share list when the requester owns it.
docsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { doc, access } = await requireDocAccess(user._id, pathParam(req, 'id'), 'viewer');

    const ownerUser = doc.ownerId.equals(user._id) ? user : await users().findOne({ _id: doc.ownerId });
    const owner: PublicUser = ownerUser ? toPublicUser(ownerUser) : { id: doc.ownerId.toString(), email: 'unknown', name: 'Unknown user' };

    let sharedWith: ShareEntry[] | null = null;
    if (access === 'owner') {
      const entries = await shares().find({ docId: doc._id }).sort({ createdAt: 1 }).toArray();
      const userMap = await loadUsers(entries.map((s) => s.userId));
      sharedWith = entries.flatMap((s) => {
        const u = userMap.get(s.userId.toString());
        return u ? [{ user: toPublicUser(u), role: s.role, createdAt: s.createdAt.toISOString() }] : [];
      });
    }
    res.json(detail(doc, owner, access, sharedWith));
  }),
);

// PATCH /api/docs/:id - rename (owner or editor).
docsRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { title } = parseBody(titleSchema, req.body);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'editor');
    const updatedAt = new Date();
    await documents().updateOne({ _id: doc._id }, { $set: { title, updatedAt } });
    res.json({ title, updatedAt: updatedAt.toISOString() });
  }),
);

// PUT /api/docs/:id/content - autosave with optimistic concurrency.
docsRouter.put(
  '/:id/content',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { content: rawContent, baseVersion } = parseBody(saveSchema, req.body);
    const content = validateContent(rawContent);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'editor');

    const updatedAt = new Date();
    const result = await documents().findOneAndUpdate(
      { _id: doc._id, version: baseVersion },
      { $set: { content, updatedAt }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    );
    if (!result) {
      // Distinguish "someone saved since you loaded" from "the doc was deleted".
      const current = await documents().findOne({ _id: doc._id });
      if (!current) throw notFound('Document not found');
      throw conflict('This document was updated elsewhere. Reload to get the latest version.', {
        currentVersion: current.version,
      });
    }

    // Record the revision that was just committed (correct author + timestamp).
    await recordRevision({
      docId: doc._id,
      version: result.version,
      title: result.title,
      content,
      savedBy: user._id,
      at: updatedAt,
    });

    const body: SaveContentResponse = { version: result.version, updatedAt: updatedAt.toISOString() };
    res.json(body);
  }),
);

// DELETE /api/docs/:id - owner only; removes shares, versions, and attachments too.
docsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'owner');
    const bucket = getBucket();
    const files = await bucket.find({ 'metadata.docId': doc._id }).toArray();
    await Promise.all(files.map((f) => bucket.delete(f._id)));
    await Promise.all([
      shares().deleteMany({ docId: doc._id }),
      versions().deleteMany({ docId: doc._id }),
      documents().deleteOne({ _id: doc._id }),
    ]);
    res.status(204).end();
  }),
);

// GET /api/docs/:id/versions - history metadata, newest first (current revision excluded).
docsRouter.get(
  '/:id/versions',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'viewer');
    const list = await versions()
      .find({ docId: doc._id, version: { $lt: doc.version } })
      .sort({ version: -1 })
      .toArray();
    const userMap = await loadUsers([...new Set(list.flatMap((v) => (v.savedBy ? [v.savedBy] : [])))]);
    const body: VersionMeta[] = list.map((v) => ({
      version: v.version,
      savedBy: v.savedBy ? (userMap.get(v.savedBy.toString()) ? toPublicUser(userMap.get(v.savedBy.toString())!) : null) : null,
      createdAt: v.createdAt.toISOString(),
      wordCount: wordCount(v.content),
    }));
    res.json(body);
  }),
);

// GET /api/docs/:id/versions/:version - preview a historical revision.
docsRouter.get(
  '/:id/versions/:version',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'viewer');
    const versionNum = Number.parseInt(pathParam(req, 'version'), 10);
    if (Number.isNaN(versionNum)) throw badRequest('Invalid version number');
    const rev = await versions().findOne({ docId: doc._id, version: versionNum });
    if (!rev) throw notFound('That revision is no longer available');
    res.json({ version: rev.version, title: rev.title, content: rev.content, createdAt: rev.createdAt.toISOString() });
  }),
);

// POST /api/docs/:id/versions/:version/restore - owner or editor.
// Version-guarded like a normal save: a concurrent edit wins a 409, never silent loss.
docsRouter.post(
  '/:id/versions/:version/restore',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'editor');
    const versionNum = Number.parseInt(pathParam(req, 'version'), 10);
    if (Number.isNaN(versionNum)) throw badRequest('Invalid version number');
    const rev = await versions().findOne({ docId: doc._id, version: versionNum });
    if (!rev) throw notFound('That revision is no longer available');

    const updatedAt = new Date();
    const updated = await documents().findOneAndUpdate(
      { _id: doc._id, version: doc.version },
      { $set: { content: rev.content, updatedAt }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      const current = await documents().findOne({ _id: doc._id });
      if (!current) throw notFound('Document not found');
      throw conflict('This document was updated while restoring. Reload and try again.', {
        currentVersion: current.version,
      });
    }
    await recordRevision({
      docId: doc._id,
      version: updated.version,
      title: updated.title,
      content: rev.content,
      savedBy: user._id,
      at: updatedAt,
    });
    const body: SaveContentResponse & { content: unknown } = {
      version: updated.version,
      updatedAt: updatedAt.toISOString(),
      content: updated.content,
    };
    res.json(body);
  }),
);

// GET /api/docs/:id/export?format=md|txt - download the document.
docsRouter.get(
  '/:id/export',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'viewer');
    const format = req.query.format === 'txt' ? 'txt' : 'md';
    const body = format === 'txt' ? docToText(doc.content) + '\n' : docToMarkdown(doc.content);
    const safeName = doc.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'document';
    res.setHeader('Content-Type', format === 'txt' ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${format}"`);
    res.send(body);
  }),
);
