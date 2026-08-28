/**
 * Regression tests for defects confirmed by the adversarial review pass.
 * Each test locks in a fix; see the commit message for the finding list.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.NODE_ENV = 'test';
process.env.BCRYPT_ROUNDS = '4';
process.env.RATE_LIMIT_AUTH_MAX = '1000'; // keep the suite immune to the auth limiter

const { createApp } = await import('../src/app.ts');
const { closeDb, connectDb } = await import('../src/db.ts');
const { rateLimit } = await import('../src/http/rateLimit.ts');
const { docToMarkdown } = await import('../src/pm/content.ts');

let server: Server;
let baseUrl: string;
let memoryServer: { stop(): Promise<boolean> } | null = null;

async function call<T = unknown>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: RequestInit['body'];
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const raw = await fetch(baseUrl + path, { method, headers, body });
  const isJson = raw.headers.get('content-type')?.includes('application/json');
  return { status: raw.status, body: (isJson ? await raw.json() : await raw.text()) as T };
}

interface Auth {
  token: string;
  user: { id: string; email: string; name: string };
}

async function registerUser(email: string, name: string): Promise<Auth> {
  const res = await call<Auth>('POST', '/api/auth/register', {
    body: { email, name, password: 'Password123!' },
  });
  assert.equal(res.status, 201);
  return res.body;
}

const docWith = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

before(async () => {
  let uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mem = await MongoMemoryServer.create();
    memoryServer = mem;
    uri = mem.getUri('verso_regressions');
  }
  await connectDb(uri);
  const app = createApp();
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await closeDb();
  await memoryServer?.stop();
});

describe('version history integrity', () => {
  it('restore is version-guarded: a concurrent save wins a 409, not silent loss', async () => {
    const owner = await registerUser('vg@test.dev', 'Version Guard');
    const created = await call<{ id: string }>('POST', '/api/docs', { token: owner.token, body: { title: 'Guarded' } });
    const docId = created.body.id;
    await call('PUT', `/api/docs/${docId}/content`, { token: owner.token, body: { content: docWith('v2'), baseVersion: 1 } });
    await call('PUT', `/api/docs/${docId}/content`, { token: owner.token, body: { content: docWith('v3'), baseVersion: 2 } });

    // Restore-then-save with the SAME base simulates the race: whichever runs
    // second must 409 instead of clobbering. Here the restore commits (v4) so
    // a save still based on v3 must conflict.
    const restore = await call<{ version: number }>('POST', `/api/docs/${docId}/versions/2/restore`, { token: owner.token });
    assert.equal(restore.status, 200);
    assert.equal(restore.body.version, 4);
    const staleSave = await call('PUT', `/api/docs/${docId}/content`, {
      token: owner.token,
      body: { content: docWith('lost?'), baseVersion: 3 },
    });
    assert.equal(staleSave.status, 409, 'save based on the pre-restore version must conflict');
  });

  it('attributes each revision to the user who actually saved it', async () => {
    const owner = await registerUser('attr-owner@test.dev', 'Attr Owner');
    const editor = await registerUser('attr-editor@test.dev', 'Attr Editor');
    const created = await call<{ id: string }>('POST', '/api/docs', { token: owner.token, body: { title: 'Attribution' } });
    const docId = created.body.id;
    await call('POST', `/api/docs/${docId}/shares`, { token: owner.token, body: { email: 'attr-editor@test.dev', role: 'editor' } });

    await call('PUT', `/api/docs/${docId}/content`, { token: owner.token, body: { content: docWith('by owner'), baseVersion: 1 } });
    await call('PUT', `/api/docs/${docId}/content`, { token: editor.token, body: { content: docWith('by editor'), baseVersion: 2 } });

    const versions = await call<{ version: number; savedBy: { email: string } | null }[]>(
      'GET',
      `/api/docs/${docId}/versions`,
      { token: owner.token },
    );
    const v2 = versions.body.find((v) => v.version === 2);
    assert.equal(v2?.savedBy?.email, 'attr-owner@test.dev', 'v2 was saved by the owner');
    // current version (3, by editor) is excluded from history; restore it into view
    await call('PUT', `/api/docs/${docId}/content`, { token: owner.token, body: { content: docWith('v4'), baseVersion: 3 } });
    const after = await call<{ version: number; savedBy: { email: string } | null }[]>(
      'GET',
      `/api/docs/${docId}/versions`,
      { token: owner.token },
    );
    const v3 = after.body.find((v) => v.version === 3);
    assert.equal(v3?.savedBy?.email, 'attr-editor@test.dev', 'v3 was saved by the editor');
  });

  it('the original (v1) revision is restorable after edits', async () => {
    const owner = await registerUser('v1@test.dev', 'V One');
    const created = await call<{ id: string }>('POST', '/api/docs', { token: owner.token, body: { title: 'Original' } });
    const docId = created.body.id;
    await call('PUT', `/api/docs/${docId}/content`, { token: owner.token, body: { content: docWith('edited'), baseVersion: 1 } });
    const restore = await call<{ content: { content: { type: string }[] } }>(
      'POST',
      `/api/docs/${docId}/versions/1/restore`,
      { token: owner.token },
    );
    assert.equal(restore.status, 200);
    assert.deepEqual(restore.body.content, { type: 'doc', content: [{ type: 'paragraph' }] }, 'v1 was the empty starting doc');
  });
});

describe('content safety & fidelity', () => {
  it('strips javascript: link marks on save', async () => {
    const owner = await registerUser('link@test.dev', 'Link Check');
    const created = await call<{ id: string }>('POST', '/api/docs', { token: owner.token, body: { title: 'Links' } });
    const docId = created.body.id;
    const save = await call('PUT', `/api/docs/${docId}/content`, {
      token: owner.token,
      body: {
        baseVersion: 1,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'evil', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
                { type: 'text', text: ' safe', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
              ],
            },
          ],
        },
      },
    });
    assert.equal(save.status, 200);
    const doc = await call<{ content: { content: { content: { marks?: { type: string }[] }[] }[] } }>(
      'GET',
      `/api/docs/${docId}`,
      { token: owner.token },
    );
    const [evil, safe] = doc.body.content.content[0].content;
    assert.equal(evil.marks, undefined, 'javascript: link mark was stripped');
    assert.ok(safe.marks?.some((m) => m.type === 'link'), 'https link mark survived');
  });

  it('markdown export preserves blank lines inside code blocks and escapes metacharacters', () => {
    const md = docToMarkdown({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'literal *stars* and _unders_' }] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'const a = 1;\n\n\nconst b = 2;' }] },
      ],
    });
    assert.match(md, /literal \\\*stars\\\* and \\_unders\\_/, 'metacharacters escaped in prose');
    assert.match(md, /const a = 1;\n\n\nconst b = 2;/, 'code block blank lines untouched');
  });

  it('rejects a fake .docx that is not a ZIP archive', async () => {
    const owner = await registerUser('zip@test.dev', 'Zip Check');
    const form = new FormData();
    form.append('file', new Blob(['this is not a zip file at all, just text padding'.repeat(2)]), 'fake.docx');
    const raw = await fetch(`${baseUrl}/api/docs/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
      body: form,
    });
    assert.equal(raw.status, 400);
    const body = (await raw.json()) as { error: string };
    assert.match(body.error, /not a valid \.docx/);
  });
});

describe('rate limiter middleware', () => {
  it('allows up to max requests per window, then returns 429', async () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 3, keyFor: () => 'k', message: 'slow down' });
    const run = () =>
      new Promise<number | null>((resolve) => {
        limiter(
          {} as never,
          {} as never,
          (err?: unknown) => resolve(err ? (err as { status: number }).status : null),
        );
      });
    assert.equal(await run(), null);
    assert.equal(await run(), null);
    assert.equal(await run(), null);
    assert.equal(await run(), 429);
  });
});

describe('AI title suggestions', () => {
  it('returns up to 3 titles and enforces access', async () => {
    const owner = await registerUser('title@test.dev', 'Title Owner');
    const outsider = await registerUser('title-out@test.dev', 'Title Outsider');
    const created = await call<{ id: string }>('POST', '/api/docs', { token: owner.token, body: { title: 'Titles' } });
    const docId = created.body.id;
    await call('PUT', `/api/docs/${docId}/content`, {
      token: owner.token,
      body: { content: docWith('Quarterly revenue review for the leadership sync.'), baseVersion: 1 },
    });
    const res = await call<{ engine: string; titles: string[] }>('POST', '/api/ai/title', {
      token: owner.token,
      body: { docId },
    });
    assert.equal(res.status, 200);
    assert.ok(['gemini', 'heuristic'].includes(res.body.engine));
    assert.ok(res.body.titles.length >= 1 && res.body.titles.length <= 3);
    const denied = await call('POST', '/api/ai/title', { token: outsider.token, body: { docId } });
    assert.equal(denied.status, 403);
  });
});

describe('AI guardrails', () => {
  it('rejects oversize selections and non-allowlisted tones with actionable messages', async () => {
    const owner = await registerUser('guard@test.dev', 'Guard Rail');
    const created = await call<{ id: string }>('POST', '/api/docs', { token: owner.token, body: { title: 'Guarded' } });
    const docId = created.body.id;

    const big = await call<{ error: string }>('POST', '/api/ai/assist', {
      token: owner.token,
      body: { docId, action: 'rewrite', text: 'x'.repeat(50_001) },
    });
    assert.equal(big.status, 400);
    assert.match(big.body.error, /50,000 characters/);

    const badTone = await call('POST', '/api/ai/assist', {
      token: owner.token,
      body: { docId, action: 'tone', tone: 'pirate', text: 'hello there' },
    });
    assert.equal(badTone.status, 400);
  });

  it('answers empty documents without calling any AI engine', async () => {
    const owner = await registerUser('empty@test.dev', 'Empty Doc');
    const created = await call<{ id: string }>('POST', '/api/docs', { token: owner.token, body: { title: 'Empty' } });
    const res = await call<string>('POST', '/api/ai/summarize', { token: owner.token, body: { docId: created.body.id } });
    assert.equal(res.status, 200);
    assert.match(res.body, /empty/i);
  });
});
