/**
 * End-to-end API tests. Runs the real Express app against a throwaway MongoDB:
 *   - MONGODB_TEST_URI if set (e.g. the docker-compose mongo), else
 *   - an in-memory mongod from mongodb-memory-server (downloaded on first run).
 *
 * Run: npm test -w server
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.NODE_ENV = 'test';
process.env.BCRYPT_ROUNDS = '4'; // keep hashing fast in tests
process.env.RATE_LIMIT_AUTH_MAX = '1000'; // the suite registers many users from one IP

const { createApp } = await import('../src/app.ts');
const { closeDb, connectDb } = await import('../src/db.ts');

let server: Server;
let baseUrl: string;
let memoryServer: { stop(): Promise<boolean> } | null = null;

interface Res<T = unknown> {
  status: number;
  body: T;
  raw: Response;
}

async function call<T = unknown>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; form?: FormData } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: RequestInit['body'];
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const raw = await fetch(baseUrl + path, { method, headers, body });
  const isJson = raw.headers.get('content-type')?.includes('application/json');
  const parsed = isJson ? await raw.json() : await raw.text();
  return { status: raw.status, body: parsed as T, raw };
}

interface Auth {
  token: string;
  user: { id: string; email: string; name: string };
}

async function registerUser(email: string, name: string): Promise<Auth> {
  const res = await call<Auth>('POST', '/api/auth/register', {
    body: { email, name, password: 'Password123!' },
  });
  assert.equal(res.status, 201, `register ${email}: ${JSON.stringify(res.body)}`);
  return res.body;
}

const SAMPLE_DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Launch plan' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Ship ' },
        { type: 'text', text: 'now', marks: [{ type: 'bold' }, { type: 'underline' }] },
      ],
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
      ],
    },
  ],
};

before(async () => {
  let uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mem = await MongoMemoryServer.create();
    memoryServer = mem;
    uri = mem.getUri('verso_test');
  }
  await connectDb(uri);
  const app = createApp();
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server?.close();
  await closeDb();
  await memoryServer?.stop();
});

describe('health & meta', () => {
  it('reports healthy and advertises supported import types', async () => {
    const health = await call<{ ok: boolean }>('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    const meta = await call<{ supportedImports: string[]; ai: { engine: string } }>('GET', '/api/meta');
    assert.deepEqual(meta.body.supportedImports, ['.txt', '.md', '.docx']);
    assert.ok(['gemini', 'heuristic'].includes(meta.body.ai.engine));
  });
});

describe('auth', () => {
  it('registers, logs in, and returns the profile', async () => {
    const reg = await registerUser('owner@test.dev', 'Owner One');
    assert.equal(reg.user.email, 'owner@test.dev');
    const login = await call<Auth>('POST', '/api/auth/login', {
      body: { email: 'OWNER@test.dev', password: 'Password123!' },
    });
    assert.equal(login.status, 200, 'login should normalize email case');
    const me = await call<{ user: { email: string } }>('GET', '/api/auth/me', { token: login.body.token });
    assert.equal(me.body.user.email, 'owner@test.dev');
  });

  it('rejects duplicate registration with 409', async () => {
    const res = await call('POST', '/api/auth/register', {
      body: { email: 'owner@test.dev', name: 'Dup', password: 'Password123!' },
    });
    assert.equal(res.status, 409);
  });

  it('validates registration input', async () => {
    const badEmail = await call('POST', '/api/auth/register', {
      body: { email: 'not-an-email', name: 'X', password: 'Password123!' },
    });
    assert.equal(badEmail.status, 400);
    const shortPw = await call('POST', '/api/auth/register', {
      body: { email: 'x@test.dev', name: 'X', password: 'short' },
    });
    assert.equal(shortPw.status, 400);
  });

  it('rejects wrong password and missing token', async () => {
    const wrong = await call('POST', '/api/auth/login', {
      body: { email: 'owner@test.dev', password: 'WrongPassword1!' },
    });
    assert.equal(wrong.status, 401);
    const noToken = await call('GET', '/api/docs');
    assert.equal(noToken.status, 401);
  });
});

describe('documents', () => {
  let owner: Auth;
  let docId: string;

  before(async () => {
    owner = await registerUser('docs@test.dev', 'Docs Owner');
  });

  it('creates, renames, and lists a document', async () => {
    const created = await call<{ id: string; title: string; version: number }>('POST', '/api/docs', {
      token: owner.token,
      body: {},
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.title, 'Untitled document');
    docId = created.body.id;

    const renamed = await call('PATCH', `/api/docs/${docId}`, {
      token: owner.token,
      body: { title: 'Launch plan' },
    });
    assert.equal(renamed.status, 200);

    const list = await call<{ owned: { id: string; title: string }[] }>('GET', '/api/docs', { token: owner.token });
    const found = list.body.owned.find((d) => d.id === docId);
    assert.ok(found, 'created doc appears in owned list');
    assert.equal(found.title, 'Launch plan');
  });

  it('rejects an empty title', async () => {
    const res = await call('PATCH', `/api/docs/${docId}`, { token: owner.token, body: { title: '   ' } });
    assert.equal(res.status, 400);
  });

  it('saves rich content and preserves structure on reopen', async () => {
    const save = await call<{ version: number }>('PUT', `/api/docs/${docId}/content`, {
      token: owner.token,
      body: { content: SAMPLE_DOC, baseVersion: 1 },
    });
    assert.equal(save.status, 200);
    assert.equal(save.body.version, 2);

    const reopened = await call<{ content: unknown; version: number }>('GET', `/api/docs/${docId}`, { token: owner.token });
    assert.deepEqual(reopened.body.content, SAMPLE_DOC, 'formatting survives a save/reopen round trip');
  });

  it('detects concurrent edits with 409 on a stale baseVersion', async () => {
    const stale = await call<{ details: { currentVersion: number } }>('PUT', `/api/docs/${docId}/content`, {
      token: owner.token,
      body: { content: SAMPLE_DOC, baseVersion: 1 },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.details.currentVersion, 2);
  });

  it('rejects content the editor cannot render', async () => {
    const res = await call('PUT', `/api/docs/${docId}/content`, {
      token: owner.token,
      body: { content: { type: 'doc', content: [{ type: 'iframe' }] }, baseVersion: 2 },
    });
    assert.equal(res.status, 400);
  });

  it('keeps version history and restores an old revision', async () => {
    const versions = await call<{ version: number; wordCount: number }[]>('GET', `/api/docs/${docId}/versions`, {
      token: owner.token,
    });
    assert.equal(versions.status, 200);
    assert.ok(versions.body.length >= 1, 'a snapshot exists after saving');
    assert.equal(versions.body[0].version, 1);

    const restore = await call<{ version: number; content: { content: unknown[] } }>(
      'POST',
      `/api/docs/${docId}/versions/1/restore`,
      { token: owner.token },
    );
    assert.equal(restore.status, 200);
    assert.equal(restore.body.version, 3, 'restore bumps the version');
  });

  it('exports markdown that reflects the formatting', async () => {
    await call('PUT', `/api/docs/${docId}/content`, {
      token: owner.token,
      body: { content: SAMPLE_DOC, baseVersion: 3 },
    });
    const res = await call<string>('GET', `/api/docs/${docId}/export?format=md`, { token: owner.token });
    assert.equal(res.status, 200);
    assert.match(res.body, /# Launch plan/);
    assert.match(res.body, /\*\*now\*\*|<u>\*\*now\*\*<\/u>|\*\*<u>now<\/u>\*\*/);
    assert.match(res.body, /- first/);
  });
});

describe('sharing & access control', () => {
  let owner: Auth;
  let collaborator: Auth;
  let stranger: Auth;
  let docId: string;

  before(async () => {
    owner = await registerUser('share-owner@test.dev', 'Share Owner');
    collaborator = await registerUser('collab@test.dev', 'Colla Borator');
    stranger = await registerUser('stranger@test.dev', 'Total Stranger');
    const created = await call<{ id: string }>('POST', '/api/docs', {
      token: owner.token,
      body: { title: 'Shared spec' },
    });
    docId = created.body.id;
  });

  it('blocks non-collaborators from reading', async () => {
    const res = await call('GET', `/api/docs/${docId}`, { token: stranger.token });
    assert.equal(res.status, 403);
  });

  it('owner grants editor access by email; collaborator sees it under "shared"', async () => {
    const grant = await call<{ role: string }>('POST', `/api/docs/${docId}/shares`, {
      token: owner.token,
      body: { email: 'collab@test.dev', role: 'editor' },
    });
    assert.equal(grant.status, 201);
    assert.equal(grant.body.role, 'editor');

    const list = await call<{ owned: unknown[]; shared: { id: string; myRole: string }[] }>('GET', '/api/docs', {
      token: collaborator.token,
    });
    const entry = list.body.shared.find((d) => d.id === docId);
    assert.ok(entry, 'shared doc appears in the collaborator list');
    assert.equal(entry.myRole, 'editor');
  });

  it('sharing with an unknown email returns a clear 404', async () => {
    const res = await call<{ error: string }>('POST', `/api/docs/${docId}/shares`, {
      token: owner.token,
      body: { email: 'ghost@test.dev', role: 'viewer' },
    });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /ghost@test\.dev/);
  });

  it('an editor can save but cannot share or delete', async () => {
    const save = await call('PUT', `/api/docs/${docId}/content`, {
      token: collaborator.token,
      body: { content: SAMPLE_DOC, baseVersion: 1 },
    });
    assert.equal(save.status, 200);

    const share = await call('POST', `/api/docs/${docId}/shares`, {
      token: collaborator.token,
      body: { email: 'stranger@test.dev', role: 'viewer' },
    });
    assert.equal(share.status, 403);

    const del = await call('DELETE', `/api/docs/${docId}`, { token: collaborator.token });
    assert.equal(del.status, 403);
  });

  it('downgrading to viewer blocks writes but keeps reads', async () => {
    const downgrade = await call('POST', `/api/docs/${docId}/shares`, {
      token: owner.token,
      body: { email: 'collab@test.dev', role: 'viewer' },
    });
    assert.equal(downgrade.status, 201);

    const save = await call('PUT', `/api/docs/${docId}/content`, {
      token: collaborator.token,
      body: { content: SAMPLE_DOC, baseVersion: 2 },
    });
    assert.equal(save.status, 403);

    const read = await call('GET', `/api/docs/${docId}`, { token: collaborator.token });
    assert.equal(read.status, 200);
  });

  it('revoking removes access entirely', async () => {
    const revoke = await call('DELETE', `/api/docs/${docId}/shares/${collaborator.user.id}`, { token: owner.token });
    assert.equal(revoke.status, 204);
    const read = await call('GET', `/api/docs/${docId}`, { token: collaborator.token });
    assert.equal(read.status, 403);
  });
});

describe('file import & attachments', () => {
  let owner: Auth;
  let viewer: Auth;
  let docId: string;

  before(async () => {
    owner = await registerUser('files@test.dev', 'File Owner');
    viewer = await registerUser('files-viewer@test.dev', 'File Viewer');
    const created = await call<{ id: string }>('POST', '/api/docs', { token: owner.token, body: { title: 'Files doc' } });
    docId = created.body.id;
    await call('POST', `/api/docs/${docId}/shares`, {
      token: owner.token,
      body: { email: 'files-viewer@test.dev', role: 'viewer' },
    });
  });

  it('imports a markdown file into a structured document', async () => {
    const form = new FormData();
    const md = '# Import title\n\nSome **bold** text.\n\n- alpha\n- beta\n';
    form.append('file', new Blob([md], { type: 'text/markdown' }), 'notes.md');
    const res = await call<{ id: string; title: string }>('POST', '/api/docs/import', { token: owner.token, form });
    assert.equal(res.status, 201);
    assert.equal(res.body.title, 'Import title');

    const doc = await call<{ content: { content: { type: string }[] } }>('GET', `/api/docs/${res.body.id}`, {
      token: owner.token,
    });
    const types = doc.body.content.content.map((n) => n.type);
    assert.ok(types.includes('heading'), 'import produced a heading');
    assert.ok(types.includes('bulletList'), 'import produced a list');
  });

  it('imports plain text as paragraphs', async () => {
    const form = new FormData();
    form.append('file', new Blob(['First para.\n\nSecond para.'], { type: 'text/plain' }), 'plain.txt');
    const res = await call<{ id: string }>('POST', '/api/docs/import', { token: owner.token, form });
    assert.equal(res.status, 201);
    const doc = await call<{ content: { content: unknown[] } }>('GET', `/api/docs/${res.body.id}`, { token: owner.token });
    assert.equal(doc.body.content.content.length, 2);
  });

  it('rejects unsupported file types with a helpful message', async () => {
    const form = new FormData();
    form.append('file', new Blob(['MZ']), 'virus.exe');
    const res = await call<{ error: string }>('POST', '/api/docs/import', { token: owner.token, form });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /\.txt, \.md, \.docx/);
  });

  it('uploads, lists, downloads, and deletes an attachment; viewers cannot upload', async () => {
    const payload = 'attachment-bytes-12345';
    const form = new FormData();
    form.append('file', new Blob([payload], { type: 'text/plain' }), 'brief.txt');
    const up = await call<{ id: string; name: string; size: number }>('POST', `/api/docs/${docId}/attachments`, {
      token: owner.token,
      form,
    });
    assert.equal(up.status, 201);
    assert.equal(up.body.name, 'brief.txt');
    assert.equal(up.body.size, payload.length);

    const list = await call<{ id: string }[]>('GET', `/api/docs/${docId}/attachments`, { token: viewer.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);

    const download = await call<string>('GET', `/api/docs/${docId}/attachments/${up.body.id}`, { token: viewer.token });
    assert.equal(download.status, 200);
    assert.equal(download.body, payload, 'downloaded bytes match the upload');

    const viewerForm = new FormData();
    viewerForm.append('file', new Blob(['nope']), 'nope.txt');
    const denied = await call('POST', `/api/docs/${docId}/attachments`, { token: viewer.token, form: viewerForm });
    assert.equal(denied.status, 403);

    const del = await call('DELETE', `/api/docs/${docId}/attachments/${up.body.id}`, { token: owner.token });
    assert.equal(del.status, 204);
    const after = await call<unknown[]>('GET', `/api/docs/${docId}/attachments`, { token: owner.token });
    assert.equal(after.body.length, 0);
  });
});

describe('AI endpoints (heuristic engine, no API key)', () => {
  let owner: Auth;
  let stranger: Auth;
  let docId: string;

  before(async () => {
    owner = await registerUser('ai@test.dev', 'AI Owner');
    stranger = await registerUser('ai-stranger@test.dev', 'AI Stranger');
    const created = await call<{ id: string }>('POST', '/api/docs', { token: owner.token, body: { title: 'AI doc' } });
    docId = created.body.id;
    await call('PUT', `/api/docs/${docId}/content`, {
      token: owner.token,
      body: { content: SAMPLE_DOC, baseVersion: 1 },
    });
  });

  function parseSse(raw: string): { type: string; [k: string]: unknown }[] {
    return raw
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice(6)) as { type: string });
  }

  it('streams a summary as SSE with engine metadata', async () => {
    const res = await call<string>('POST', '/api/ai/summarize', { token: owner.token, body: { docId } });
    assert.equal(res.status, 200);
    const events = parseSse(res.body);
    assert.equal(events[0].type, 'meta');
    assert.equal(events.at(-1)?.type, 'done');
    const chunks = events.filter((e) => e.type === 'chunk');
    assert.ok(chunks.length > 0, 'summary produced content');
  });

  it('grammar assist cleans up text', async () => {
    const res = await call<string>('POST', '/api/ai/assist', {
      token: owner.token,
      body: { docId, action: 'grammar', text: 'this  is  rough. i agree' },
    });
    assert.equal(res.status, 200);
    const text = parseSse(res.body)
      .filter((e) => e.type === 'chunk')
      .map((e) => (e as unknown as { text: string }).text)
      .join('');
    assert.equal(text, 'This is rough. I agree');
  });

  it('enforces document access on AI routes', async () => {
    const res = await call('POST', '/api/ai/summarize', { token: stranger.token, body: { docId } });
    assert.equal(res.status, 403);
  });

  it('validates AI input', async () => {
    const res = await call('POST', '/api/ai/assist', {
      token: owner.token,
      body: { docId, action: 'levitate', text: 'hi' },
    });
    assert.equal(res.status, 400);
  });
});

describe('deletion', () => {
  it('deleting a document removes shares and attachments with it', async () => {
    const owner = await registerUser('del@test.dev', 'Del Owner');
    const other = await registerUser('del-other@test.dev', 'Del Other');
    const created = await call<{ id: string }>('POST', '/api/docs', { token: owner.token, body: { title: 'Doomed' } });
    const docId = created.body.id;
    await call('POST', `/api/docs/${docId}/shares`, {
      token: owner.token,
      body: { email: 'del-other@test.dev', role: 'viewer' },
    });
    const form = new FormData();
    form.append('file', new Blob(['bye']), 'bye.txt');
    await call('POST', `/api/docs/${docId}/attachments`, { token: owner.token, form });

    const del = await call('DELETE', `/api/docs/${docId}`, { token: owner.token });
    assert.equal(del.status, 204);

    const gone = await call('GET', `/api/docs/${docId}`, { token: owner.token });
    assert.equal(gone.status, 404);
    const otherList = await call<{ shared: unknown[] }>('GET', '/api/docs', { token: other.token });
    assert.equal(otherList.body.shared.length, 0, 'share disappears with the document');
  });
});
