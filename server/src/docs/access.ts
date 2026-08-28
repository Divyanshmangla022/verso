import type { ObjectId } from 'mongodb';
import type { DocAccess } from '@verso/shared';
import { documents, shares, toObjectId, type DocumentDoc } from '../db.ts';
import { forbidden, notFound } from '../http/errors.ts';

export async function resolveAccess(userId: ObjectId, doc: DocumentDoc): Promise<DocAccess> {
  if (doc.ownerId.equals(userId)) return 'owner';
  const share = await shares().findOne({ docId: doc._id, userId });
  return share ? share.role : 'none';
}

export interface DocWithAccess {
  doc: DocumentDoc;
  access: Exclude<DocAccess, 'none'>;
}

/**
 * Load a document and assert the user holds at least the required access.
 * 404s on a malformed/unknown id; 403s when the doc exists but access is missing —
 * every document route funnels through this, so authorization is enforced
 * server-side rather than by UI visibility.
 */
export async function requireDocAccess(
  userId: ObjectId,
  docIdRaw: string,
  minimum: 'viewer' | 'editor' | 'owner',
): Promise<DocWithAccess> {
  const docId = toObjectId(docIdRaw);
  if (!docId) throw notFound('Document not found');
  const doc = await documents().findOne({ _id: docId });
  if (!doc) throw notFound('Document not found');
  const access = await resolveAccess(userId, doc);
  if (access === 'none') throw forbidden('You do not have access to this document');
  const rank: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };
  if (rank[access] < rank[minimum]) {
    const need = minimum === 'owner' ? 'Only the owner can do this' : 'You have view-only access to this document';
    throw forbidden(need);
  }
  return { doc, access };
}
