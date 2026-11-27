/**
 * Tiptap v3's StarterKit bundles Link and Underline. The server must keep
 * accepting them on save and on import, or formatting silently disappears.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { validateContent } from '../src/pm/content.ts';
import { importFile } from '../src/files/importers.ts';

describe('Tiptap StarterKit v3 schema', () => {
  it('pins a Tiptap release that includes the v3 API', () => {
    const { dependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const [major, minor] = dependencies['@tiptap/core'].match(/\d+\.\d+/)[0].split('.').map(Number);
    assert.ok(major > 3 || (major === 3 && minor >= 33), `@tiptap/core is ${dependencies['@tiptap/core']}`);
  });

  it('keeps link and underline marks on saved content', () => {
    const content = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          text: 'example',
          marks: [{ type: 'link', attrs: { href: 'https://example.test/doc' } }, { type: 'underline' }],
        }],
      }],
    };
    assert.deepEqual(validateContent(content), content);
  });

  it('imports a markdown link as a link mark', async () => {
    const imported = await importFile('notes.md', Buffer.from('See [the docs](https://example.test/docs).\n'));
    const serialized = JSON.stringify(imported.content);
    assert.match(serialized, /"type":"link"/);
    assert.match(serialized, /"href":"https:\/\/example\.test\/docs"/);
  });
});
