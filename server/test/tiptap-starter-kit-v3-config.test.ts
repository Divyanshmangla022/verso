/**
 * StarterKit v3 replaced the `history` option with `undoRedo` and now bundles
 * Link and Underline. The editor page must configure the v3 option names while
 * keeping the behaviour the toolbar and link handling rely on.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const editorPage = readFileSync(
  new URL('../../web/src/pages/EditorPage.tsx', import.meta.url),
  'utf8',
);

/** The arguments passed to `StarterKit.configure(...)` in the editor page. */
function starterKitConfig(): string {
  const start = editorPage.indexOf('StarterKit.configure(');
  assert.notEqual(start, -1, 'EditorPage should configure StarterKit');
  const open = editorPage.indexOf('(', start);
  let depth = 0;
  for (let i = open; i < editorPage.length; i += 1) {
    if (editorPage[i] === '(') depth += 1;
    else if (editorPage[i] === ')') {
      depth -= 1;
      if (depth === 0) return editorPage.slice(open + 1, i);
    }
  }
  throw new Error('Unbalanced StarterKit.configure(...) call');
}

describe('StarterKit v3 editor configuration', () => {
  it('uses the v3 undoRedo option instead of the removed history option', () => {
    const config = starterKitConfig();
    assert.match(config, /undoRedo\s*:/);
    assert.doesNotMatch(config, /\bhistory\s*:/);
  });

  it('keeps bundled link support and disables click-to-open in the editor', () => {
    const config = starterKitConfig();
    assert.match(config, /link\s*:\s*\{[^}]*openOnClick\s*:\s*false/);
    assert.doesNotMatch(config, /link\s*:\s*false/);
  });

  it('keeps the bundled underline extension for the toolbar', () => {
    assert.doesNotMatch(starterKitConfig(), /underline\s*:\s*false/);
  });
});
