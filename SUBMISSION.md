# SUBMISSION - Verso

Collaborative document editor with an AI writing layer, built for the Ajaia
AI-Native Full Stack Product Engineer assignment.

## What is in this folder

| Item | Where |
|---|---|
| Source code | this repository (`shared/`, `server/`, `web/`) |
| Local setup & run instructions | `README.md` |
| Architecture note (priorities + tradeoffs) | `docs/ARCHITECTURE.md` |
| AI workflow note | `docs/AI_WORKFLOW.md` |
| Deployment guide | `docs/DEPLOYMENT.md` |
| Walkthrough video URL | `VIDEO_URL.txt` |
| Screenshots of every major flow | `docs/screenshots/` |
| This manifest | `SUBMISSION.md` |

## Source

https://github.com/Divyanshmangla022/verso (public)

## Live deployment

- **URL:** https://verso-sqj0.onrender.com
- Free-tier note: the instance sleeps when idle, so the first request can take
  up to a minute to wake it. The app says so on screen while it waits.
  Everything after that is instant. Opening the link a minute before you start
  reviewing avoids the wait entirely.

## Test accounts (sharing flows pre-seeded)

| Account | Email | Password | What to look at |
|---|---|---|---|
| Ada Lovelace | `ada@demo.verso.app` | `VersoDemo1!` | Owns "Q3 Product Roadmap", already shared with Grace as editor |
| Grace Hopper | `grace@demo.verso.app` | `VersoDemo1!` | Sees that doc under **Shared with me**, can edit it, cannot share/delete it |

One-click "Sign in as Ada / Grace" buttons are on the login page. You can
also register a fresh account and share a document with it by email.

## Suggested 5-minute review path

1. Sign in as **Ada** -> open the roadmap doc -> type; watch "Saving... / All
   changes saved"; use toolbar formatting.
2. Select a sentence -> floating **✨ AI** menu -> Rewrite / Fix grammar
   (streams; badge shows `gemini` or labeled `heuristic` mode if no API key
   is configured).
3. **✨ AI** panel (top right) -> Generate summary -> Insert into document;
   ask the doc a question. Try the ✨ button next to the title for AI title
   suggestions.
4. **Share** -> change Grace's role / share with your own test account.
   **🕘** -> version history -> Restore. **Export ▾** -> Markdown, plain text,
   or PDF (opens the browser's print dialog; the page is styled for print).
5. Dashboard -> **Import file** (`.txt`, `.md`, `.docx` - stated in the UI)
   -> the file becomes an editable, formatted document. **📎** on a doc
   attaches arbitrary files.
6. Sign in as **Grace** (e.g. an incognito window) -> the doc is under
   **Shared with me** with an *editor* badge; open Ada's doc as a *viewer*
   (downgrade the role first) to see read-only mode.
7. To see the conflict handling: keep both windows on the same document, save
   as Grace, then type as Ada. Ada gets a banner and a "Load latest version"
   button instead of silently overwriting Grace's work.

## Status honesty

**Working end to end:** everything listed in the README feature table - 
documents, rich-text editing, autosave with conflict detection, rename,
import (.txt/.md/.docx), attachments, sharing with editor/viewer roles,
owned/shared dashboard split, version history + restore, Markdown/TXT/PDF
export, streaming AI (rewrite/shorten/expand/grammar/tone/summarize/ask)
with graceful no-key fallback, Dockerized deploy.

**Verification:** 55 API tests (`npm test`) and 38 checks driving the real UI
in Chromium as two users (`npm run qa`), both run in CI on every push together
with the strict typecheck, the production build, and a dependency audit.

**Intentionally not built (scope cuts, reasoning in the architecture note):**
real-time multiplayer cursors/CRDT editing, comments/suggestions, folders &
search, password reset. **Next 2-4 hours:** presence indicators (who else has
the document open, over the SSE plumbing that already exists), AI document
restructuring, comment threads.

## Known tradeoffs

Deliberate choices rather than oversights:

- **No live co-editing.** Concurrent saves are handled with optimistic
  concurrency: a save carries the version it was based on, a mismatch returns
  409, and the editor offers to load the latest version instead of silently
  overwriting. Version history is the safety net.
- **The session token lives in `localStorage`** and travels as a bearer header.
  That is immune to CSRF and simple to reason about; the exposure it trades for
  is XSS, which the strict `script-src 'self'` policy and the fact that document
  content is never rendered as HTML keep narrow. Tokens last 7 days and cannot
  be revoked server-side.
- **The rate limiter is in-memory**, which fits a single instance and would need
  a shared store the moment the service scales out. It resets on deploy and
  whenever the free instance sleeps.
- **Sharing by email reveals whether an account exists.** For an internal tool
  that is the useful behaviour ("no account for x@y - ask them to register");
  the per-IP limiter blunts bulk enumeration.
- **The AI layer is a product tool, not a general model proxy.** Actions and
  tones are server-validated enums, every call needs access to a real document,
  inputs and outputs are capped, and each user gets 60 AI calls per 5 minutes.
