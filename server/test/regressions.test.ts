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
process.env.RATE_LIMIT_UPLOAD_MAX = '6'; // small enough to exercise the upload limiter
process.env.TRUST_PROXY_HOPS = '1'; // as deployed behind a single reverse proxy

const { createApp } = await import('../src/app.ts');
const { closeDb, connectDb } = await import('../src/db.ts');
const { rateLimit } = await import('../src/http/rateLimit.ts');
const { docToMarkdown, textToDoc, validateContent } = await import('../src/pm/content.ts');
const { sampleDocx, zipBombDocx } = await import('./fixtures.ts');

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

async function callForm<T = unknown>(
  path: string,
  token: string,
  file: { name: string; body: Buffer | string; type?: string },
): Promise<{ status: number; body: T }> {
  const form = new FormData();
  form.append('file', new Blob([file.body], { type: file.type ?? 'application/octet-stream' }), file.name);
  const raw = await fetch(baseUrl + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const isJson = raw.headers.get('content-type')?.includes('application/json');
  return { status: raw.status, body: (isJson ? await raw.json() : await raw.text()) as T };
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

describe('import hardening', () => {
  it('rejects a .docx whose central directory understates the payload (zip bomb)', async () => {
    const owner = await registerUser('bomb@test.dev', 'Bomb Check');
    // Declares 1 KB, really inflates to 200 MB. Building it never holds the
    // payload, so any memory growth here belongs to the code under test.
    const bomb = await zipBombDocx(200);
    assert.ok(bomb.length < 1024 * 1024, `the archive itself stays small (${bomb.length} bytes)`);

    const before = process.memoryUsage().rss;
    const res = await callForm<{ error: string }>('/api/docs/import', owner.token, {
      name: 'bomb.docx',
      body: bomb,
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /expand beyond the import size limit|inconsistent entry size/);
    // The whole point of the guard: the payload must never be materialised.
    const growth = process.memoryUsage().rss - before;
    assert.ok(growth < 50 * 1024 * 1024, `resident memory grew by ${Math.round(growth / 1024 / 1024)} MB`);
  });

  it('converts a real .docx into headings, underline and a bullet list', async () => {
    const owner = await registerUser('docx@test.dev', 'Docx Import');
    const res = await callForm<{ id: string; title: string }>('/api/docs/import', owner.token, {
      name: 'report.docx',
      body: sampleDocx(),
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.title, 'Quarterly report');

    const doc = await call<{ content: { content: { type: string; content?: unknown[] }[] } }>(
      'GET',
      `/api/docs/${res.body.id}`,
      { token: owner.token },
    );
    const types = doc.body.content.content.map((n) => n.type);
    assert.ok(types.includes('heading'), `expected a heading, got ${types.join(', ')}`);
    assert.ok(types.includes('bulletList'), `expected a bullet list, got ${types.join(', ')}`);
    assert.match(JSON.stringify(doc.body.content), /"underline"/, 'underlined runs keep their formatting');
  });

  it('splits CR-only text into paragraphs instead of one line of control characters', () => {
    const doc = textToDoc('First para.\r\r\rSecond para.');
    assert.equal(doc.content?.length, 2);
    assert.equal(JSON.stringify(doc).includes('\\r'), false, 'no carriage returns survive into the document');
  });
});

describe('content validation', () => {
  it('rejects documents the editor cannot load', () => {
    const cases: [string, unknown][] = [
      ['empty text node', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] }],
      ['text node without text', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text' }] }] }],
      ['heading level 9', { type: 'doc', content: [{ type: 'heading', attrs: { level: 9 }, content: [{ type: 'text', text: 'x' }] }] }],
      ['text directly inside a list', { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'text', text: 'x' }] }] }],
      ['paragraph inside a paragraph', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'paragraph' }] }] }],
    ];
    for (const [label, content] of cases) {
      assert.throws(() => validateContent(content), /not valid editor JSON|Unsupported|Heading level/, label);
    }
  });

  it('still accepts ordinary formatted content', () => {
    const ok = validateContent({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] },
      ],
    });
    assert.equal(ok.type, 'doc');
  });

  it('rejects an empty text node through the save endpoint too', async () => {
    const owner = await registerUser('validate@test.dev', 'Validate');
    const created = await call<{ id: string }>('POST', '/api/docs', { token: owner.token, body: { title: 'V' } });
    const res = await call('PUT', `/api/docs/${created.body.id}/content`, {
      token: owner.token,
      body: { baseVersion: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] } },
    });
    assert.equal(res.status, 400);
  });
});

describe('markdown export fidelity', () => {
  it('escapes text that would otherwise become a list, heading or rule', () => {
    const md = docToMarkdown({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '1. Install the CLI' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '- not a bullet' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '# not a heading' }] },
      ],
    });
    assert.match(md, /\\1\. Install the CLI/);
    assert.match(md, /\\- not a bullet/);
    assert.match(md, /\\# not a heading/);
  });

  it('keeps a heading on one line and fences code spans that contain backticks', () => {
    const md = docToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'First' }, { type: 'hardBreak' }, { type: 'text', text: 'second' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'a ` b', marks: [{ type: 'code' }] }] },
      ],
    });
    assert.match(md, /^## First second$/m, 'a hard break inside a heading must not end the heading');
    assert.match(md, /``a ` b``/, 'the fence has to outlast the backticks inside');
  });

  it('encodes link targets that would break the link syntax', () => {
    const md = docToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'spec', marks: [{ type: 'link', attrs: { href: 'https://example.com/a b(c)' } }] }],
        },
      ],
    });
    assert.match(md, /\[spec\]\(https:\/\/example\.com\/a%20b%28c%29\)/);
  });
});

describe('HTTP error mapping', () => {
  it('answers a malformed JSON body with 400, not 500', async () => {
    const raw = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email": ',
    });
    assert.equal(raw.status, 400);
  });

  it('answers an oversized body with 413 and an actionable message', async () => {
    const raw = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.dev', password: 'x'.repeat(4 * 1024 * 1024) }),
    });
    assert.equal(raw.status, 413);
    const body = (await raw.json()) as { error: string };
    assert.match(body.error, /too large/i);
  });
});

describe('rate limiting behind a proxy', () => {
  it('trusts exactly one proxy hop, so req.ip is the real client', async () => {
    const app = createApp();
    assert.equal(app.get('trust proxy'), 1);
  });

  it('keeps separate buckets per forwarded client address', async () => {
    const express = (await import('express')).default;
    const { ipKey } = await import('../src/http/rateLimit.ts');
    const { errorMiddleware } = await import('../src/http/errors.ts');

    const probe = express();
    probe.set('trust proxy', 1);
    probe.use(rateLimit({ windowMs: 60_000, max: 2, keyFor: ipKey, message: 'slow down' }));
    probe.get('/', (_req, res) => {
      res.json({ ok: true });
    });
    probe.use(errorMiddleware);
    const probeServer = probe.listen(0);
    const url = `http://127.0.0.1:${(probeServer.address() as AddressInfo).port}/`;
    const hit = (client: string) => fetch(url, { headers: { 'X-Forwarded-For': client } }).then((r) => r.status);
    try {
      assert.equal(await hit('203.0.113.1'), 200);
      assert.equal(await hit('203.0.113.1'), 200);
      assert.equal(await hit('203.0.113.1'), 429, 'the noisy client is throttled');
      assert.equal(await hit('203.0.113.9'), 200, 'a different client keeps its own allowance');
    } finally {
      probeServer.close();
    }
  });

  it('throttles uploads per user and says when to retry', async () => {
    const owner = await registerUser('uploads@test.dev', 'Upload Limit');
    const created = await call<{ id: string }>('POST', '/api/docs', { token: owner.token, body: { title: 'Files' } });
    const docId = created.body.id;
    const upload = () =>
      fetch(`${baseUrl}/api/docs/${docId}/attachments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.token}` },
        body: (() => {
          const form = new FormData();
          form.append('file', new Blob(['x']), 'x.txt');
          return form;
        })(),
      });

    let last: Response | null = null;
    for (let i = 0; i < 7; i++) last = await upload(); // limit is 6 in this suite
    assert.equal(last?.status, 429);
    assert.ok(Number(last?.headers.get('Retry-After')) > 0, 'a Retry-After header tells the client when to come back');
  });
});

describe('attachment naming', () => {
  it('stores and returns a non-ASCII filename unchanged', async () => {
    const owner = await registerUser('names@test.dev', 'Name Check');
    const created = await call<{ id: string }>('POST', '/api/docs', { token: owner.token, body: { title: 'Names' } });
    const up = await callForm<{ name: string }>(`/api/docs/${created.body.id}/attachments`, owner.token, {
      name: 'résumé-履歴書.txt',
      body: 'hello',
      type: 'text/plain',
    });
    assert.equal(up.status, 201);
    assert.equal(up.body.name, 'résumé-履歴書.txt');
  });
});

describe('AI upstream resilience', () => {
  it('retries a 503/429 from the model a couple of times, then gives up', async () => {
    const { withTransientRetry } = await import('../src/ai/engine.ts');
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw new Error('{"error":{"code":503,"status":"UNAVAILABLE","message":"The model is overloaded. Please try again later."}}');
      return 'ok';
    };
    assert.equal(await withTransientRetry(flaky), 'ok');
    assert.equal(calls, 3, 'two retries, then success');

    calls = 0;
    const alwaysBusy = async () => {
      calls += 1;
      throw new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}');
    };
    await assert.rejects(() => withTransientRetry(alwaysBusy), /429|RESOURCE_EXHAUSTED/);
    assert.equal(calls, 3, 'gives up after the retry budget');
  });

  it('does not retry errors that will not change (bad request, unknown model)', async () => {
    const { withTransientRetry } = await import('../src/ai/engine.ts');
    let calls = 0;
    const broken = async () => {
      calls += 1;
      throw new Error('{"error":{"code":404,"status":"NOT_FOUND","message":"models/nope is not found"}}');
    };
    await assert.rejects(() => withTransientRetry(broken), /NOT_FOUND/);
    assert.equal(calls, 1);
  });

  it('stops retrying as soon as the request is aborted', async () => {
    const { withTransientRetry } = await import('../src/ai/engine.ts');
    const controller = new AbortController();
    let calls = 0;
    const busy = async () => {
      calls += 1;
      controller.abort();
      throw new Error('{"error":{"code":503,"status":"UNAVAILABLE","message":"overloaded"}}');
    };
    await assert.rejects(() => withTransientRetry(busy, controller.signal));
    assert.equal(calls, 1, 'no retry after the client went away');
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
