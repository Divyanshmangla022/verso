import { MongoClient, GridFSBucket, ObjectId, type Db, type Collection } from 'mongodb';
import type { PMNode, ShareRole } from '@verso/shared';
import { config } from './config.ts';

export interface UserDoc {
  _id: ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
}

export interface DocumentDoc {
  _id: ObjectId;
  title: string;
  ownerId: ObjectId;
  content: PMNode;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ShareDoc {
  _id: ObjectId;
  docId: ObjectId;
  userId: ObjectId;
  role: ShareRole;
  grantedBy: ObjectId;
  createdAt: Date;
}

export interface VersionDoc {
  _id: ObjectId;
  docId: ObjectId;
  version: number;
  title: string;
  content: PMNode;
  savedBy: ObjectId | null;
  createdAt: Date;
}

let client: MongoClient | null = null;
let db: Db | null = null;
let bucket: GridFSBucket | null = null;

export async function connectDb(uri: string = config.mongoUri): Promise<Db> {
  if (db) return db;
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(); // db name comes from the URI path
  bucket = new GridFSBucket(db, { bucketName: 'attachments' });
  await ensureIndexes(db);
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('Database not connected - call connectDb() first');
  return db;
}

export function getBucket(): GridFSBucket {
  if (!bucket) throw new Error('Database not connected - call connectDb() first');
  return bucket;
}

export async function closeDb(): Promise<void> {
  await client?.close();
  client = null;
  db = null;
  bucket = null;
}

export const users = (): Collection<UserDoc> => getDb().collection<UserDoc>('users');
export const documents = (): Collection<DocumentDoc> => getDb().collection<DocumentDoc>('documents');
export const shares = (): Collection<ShareDoc> => getDb().collection<ShareDoc>('shares');
export const versions = (): Collection<VersionDoc> => getDb().collection<VersionDoc>('doc_versions');

async function ensureIndexes(database: Db): Promise<void> {
  await Promise.all([
    database.collection('users').createIndex({ email: 1 }, { unique: true }),
    database.collection('documents').createIndex({ ownerId: 1, updatedAt: -1 }),
    database.collection('shares').createIndex({ docId: 1, userId: 1 }, { unique: true }),
    database.collection('shares').createIndex({ userId: 1 }),
    database.collection('doc_versions').createIndex({ docId: 1, version: -1 }),
    database.collection('attachments.files').createIndex({ 'metadata.docId': 1 }),
  ]);
}

/** Parse a client-supplied id; returns null instead of throwing on malformed input. */
export function toObjectId(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}
