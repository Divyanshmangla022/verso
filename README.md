# Verso - a lightweight collaborative document editor

Verso is a Google-Docs-inspired document editor built for the Ajaia full-stack
assignment: rich-text editing, file import, attachments, sharing with roles,
version history, and an integrated AI writing layer - all persisted in MongoDB.

**Source:** https://github.com/Divyanshmangla022/verso
**Live demo:** https://verso-sqj0.onrender.com (free tier - the instance sleeps when idle, so the first request can take up to a minute to wake it; the app shows a "waking the server" notice while that happens. Demo credentials in `SUBMISSION.md`.)

## Feature summary

| Area | What works |
|---|---|
| Documents | Create, rename (inline + dashboard), edit, autosave, reopen, delete |
| Rich text | Bold, italic, underline, strikethrough, inline code, H1-H3, bulleted & numbered lists, quotes, code blocks, dividers, undo/redo |
| File upload | Import `.txt`, `.md`, `.docx` as a new editable document (10 MB cap, stated in the UI); attach **any** file type to a document (10 MB cap, stored in GridFS) |
| Sharing | Owner grants access by email as **editor** or **viewer**; role changes and revocation; dashboard splits **My documents** / **Shared with me**; all rules enforced server-side |
| Persistence | MongoDB; content stored as ProseMirror JSON so formatting round-trips exactly; optimistic concurrency (409 + reload banner on conflicting saves) |
| Version history | Snapshot on every save (capped at 20), preview metadata, one-click restore |
| Export | Markdown or plain text download, plus PDF through the browser's print pipeline (selectable text, working links, no server-side browser) |
| AI layer | Select text -> **Rewrite / Shorten / Expand / Fix grammar / Change tone**; whole-document **Summarize**, **Ask this document**, and one-click **AI title suggestions** - streamed live (SSE). Uses Google Gemini when `GEMINI_API_KEY` is set; otherwise an honest, clearly-labeled heuristic fallback so every flow still works |

Supported import types: **`.txt`, `.md`, `.docx`** (stated in the upload UI as well).

## Run locally

Prerequisites: **Node.js 24 or newer** (built and deployed on Node 26; the
server runs TypeScript natively, so there is no build step for the API) and
**Docker** (for MongoDB) *or* any MongoDB ≥ 6 on `localhost:27017`.

```bash
npm install          # installs all three workspaces (shared, server, web)
npm run db:up        # starts MongoDB 7 via docker compose
npm run seed         # demo users + sample docs (idempotent)
npm run dev          # API on :4000 and web on :5173, together
```

Open **http://localhost:5173** and sign in with a demo account:

| User | Email | Password |
|---|---|---|
| Ada Lovelace (owns a doc shared with Grace) | `ada@demo.verso.app` | `VersoDemo1!` |
| Grace Hopper (has editor access to Ada's doc) | `grace@demo.verso.app` | `VersoDemo1!` |

To see the full AI quality (instead of heuristic mode), set `GEMINI_API_KEY`
(free key from [Google AI Studio](https://aistudio.google.com/apikey)) in
**`server/.env`** - copy `server/.env.example` to get started. The server loads
its configuration from that file, not from a `.env` at the repository root; a
file placed there is silently ignored.

### Production mode (single process)

```bash
npm run build        # builds the web app into web/dist
NODE_ENV=production JWT_SECRET=<24+ chars> npm start   # API serves web/dist on :4000
```

Or with Docker:

```bash
docker build -t verso .
docker run -p 4000:4000 -e MONGODB_URI=<uri> -e JWT_SECRET=<24+ chars> verso
```

## Tests

```bash
npm test             # 55 end-to-end API tests (node:test)
```

The suite boots the real Express app against a throwaway MongoDB
(`mongodb-memory-server`, downloaded on first run; set `MONGODB_TEST_URI` to
reuse a running instance instead) and covers auth, document CRUD, formatting
round-trips, optimistic-concurrency conflicts, the full sharing/permission
matrix, `.md`/`.txt`/`.docx` import (including a zip bomb that lies about its
size), attachments, version restore, Markdown export fidelity, rate limiting
behind a proxy, HTTP error mapping, and the AI endpoints.

```bash
npm run qa           # 38 checks driving the real UI in Chromium
```

The QA run is self-contained: it starts a throwaway MongoDB, seeds the demo
accounts, boots the production server, then drives the app as two different
users - typing and formatting, watching autosave settle, colliding two editors
to exercise the conflict banner, sharing, restoring a version, importing a
file, attaching a file, and checking read-only mode. Any console error fails
the run. It needs the browser once: `npx playwright install chromium`, and a
built web app (`npm run build`). Pass `--headed` to watch it, or
`--no-screenshots` to leave `docs/screenshots/` alone - every screenshot in
that folder is produced by this script.

```bash
npm run typecheck    # strict TypeScript across all three workspaces
```

Both suites, plus the production build and a dependency audit, run in CI on
every push (`.github/workflows/ci.yml`).

## Repository layout

```
shared/   Types shared by server and web (the API contract)
server/   Express 5 API - auth, docs, sharing, files, AI (native TS, no build)
web/      React 19 + TipTap 3 single-page app (Vite)
scripts/  dev runner, browser QA run, production smoke test
docs/     Architecture note, AI workflow note, deployment guide, screenshots
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) -
[docs/AI_WORKFLOW.md](docs/AI_WORKFLOW.md) -
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

Screenshots of every flow (login, dashboard, editing, the selection AI menu,
the AI panel, version history, sharing, the conflict banner, viewer mode,
import, attachments, mobile) are in
[docs/screenshots/](docs/screenshots/), regenerated by `npm run qa`.
