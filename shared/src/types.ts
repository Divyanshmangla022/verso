/**
 * Shared contract between the Verso server and web client.
 * Erasable-syntax only (type-level) so it runs under Node's native
 * TypeScript type-stripping without a build step.
 */

export type ShareRole = 'viewer' | 'editor';
export type DocAccess = 'owner' | ShareRole | 'none';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
}

export interface AuthResponse {
  token: string;
  user: PublicUser;
}

/** ProseMirror node JSON. Kept loose on purpose: the editor schema owns the shape. */
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

export interface DocSummary {
  id: string;
  title: string;
  owner: PublicUser;
  myRole: DocAccess;
  version: number;
  createdAt: string;
  updatedAt: string;
  sharedWithCount: number;
}

export interface ShareEntry {
  user: PublicUser;
  role: ShareRole;
  createdAt: string;
}

export interface DocDetail extends DocSummary {
  content: PMNode;
  /** Present only when the requester is the owner. */
  sharedWith?: ShareEntry[];
}

export interface DocListResponse {
  owned: DocSummary[];
  shared: DocSummary[];
}

export interface SaveContentResponse {
  version: number;
  updatedAt: string;
}

export interface VersionMeta {
  version: number;
  savedBy: PublicUser | null;
  createdAt: string;
  wordCount: number;
}

export interface AttachmentMeta {
  id: string;
  docId: string;
  name: string;
  size: number;
  mimeType: string;
  uploadedBy: PublicUser | null;
  createdAt: string;
}

export type AiAction = 'rewrite' | 'shorten' | 'expand' | 'grammar' | 'tone';

/** Allowed tones for the tone action - validated server-side, listed client-side. */
export const AI_TONES = ['professional', 'casual', 'friendly', 'formal', 'confident'] as const;
export type AiTone = (typeof AI_TONES)[number];

export interface AiAssistRequest {
  docId: string;
  action: AiAction;
  text: string;
  tone?: string;
}

export interface AiAskRequest {
  docId: string;
  question: string;
}

/** Server-sent event payloads for AI streams. */
export type AiStreamEvent =
  | { type: 'meta'; engine: 'gemini' | 'heuristic'; model?: string; note?: string }
  | { type: 'chunk'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface ApiError {
  error: string;
  details?: unknown;
}

/** Import formats accepted by POST /api/docs/import. Keep README + UI copy in sync. */
export const IMPORT_EXTENSIONS = ['.txt', '.md', '.docx'] as const;
export const MAX_UPLOAD_MB_DEFAULT = 10;
