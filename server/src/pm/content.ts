import { z } from 'zod';
import type { PMNode } from '@verso/shared';
import { badRequest } from '../http/errors.ts';

/**
 * The document schema the product supports. Mirrors the client editor's
 * StarterKit configuration — content that the editor cannot render is
 * rejected at the API boundary rather than stored blindly.
 */
const NODE_TYPES = new Set([
  'doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem',
  'blockquote', 'codeBlock', 'horizontalRule', 'hardBreak',
]);
const MARK_TYPES = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'link']);

/** Protocols a link mark may carry. Anything else (javascript:, data:, …) is stripped. */
const SAFE_LINK = /^(https?:|mailto:|tel:|\/|#)/i;

const MAX_CONTENT_BYTES = 2 * 1024 * 1024; // 2 MB of JSON per document
const MAX_DEPTH = 60;

const markSchema = z.object({
  type: z.string().refine((t) => MARK_TYPES.has(t), { error: 'Unsupported mark type' }),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const nodeSchema: z.ZodType<PMNode> = z.lazy(() =>
  z.object({
    type: z.string().refine((t) => NODE_TYPES.has(t), { error: 'Unsupported node type' }),
    attrs: z.record(z.string(), z.unknown()).optional(),
    marks: z.array(markSchema).optional(),
    text: z.string().optional(),
    content: z.array(nodeSchema).optional(),
  }),
) as z.ZodType<PMNode>;

export function validateContent(raw: unknown): PMNode {
  const size = Buffer.byteLength(JSON.stringify(raw ?? null));
  if (size > MAX_CONTENT_BYTES) {
    throw badRequest(`Document is too large (${Math.round(size / 1024)} KB, limit ${MAX_CONTENT_BYTES / 1024} KB)`);
  }
  if (depthOf(raw, 0) > MAX_DEPTH) {
    throw badRequest('Document structure is nested too deeply');
  }
  const parsed = nodeSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('Document content is not valid editor JSON', parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  if (parsed.data.type !== 'doc') throw badRequest('Content root must be a "doc" node');
  stripUnsafeLinks(parsed.data);
  return parsed.data;
}

/** Remove link marks whose href is not a safe protocol (defense in depth for exports/consumers). */
function stripUnsafeLinks(node: PMNode): void {
  if (node.marks) {
    node.marks = node.marks.filter((m) => {
      if (m.type !== 'link') return true;
      const href = typeof m.attrs?.href === 'string' ? m.attrs.href.trim() : '';
      return SAFE_LINK.test(href);
    });
    if (node.marks.length === 0) delete node.marks;
  }
  for (const child of node.content ?? []) stripUnsafeLinks(child);
}

function depthOf(node: unknown, depth: number): number {
  if (depth > MAX_DEPTH) return depth;
  if (typeof node !== 'object' || node === null) return depth;
  const content = (node as PMNode).content;
  if (!Array.isArray(content) || content.length === 0) return depth;
  let max = depth;
  for (const child of content) {
    max = Math.max(max, depthOf(child, depth + 1));
  }
  return max;
}

export function emptyDoc(): PMNode {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

/** Build a ProseMirror doc from plain text: blank-line-separated paragraphs. */
export function textToDoc(text: string): PMNode {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return emptyDoc();
  return {
    type: 'doc',
    content: paragraphs.map((p) => {
      const lines = p.split('\n');
      const content: PMNode[] = [];
      lines.forEach((line, i) => {
        if (i > 0) content.push({ type: 'hardBreak' });
        if (line.length > 0) content.push({ type: 'text', text: line });
      });
      return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
    }),
  };
}

/** Flatten a document to plain text (used for AI context and word counts). */
export function docToText(node: PMNode): string {
  const out: string[] = [];
  walkText(node, out);
  return out.join('').trim();
}

function walkText(node: PMNode, out: string[]): void {
  if (node.text) out.push(node.text);
  if (node.type === 'hardBreak') out.push('\n');
  for (const child of node.content ?? []) walkText(child, out);
  if (['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'].includes(node.type)) {
    out.push('\n');
  }
}

export function wordCount(node: PMNode): number {
  const text = docToText(node);
  return text.length === 0 ? 0 : text.split(/\s+/).filter(Boolean).length;
}

/**
 * Serialize a document to GitHub-flavored Markdown for export.
 * Blocks are serialized independently and joined with exactly one blank line,
 * so code-block content (which may legitimately contain blank lines) is
 * never rewritten. Underline has no Markdown syntax and exports as <u>…</u>
 * (HTML passthrough, standard in GFM).
 */
export function docToMarkdown(node: PMNode): string {
  return blocksToMarkdown(node.content ?? [], '') + '\n';
}

function blocksToMarkdown(nodes: PMNode[], indent: string): string {
  return nodes
    .map((n) => blockToMarkdown(n, indent))
    .filter((s) => s.length > 0)
    .join('\n\n');
}

function blockToMarkdown(n: PMNode, indent: string): string {
  switch (n.type) {
    case 'paragraph':
      return indent + inline(n);
    case 'heading': {
      const level = Math.min(Math.max(Number(n.attrs?.level ?? 1), 1), 6);
      return indent + '#'.repeat(level) + ' ' + inline(n);
    }
    case 'bulletList':
      return listToMarkdown(n, indent, () => '- ');
    case 'orderedList': {
      const start = Number(n.attrs?.start ?? 1);
      return listToMarkdown(n, indent, (i) => `${start + i}. `);
    }
    case 'blockquote':
      return blocksToMarkdown(n.content ?? [], '')
        .split('\n')
        .map((line) => indent + '> ' + line)
        .join('\n');
    case 'codeBlock': {
      const lang = typeof n.attrs?.language === 'string' ? n.attrs.language : '';
      const code = rawText(n); // verbatim — no escaping, no normalization
      return indent + '```' + lang + '\n' + code + '\n' + indent + '```';
    }
    case 'horizontalRule':
      return indent + '---';
    default:
      return n.content ? blocksToMarkdown(n.content, indent) : '';
  }
}

function listToMarkdown(list: PMNode, indent: string, bullet: (i: number) => string): string {
  const items = list.content ?? [];
  return items
    .map((item, i) => {
      const marker = bullet(i);
      const body = blocksToMarkdown(item.content ?? [], '');
      const lines = body.split('\n');
      return (
        indent + marker + (lines[0] ?? '') +
        (lines.length > 1 ? '\n' + lines.slice(1).map((l) => indent + ' '.repeat(marker.length) + l).join('\n') : '')
      );
    })
    .join('\n');
}

function rawText(node: PMNode): string {
  let out = node.text ?? '';
  for (const child of node.content ?? []) out += rawText(child);
  return out;
}

/** Escape Markdown metacharacters in plain text runs so exports round-trip. */
function escapeMd(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, '\\$1');
}

function inline(node: PMNode): string {
  const parts: string[] = [];
  for (const child of node.content ?? []) {
    if (child.type === 'hardBreak') {
      parts.push('  \n');
      continue;
    }
    if (child.type === 'text') {
      const marks = new Set((child.marks ?? []).map((m) => m.type));
      let text = marks.has('code') ? '`' + (child.text ?? '') + '`' : escapeMd(child.text ?? '');
      if (marks.has('bold')) text = '**' + text + '**';
      if (marks.has('italic')) text = '*' + text + '*';
      if (marks.has('strike')) text = '~~' + text + '~~';
      if (marks.has('underline')) text = '<u>' + text + '</u>';
      const link = (child.marks ?? []).find((m) => m.type === 'link');
      if (link && typeof link.attrs?.href === 'string') text = `[${text}](${link.attrs.href})`;
      parts.push(text);
    } else {
      parts.push(inline(child));
    }
  }
  return parts.join('');
}
