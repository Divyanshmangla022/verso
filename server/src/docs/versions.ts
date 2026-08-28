import { ObjectId } from 'mongodb';
import type { PMNode } from '@verso/shared';
import { config } from '../config.ts';
import { versions } from '../db.ts';

/**
 * Record a committed revision. Called AFTER a successful versioned write, so
 * each snapshot carries the version/content/user/time of the save itself - 
 * history rows are attributed to the person who actually made that revision.
 */
export async function recordRevision(params: {
  docId: ObjectId;
  version: number;
  title: string;
  content: PMNode;
  savedBy: ObjectId | null;
  at: Date;
}): Promise<void> {
  await versions().insertOne({
    _id: new ObjectId(),
    docId: params.docId,
    version: params.version,
    title: params.title,
    content: params.content,
    savedBy: params.savedBy,
    createdAt: params.at,
  });
  await pruneRevisions(params.docId);
}

/** Keep only the newest MAX_VERSIONS_PER_DOC snapshots for a document. */
export async function pruneRevisions(docId: ObjectId): Promise<void> {
  const excess = await versions()
    .find({ docId })
    .sort({ version: -1 })
    .skip(config.maxVersionsPerDoc)
    .project<{ _id: ObjectId }>({ _id: 1 })
    .toArray();
  if (excess.length > 0) {
    await versions().deleteMany({ _id: { $in: excess.map((v) => v._id) } });
  }
}
