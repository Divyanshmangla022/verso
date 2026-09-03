import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Node as PMModelNode, type Schema } from '@tiptap/pm/model';
import { z } from 'zod';
import type { PMNode } from '@verso/shared';
import { badRequest } from '../http/errors.ts';

/**
 * The document schema the product supports. Mirrors the client editor's
 * StarterKit configuration - content that the editor cannot render is
 * rejected at the API boundary rather than stored blindly.
 */
const NODE_TYPES = new Set([
  'doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem',
  'blockquote', 'codeBlock', 'horizontalRule', 'hardBreak',
]);
const MARK_TYPES = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'link']);

/** Protocols a link mark may carry. Anything else (javascript:, data:, ...) is stripped. */
const SAFE_LINK = /^(https?:|mailto:|tel:|\/|#)/i;

const MAX_CONTENT_BYTES = 2 * 1024 * 1024; // 2 MB of JSON per document
const MAX_DEPTH = 60;

const markSchema = z.object({
  type: z.string().refine((t) => MARK_TYPES.has(t), { error: 'Unsupported mark type' }),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const nodeSchema: z.ZodType<PMNode> = z.lazy(() =>
  z
    .object({
      type: z.string().refine((t) => NODE_TYPES.has(t), { error: 'Unsupported node type' }),
      attrs: z.record(z.string(), z.unknown()).optional(),
      marks: z.array(markSchema).optional(),
      text: z.string().optional(),
      content: z.array(nodeSchema).optional(),
    })
    // ProseMirror refuses to construct a text node with an empty or missing
    // string, and TipTap silently replaces the whole document when that happens
    // on load - so a document like that must never be stored.
    .refine((n) => n.type !== 'text' || (typeof n.text === 'string' && n.text.length > 0), {
      error: 'Text nodes must carry non-empty text',
    })
    .refine((n) => n.type !== 'text' || n.content === undefined, {
      error: 'Text nodes cannot have child content',
    })
    // StarterKit renders h1-h6 and silently falls back to h1 for anything else,
    // while the Markdown exporter would clamp it differently. Reject instead of
    // letting the two disagree.
    .refine((n) => n.type !== 'heading' || isHeadingLevel(n.attrs?.level), {
      error: 'Heading level must be an integer between 1 and 6',
    }),
) as z.ZodType<PMNode>;

function isHeadingLevel(level: unknown): boolean {
  return typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 6;
}

/**
 * The editor's real schema, built from the same StarterKit the client runs.
 * Built once, lazily, so importing this module stays cheap.
 */
let editorSchema: Schema | null = null;
function schema(): Schema {
  editorSchema ??= getSchema([StarterKit]);
  return editorSchema;
}

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
  assertEditorCanLoad(parsed.data);
  return parsed.data;
}

/**
 * Final gate: build the document against the editor's own schema. The allowlist
 * above catches unknown names; this catches valid names in invalid arrangements
 * (a listItem holding text directly, a paragraph nested in a paragraph, marks
 * where the schema forbids them) that would break the editor on load.
 */
function assertEditorCanLoad(doc: PMNode): void {
  try {
    PMModelNode.fromJSON(schema(), doc).check();
  } catch (err) {
    throw badRequest('Document content is not valid editor JSON', [
      { path: '', message: err instanceof Error ? err.message.slice(0, 200) : 'Invalid document structure' },
    ]);
  }
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
    // CRLF (Windows) and bare CR (classic Mac, some exported logs) both mean "new line".
    .replace(/\r\n?/g, '\n')
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
 * never rewritten. Underline has no Markdown syntax and exports as <u>...</u>
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
      return indent + escapeBlockStarts(inline(n));
    case 'heading': {
      const level = Math.min(Math.max(Number(n.attrs?.level ?? 1), 1), 6);
      // A heading is a single line: a hard break inside it would end the heading,
      // so it becomes a space instead.
      return indent + '#'.repeat(level) + ' ' + inline(n, { breakAs: ' ' });
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
      const rawLang = typeof n.attrs?.language === 'string' ? n.attrs.language : '';
      const lang = /^[\w+#.-]*$/.test(rawLang) ? rawLang : '';
      const code = rawText(n); // verbatim - no escaping, no normalization
      // The fence must be longer than the longest backtick run in the code,
      // otherwise the block ends early.
      const fence = '`'.repeat(Math.max(3, longestBacktickRun(code) + 1));
      return indent + fence + lang + '\n' + code + '\n' + indent + fence;
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
  return text.replace(/([\\`*_[\]<>~|])/g, '\\$1');
}

/**
 * Escape constructs that only mean something at the start of a line. Without
 * this a plain paragraph reading "1. Install" or "- note" or "# not a heading"
 * comes back from the export as a list or a heading that the user never wrote.
 */
function escapeBlockStarts(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.replace(/^(\s*)(#{1,6}[ \t]|[-+][ \t]|\d{1,9}[.)][ \t]|>|-{3,}\s*$|={3,}\s*$)/, (_m, ws: string, marker: string) => `${ws}\\${marker}`),
    )
    .join('\n');
}

function longestBacktickRun(text: string): number {
  return (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
}

/** Wrap inline code in a backtick run long enough to survive backticks inside it. */
function codeSpan(text: string): string {
  const fence = '`'.repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return fence + pad + text + pad + fence;
}

/**
 * Percent-encode the characters that would terminate a Markdown link target.
 * Note encodeURIComponent leaves parentheses alone, which is exactly the case
 * that breaks `[text](href)`, so the escape is written out here.
 */
function linkTarget(href: string): string {
  return href.replace(/[()<>"\s]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function inline(node: PMNode, options: { breakAs?: string } = {}): string {
  const parts: string[] = [];
  for (const child of node.content ?? []) {
    if (child.type === 'hardBreak') {
      parts.push(options.breakAs ?? '  \n');
      continue;
    }
    if (child.type === 'text') {
      const marks = new Set((child.marks ?? []).map((m) => m.type));
      let text = marks.has('code') ? codeSpan(child.text ?? '') : escapeMd(child.text ?? '');
      if (marks.has('bold')) text = '**' + text + '**';
      if (marks.has('italic')) text = '*' + text + '*';
      if (marks.has('strike')) text = '~~' + text + '~~';
      if (marks.has('underline')) text = '<u>' + text + '</u>';
      const link = (child.marks ?? []).find((m) => m.type === 'link');
      if (link && typeof link.attrs?.href === 'string') text = `[${text}](${linkTarget(link.attrs.href)})`;
      parts.push(text);
    } else {
      parts.push(inline(child, options));
    }
  }
  return parts.join('');
}
