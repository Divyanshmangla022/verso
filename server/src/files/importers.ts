import { generateJSON } from '@tiptap/html';
import StarterKit from '@tiptap/starter-kit';
import mammoth from 'mammoth';
import MarkdownIt from 'markdown-it';
import type { PMNode } from '@verso/shared';
import { badRequest } from '../http/errors.ts';
import { textToDoc, validateContent } from '../pm/content.ts';

/**
 * Supported import formats. Advertised in the UI upload dialog and README —
 * keep the three in sync (the client reads this list from /api/meta).
 */
export const SUPPORTED_IMPORTS = ['.txt', '.md', '.docx'] as const;

const md = new MarkdownIt({ html: false, linkify: true });

/** The same extension set the client editor runs, so imported JSON always renders. */
const extensions = [StarterKit];

export interface ImportedDoc {
  title: string;
  content: PMNode;
}

export async function importFile(originalName: string, buffer: Buffer): Promise<ImportedDoc> {
  const ext = extensionOf(originalName);
  const fallbackTitle = originalName.replace(/\.[^.]+$/, '').trim() || 'Imported document';

  let content: PMNode;
  switch (ext) {
    case '.txt': {
      content = textToDoc(buffer.toString('utf8'));
      break;
    }
    case '.md': {
      const html = md.render(buffer.toString('utf8'));
      content = sanitizeGenerated(generateJSON(html, extensions));
      break;
    }
    case '.docx': {
      let html: string;
      try {
        const result = await mammoth.convertToHtml({ buffer });
        html = result.value;
      } catch {
        throw badRequest('Could not read this .docx file — it may be corrupted or not a real Word document');
      }
      content = sanitizeGenerated(generateJSON(html, extensions));
      break;
    }
    default:
      throw badRequest(`Unsupported file type "${ext || 'unknown'}". Supported: ${SUPPORTED_IMPORTS.join(', ')}`);
  }

  return { title: deriveTitle(content) ?? fallbackTitle, content };
}

export function extensionOf(name: string): string {
  const match = /\.[^.]+$/.exec(name.toLowerCase());
  return match ? match[0] : '';
}

/**
 * generateJSON can emit nodes outside our supported schema (e.g. images from a
 * docx). Strip unsupported nodes/marks, then run the same validation the save
 * path uses so imports can never store what the editor can't render.
 */
function sanitizeGenerated(raw: unknown): PMNode {
  const cleaned = strip(raw as PMNode);
  const doc = cleaned ?? { type: 'doc', content: [{ type: 'paragraph' }] };
  if (!doc.content || doc.content.length === 0) doc.content = [{ type: 'paragraph' }];
  return validateContent(doc);
}

const KNOWN_NODES = new Set([
  'doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem',
  'blockquote', 'codeBlock', 'horizontalRule', 'hardBreak',
]);
const KNOWN_MARKS = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'link']);

function strip(node: PMNode): PMNode | null {
  if (!KNOWN_NODES.has(node.type)) return null;
  const out: PMNode = { type: node.type };
  if (node.attrs) out.attrs = node.attrs;
  if (node.text !== undefined) out.text = node.text;
  if (node.marks) {
    const marks = node.marks.filter((m) => KNOWN_MARKS.has(m.type));
    if (marks.length > 0) out.marks = marks;
  }
  if (node.content) {
    const children = node.content.map(strip).filter((c): c is PMNode => c !== null);
    if (children.length > 0) out.content = children;
  }
  // Drop container nodes that lost all their children (e.g. a paragraph holding only an image).
  if (['bulletList', 'orderedList', 'listItem', 'blockquote'].includes(node.type) && !out.content) {
    return null;
  }
  return out;
}

/** Use the first heading (or first non-empty line) as the document title. */
function deriveTitle(doc: PMNode): string | null {
  for (const block of doc.content ?? []) {
    if (block.type === 'heading') {
      const text = collectText(block).trim();
      if (text) return text.slice(0, 200);
    }
  }
  for (const block of doc.content ?? []) {
    const text = collectText(block).trim();
    if (text) return text.slice(0, 80);
  }
  return null;
}

function collectText(node: PMNode): string {
  let out = node.text ?? '';
  for (const child of node.content ?? []) out += collectText(child);
  return out;
}
