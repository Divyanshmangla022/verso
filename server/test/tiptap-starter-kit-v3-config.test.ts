/**
 * StarterKit v3 replaced the `history` option with `undoRedo` and now bundles
 * Link and Underline. The editor page must configure the v3 option names while
 * keeping the behaviour the toolbar and link handling rely on.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { flattenExtensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

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

const MINIMUM_STARTER_KIT: readonly number[] = [3, 35, 0];

function starterKitRange(workspace: 'server' | 'web'): string {
  const pkg = JSON.parse(
    readFileSync(new URL(`../../${workspace}/package.json`, import.meta.url), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  const range = pkg.dependencies?.['@tiptap/starter-kit'];
  assert.ok(range, `${workspace} should depend on @tiptap/starter-kit`);
  return range;
}

function minimumVersion(range: string): number[] {
  const match = range.match(/\d+\.\d+\.\d+/);
  assert.ok(match, `Could not read a version from "${range}"`);
  return match[0].split('.').map(Number);
}

function atLeast(actual: number[], expected: readonly number[]): boolean {
  for (let i = 0; i < expected.length; i += 1) {
    if ((actual[i] ?? 0) !== expected[i]) return (actual[i] ?? 0) > expected[i];
  }
  return true;
}

describe('StarterKit v3 runtime', () => {
  it('is pinned to a v3 release that bundles Link, Underline and UndoRedo', () => {
    for (const workspace of ['server', 'web'] as const) {
      const range = starterKitRange(workspace);
      assert.ok(
        atLeast(minimumVersion(range), MINIMUM_STARTER_KIT),
        `${workspace} pins @tiptap/starter-kit at ${range}, expected >= ${MINIMUM_STARTER_KIT.join('.')}`,
      );
    }
  });

  it('provides Link, Underline and UndoRedo instead of History', () => {
    const names = new Set(flattenExtensions([StarterKit]).map((extension) => extension.name));
    assert.ok(names.has('link'), 'StarterKit should bundle Link');
    assert.ok(names.has('underline'), 'StarterKit should bundle Underline');
    assert.ok(names.has('undoRedo'), 'StarterKit should use UndoRedo');
    assert.ok(!names.has('history'), 'StarterKit should no longer bundle History');
  });

  it('keeps the editor link configuration on the bundled Link extension', () => {
    const configured = StarterKit.configure({ link: { openOnClick: false } });
    const link = flattenExtensions([configured]).find((extension) => extension.name === 'link');
    assert.ok(link, 'Configured StarterKit should still expose Link');
    assert.equal(link.options.openOnClick, false);
  });
});
