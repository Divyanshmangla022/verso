/**
 * `@tiptap/html` is deprecated in Tiptap v3. Imports must keep working through
 * the supported `generateJSON` helper from `@tiptap/core`, not the legacy
 * package, or a future Tiptap release will drop them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { importFile } from '../src/files/importers.ts';

const serverPackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { dependencies: Record<string, string> };
const importersSource = readFileSync(new URL('../src/files/importers.ts', import.meta.url), 'utf8');

describe('Tiptap HTML import path', () => {
  it('does not depend on the deprecated @tiptap/html package', () => {
    assert.equal(serverPackage.dependencies['@tiptap/html'], undefined);
  });

  it('uses the supported HTML parser from @tiptap/core', () => {
    assert.doesNotMatch(importersSource, /from\s+['"]@tiptap\/html['"]/);
    assert.match(importersSource, /from\s+['"]@tiptap\/core['"]/);
  });

  it('still turns imported markdown into editor JSON without losing formatting', async () => {
    const imported = await importFile(
      'notes.md',
      Buffer.from('See [the docs](https://example.test/docs).\n'),
    );
    const serialized = JSON.stringify(imported.content);
    assert.match(serialized, /"type":"link"/);
    assert.match(serialized, /"href":"https:\/\/example\.test\/docs"/);
  });
});
