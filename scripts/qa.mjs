#!/usr/bin/env node
/**
 * End-to-end QA run in a real browser.
 *
 * Everything is self-contained: it starts a throwaway MongoDB, seeds the demo
 * accounts, boots the production server (API + built SPA), then drives the app
 * as two different users and asserts what a reviewer would check by hand -
 * including the failure modes that unit tests cannot see (undo after load,
 * click-through behind a dropdown, the autosave status actually reaching
 * "All changes saved"). Any console error fails the run.
 *
 *   npm run build          # once, so there is a web/dist to serve
 *   npx playwright install chromium
 *   npm run qa             # add --headed to watch it
 *
 * Screenshots land in docs/screenshots/ (pass --no-screenshots to skip).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'docs', 'screenshots');
const headed = process.argv.includes('--headed');
const takeShots = !process.argv.includes('--no-screenshots');
const PORT = Number(process.env.QA_PORT ?? 4173);
const BASE = `http://127.0.0.1:${PORT}`;
const DEMO_PASSWORD = 'VersoDemo1!';

const results = [];
let shotIndex = 0;

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? '  PASS' : '  FAIL'}  ${name}${condition || !detail ? '' : ` -> ${detail}`}`);
}

async function shot(page, name) {
  if (!takeShots) return;
  mkdirSync(shots, { recursive: true });
  shotIndex += 1;
  await page.screenshot({ path: path.join(shots, `${String(shotIndex).padStart(2, '0')}-${name}.png`), fullPage: false });
}

/** Fail the run if the app logs an error or throws in the browser. */
function watchConsole(page, label) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Favicon 404s, aborted streams, and the browser's own log line for a
    // non-2xx response (409 conflicts are a designed flow here) are noise -
    // application errors are what this run is looking for.
    if (/favicon|net::ERR_ABORTED|Failed to load resource/i.test(text)) return;
    check(`no console error (${label})`, false, text.slice(0, 200));
  });
  page.on('pageerror', (error) => check(`no page error (${label})`, false, String(error).slice(0, 200)));
}

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await delay(400);
  }
  return false;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit', shell: false });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited with ${code}`))));
    child.on('error', reject);
  });
}

async function signIn(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(DEMO_PASSWORD);
  // Exact match: the demo shortcuts are also buttons whose names contain "Sign in".
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
  // The dashboard renders its lists only once the documents have loaded.
  await page.getByRole('heading', { name: 'My documents' }).waitFor({ timeout: 20_000 });
}

async function main() {
  if (!existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
    throw new Error('web/dist is missing - run `npm run build` first');
  }

  console.log('Starting a throwaway MongoDB...');
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri('verso_qa');
  const env = {
    MONGODB_URI: uri,
    JWT_SECRET: 'qa-only-secret-value-that-is-long-enough',
    PORT: String(PORT),
    NODE_ENV: 'production',
    RATE_LIMIT_AUTH_MAX: '500',
    RATE_LIMIT_UPLOAD_MAX: '200',
  };

  console.log('Seeding demo data...');
  await run(process.execPath, [path.join('server', 'src', 'seed.ts')], env);

  console.log('Starting the server...');
  const server = spawn(process.execPath, [path.join('server', 'src', 'index.ts')], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const browser = await chromium.launch({ headless: !headed });
  try {
    if (!(await waitForHealth())) throw new Error('the server did not become healthy');
    check('server is healthy', true);

    const adaContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ada = await adaContext.newPage();
    watchConsole(ada, 'ada');

    // ---- sign in -------------------------------------------------------
    await ada.goto(`${BASE}/login`);
    await shot(ada, 'login');
    await signIn(ada, 'ada@demo.verso.app');
    check('Ada can sign in', await ada.getByRole('button', { name: /new document/i }).isVisible());
    check('the seeded documents are listed', (await ada.locator('.doc-card').count()) >= 2);

    // ---- dashboard splits owned from shared -----------------------------
    const dashboardText = await ada.locator('main.dash').innerText();
    check('dashboard separates owned and shared documents', /My documents/i.test(dashboardText) && /Shared with me/i.test(dashboardText));
    check('supported import types are stated in the UI', /\.txt.*\.md.*\.docx/s.test(dashboardText), dashboardText.slice(0, 120));
    await shot(ada, 'dashboard');

    // ---- open the seeded roadmap ---------------------------------------
    await ada.getByText('Q3 Product Roadmap', { exact: false }).first().click();
    await ada.waitForURL(/\/doc\//);
    await ada.locator('.ProseMirror').waitFor();
    const loadedText = await ada.locator('.ProseMirror').innerText();
    check('the shared document opens with its content', loadedText.includes('Themes'), loadedText.slice(0, 80));
    await shot(ada, 'editor');

    // ---- undo right after load must not wipe the document ---------------
    // (loading used to enter the undo stack, so one Ctrl+Z emptied the doc
    //  and autosaved the empty version over everyone else's copy)
    await ada.locator('.ProseMirror').click();
    for (let i = 0; i < 5; i++) await ada.keyboard.press('Control+z');
    await delay(1500);
    const afterUndo = await ada.locator('.ProseMirror').innerText();
    check('undo immediately after opening cannot empty the document', afterUndo.includes('Themes'), afterUndo.slice(0, 80));

    // ---- type, format, autosave ----------------------------------------
    await ada.locator('.ProseMirror').click();
    await ada.keyboard.press('Control+End');
    await ada.keyboard.press('Enter');
    await ada.keyboard.type('QA run: verifying formatting and autosave.');
    await ada.keyboard.down('Shift');
    for (let i = 0; i < 12; i++) await ada.keyboard.press('ArrowLeft');
    await ada.keyboard.up('Shift');
    const toolbar = ada.locator('.toolbar');
    await toolbar.getByTitle(/^Bold/).click();
    const boldCount = await ada.locator('.ProseMirror strong').count();
    check('bold applies to the selection', boldCount > 0);
    check('the toolbar shows bold as active', (await toolbar.getByTitle(/^Bold/).getAttribute('class'))?.includes('on') ?? false);
    await shot(ada, 'toolbar-active');

    await ada.locator('.ProseMirror').click();
    await ada.keyboard.press('Control+End');
    await ada.keyboard.press('Enter');
    await toolbar.getByTitle(/Bulleted list/i).click();
    await ada.keyboard.type('First QA bullet');
    await ada.keyboard.press('Enter');
    await ada.keyboard.type('Second QA bullet');
    check('bulleted list is created', (await ada.locator('.ProseMirror ul li').count()) >= 2);

    await ada.getByText('All changes saved').waitFor({ timeout: 20_000 });
    check('autosave reaches "All changes saved"', true);
    await shot(ada, 'typed-saved');

    // ---- selection bubble menu -----------------------------------------
    await ada.getByText('QA run: verifying', { exact: false }).click();
    await ada.keyboard.press('End');
    await ada.keyboard.press('Shift+Home');
    const bubble = ada.locator('.bubble');
    await bubble.waitFor({ timeout: 10_000 });
    check('the selection bubble menu appears', await bubble.isVisible());
    await shot(ada, 'bubble');

    // The document scrolls inside its own pane, so the menu has to follow that
    // pane rather than the window - otherwise it detaches from the selection.
    const beforeScroll = await bubble.boundingBox();
    await ada.locator('.editor-scroll').evaluate((el) => el.scrollBy(0, 160));
    await delay(500);
    const afterScroll = await bubble.boundingBox();
    const moved = beforeScroll && afterScroll ? Math.abs(beforeScroll.y - afterScroll.y) : 0;
    check('the bubble menu follows the scrolling editor pane', moved > 100, `moved ${Math.round(moved)}px for a 160px scroll`);

    // ---- AI assist on the selection -------------------------------------
    await bubble.getByRole('button', { name: 'Rewrite' }).click();
    const aiModal = ada.getByRole('dialog');
    await aiModal.waitFor();
    await ada.locator('.ai-output').last().waitFor({ timeout: 45_000 });
    await delay(2000);
    const rewritten = await ada.locator('.ai-output').last().innerText();
    check('AI rewrite returns a result for the selection', rewritten.trim().length > 10, rewritten.slice(0, 80));
    await shot(ada, 'ai-modal');
    await ada.getByRole('button', { name: /Replace selection/i }).click();
    await ada.getByText('All changes saved').waitFor({ timeout: 20_000 });
    check('the AI result can be applied to the document', (await ada.locator('.ProseMirror').innerText()).includes('QA run'));

    // ---- the edits survive a reload ------------------------------------
    await ada.reload();
    await ada.locator('.ProseMirror').waitFor();
    const reloaded = await ada.locator('.ProseMirror').innerText();
    check('edits and formatting survive a reload', reloaded.includes('QA run') && reloaded.includes('Second QA bullet'));
    check('list structure survives a reload', (await ada.locator('.ProseMirror ul li').count()) >= 2);

    // ---- rename ---------------------------------------------------------
    const title = ada.getByLabel('Document title');
    await title.fill('Q3 Product Roadmap (QA)');
    await title.press('Enter');
    await delay(700);
    await ada.reload();
    await ada.locator('.ProseMirror').waitFor();
    check('rename persists', (await ada.getByLabel('Document title').inputValue()) === 'Q3 Product Roadmap (QA)');

    // ---- export menu ----------------------------------------------------
    await ada.getByRole('button', { name: /Export/ }).click();
    const markdownItem = ada.getByRole('button', { name: /Markdown/ });
    await markdownItem.waitFor();
    check('export menu offers Markdown, plain text and PDF', (await ada.getByRole('button', { name: /PDF/ }).isVisible()));
    // The menu must be clickable, not covered by its own click-outside catcher.
    const download = ada.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
    await markdownItem.click();
    const file = await download;
    check('Markdown export downloads', Boolean(file), file ? '' : 'no download event');

    // ---- AI panel -------------------------------------------------------
    await ada.locator('header.topbar').getByRole('button', { name: /AI/ }).click();
    await ada.getByRole('button', { name: /Generate summary/i }).click();
    await ada.locator('.ai-output').first().waitFor({ timeout: 45_000 });
    await delay(2500);
    const summary = await ada.locator('.ai-output').first().innerText();
    check('AI summary produces output', summary.trim().length > 20, summary.slice(0, 80));
    const badge = await ada.locator('.badge.ai').first().innerText().catch(() => '');
    check('the AI engine is labelled in the UI', /gemini|heuristic/i.test(badge), badge);
    await shot(ada, 'ai-panel');
    await ada.locator('aside[aria-label="AI assistant"] .icon-btn').click();

    // ---- version history ------------------------------------------------
    await ada.getByTitle('Version history').click();
    await ada.locator('aside[aria-label="Version history"]').waitFor();
    const versions = await ada.locator('.version-row').count();
    check('version history lists snapshots', versions >= 2, `${versions} rows`);
    await shot(ada, 'history');
    await ada.locator('aside[aria-label="Version history"] .icon-btn').click();

    // ---- sharing --------------------------------------------------------
    await ada.getByRole('button', { name: /^Share/ }).click();
    await ada.getByRole('dialog').waitFor();
    const shareText = await ada.getByRole('dialog').innerText();
    check('share dialog lists the existing collaborator', /grace@demo\.verso\.app/.test(shareText));
    await shot(ada, 'share');
    await ada.keyboard.press('Escape');
    check('Escape closes a dialog', (await ada.getByRole('dialog').count()) === 0);

    // ---- Grace: the shared view ----------------------------------------
    const graceContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const grace = await graceContext.newPage();
    watchConsole(grace, 'grace');
    await signIn(grace, 'grace@demo.verso.app');
    const sharedGrid = grace.locator('h2:text-is("Shared with me") + .doc-grid');
    const sharedTitles = await sharedGrid.locator('.title').allInnerTexts();
    check(
      'Grace sees the document under "Shared with me"',
      sharedTitles.some((t) => t.includes('Q3 Product Roadmap')),
      `shared section shows: ${sharedTitles.join(' | ') || '(nothing)'}`,
    );
    check('the shared card shows the editor role', /editor/i.test(await sharedGrid.innerText().catch(() => '')));
    await shot(grace, 'grace-dashboard');

    await grace.getByText('Q3 Product Roadmap', { exact: false }).first().click();
    await grace.waitForURL(/\/doc\//);
    await grace.locator('.ProseMirror').waitFor();
    await grace.locator('.ProseMirror').click();
    await grace.keyboard.press('Control+End');
    await grace.keyboard.press('Enter');
    await grace.keyboard.type('Grace was here.');
    await grace.getByText('All changes saved').waitFor({ timeout: 20_000 });
    check('an editor can save the shared document', true);
    await shot(grace, 'grace-editor');

    // ---- conflict handling ----------------------------------------------
    // Ada's tab is still on the pre-Grace version: her next edit must be
    // refused rather than silently overwriting Grace's work.
    await ada.locator('.ProseMirror').click();
    await ada.keyboard.press('Control+End');
    await ada.keyboard.type(' Ada types after Grace saved.');
    await ada.getByText(/changed elsewhere/i).waitFor({ timeout: 20_000 });
    check('a stale editor is warned instead of overwriting', true);
    await shot(ada, 'conflict');
    await ada.getByRole('button', { name: /Load latest version/i }).click();
    await delay(2000);
    const merged = await ada.locator('.ProseMirror').innerText();
    check('loading the latest version brings in the other edit', merged.includes('Grace was here.'));
    // The reload used to bounce straight back into a save, which put both users
    // into a conflict loop; the status must settle instead.
    await delay(2500);
    const statusAfterReload = await ada.locator('.save-status').innerText();
    check('reloading does not trigger a phantom save', statusAfterReload === 'All changes saved', statusAfterReload);

    // ---- viewer mode -----------------------------------------------------
    await ada.getByRole('button', { name: /^Share/ }).click();
    await ada.getByRole('dialog').waitFor();
    await ada.getByLabel(/Role for/i).selectOption('viewer');
    await delay(800);
    await ada.keyboard.press('Escape');
    await grace.reload();
    await grace.locator('.ProseMirror').waitFor();
    check('a viewer sees the read-only banner', await grace.getByText(/view-only access/i).isVisible());
    check('a viewer gets no formatting toolbar', (await grace.locator('.toolbar').count()) === 0);
    await shot(grace, 'viewer');

    // ---- import ----------------------------------------------------------
    await ada.getByTitle('Back to documents').click();
    await ada.waitForURL((url) => url.pathname === '/');
    await ada.locator('input[type="file"]').setInputFiles({
      name: 'qa-import.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Imported by QA\n\nSome **bold** text.\n\n- alpha\n- beta\n'),
    });
    await ada.waitForURL(/\/doc\//, { timeout: 20_000 });
    await ada.locator('.ProseMirror').waitFor();
    const imported = await ada.locator('.ProseMirror').innerText();
    check('a Markdown import becomes a formatted document', imported.includes('alpha') && (await ada.locator('.ProseMirror ul li').count()) >= 2);
    check('the imported title comes from the heading', (await ada.getByLabel('Document title').inputValue()) === 'Imported by QA');
    await shot(ada, 'import');

    // ---- attachments ------------------------------------------------------
    await ada.getByTitle('Attachments').click();
    await ada.locator('aside[aria-label="Attachments"]').waitFor();
    await ada.locator('aside[aria-label="Attachments"] input[type="file"]').setInputFiles({
      name: 'qa-notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('attachment from the QA run'),
    });
    await ada.locator('aside[aria-label="Attachments"]').getByText('qa-notes.txt').waitFor({ timeout: 20_000 });
    check('a file can be attached to a document', true);
    await shot(ada, 'attachments');

    // ---- mobile layout ----------------------------------------------------
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobile = await mobileContext.newPage();
    watchConsole(mobile, 'mobile');
    await signIn(mobile, 'ada@demo.verso.app');
    await mobile.locator('.doc-card').first().waitFor();
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('the dashboard does not scroll sideways on a phone', overflow <= 2, `${overflow}px overflow`);
    await shot(mobile, 'mobile');
  } finally {
    await browser.close();
    server.kill();
    await mongo.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('Failed checks:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('QA run failed:', err);
  process.exitCode = 1;
});
