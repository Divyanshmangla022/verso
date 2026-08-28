# SUBMISSION - Verso

Collaborative document editor with an AI writing layer, built for the Ajaia
AI-Native Full Stack Developer assignment.

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
- Free-tier note: the first request after idle can take ~50 s (Render free
  instance waking up). Everything after that is instant.

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
   **🕘** -> version history -> Restore. **Export ▾** -> Markdown.
5. Dashboard -> **Import file** (`.txt`, `.md`, `.docx` - stated in the UI)
   -> the file becomes an editable, formatted document. **📎** on a doc
   attaches arbitrary files.
6. Sign in as **Grace** (e.g. an incognito window) -> the doc is under
   **Shared with me** with an *editor* badge; open Ada's doc as a *viewer*
   (downgrade the role first) to see read-only mode.

## Status honesty

**Working end to end:** everything listed in the README feature table - 
documents, rich-text editing, autosave with conflict detection, rename,
import (.txt/.md/.docx), attachments, sharing with editor/viewer roles,
owned/shared dashboard split, version history + restore, Markdown/TXT
export, streaming AI (rewrite/shorten/expand/grammar/tone/summarize/ask)
with graceful no-key fallback, 37 passing E2E API tests, Dockerized deploy.

**Intentionally not built (scope cuts, reasoning in the architecture note):**
real-time multiplayer cursors/CRDT editing, comments/suggestions, folders &
search, password reset. **Next 2-4 hours:** presence indicators, PDF export,
AI document restructuring, comment threads.
