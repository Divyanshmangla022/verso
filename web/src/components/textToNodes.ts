import type { PMNode } from '@verso/shared';

/** Convert plain AI-generated text into paragraph nodes for insertion. */
export function textToNodes(text: string): PMNode[] {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [{ type: 'paragraph' }];
  return paragraphs.map((p) => {
    const lines = p.split('\n');
    const content: PMNode[] = [];
    lines.forEach((line, i) => {
      if (i > 0) content.push({ type: 'hardBreak' });
      if (line) content.push({ type: 'text', text: line });
    });
    return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
  });
}
