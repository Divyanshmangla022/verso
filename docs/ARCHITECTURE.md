# Architecture note

## What I prioritized, and why

The brief asks for depth in a few areas over shallow coverage everywhere. I
chose four deep slices and cut everything else deliberately:

1. **A document model that actually round-trips.** Content is stored as
   ProseMirror JSON (the editor's native tree), not HTML strings. The server
   validates every save against an explicit allowlist schema (node types,
   mark types, 2 MB size cap, depth cap) mirroring exactly what the client
   editor can render - so the database can never hold content the product
   can't display, and formatting survives save -> reopen byte-for-byte
   (asserted by a test).

2. **Server-enforced access control.** Every document route resolves the
   caller's effective role (`owner` / `editor` / `viewer`) through one
   funnel (`requireDocAccess`) before touching data. UI hiding is a
   convenience; the API is the boundary. The permission matrix (who can
   read / write / share / delete / attach / restore) is covered by tests.

3. **Safe concurrent editing without CRDTs.** Real-time co-editing is the
   single most expensive Google-Docs feature, so I replaced it with
   optimistic concurrency: each save carries the version it was based on;
   a mismatch returns 409 and the client shows a "load latest version"
   banner instead of silently clobbering a collaborator's work. Version
   snapshots (last 20) with one-click restore give a safety net on top.

4. **An AI layer that degrades honestly.** Rewrite/shorten/expand/grammar/
   tone on a selection, plus summarize and grounded Q&A per document - all
   streamed over SSE. With `GEMINI_API_KEY` set it uses Gemini
   (`gemini-2.5-flash`); without a key every flow still works through a
   clearly-labeled heuristic engine (extractive summary, rule-based grammar
   cleanup, keyword-matched Q&A). Reviewers can exercise the whole product
   with zero paid dependencies, and the UI badges which engine answered.

## Stack and the reasoning behind it

| Choice | Why |
|---|---|
| **Node 26 native TypeScript** (server, no build step) | Type-stripping runs `.ts` directly; strict `tsc --noEmit` still gates CI-quality checks. Removes an entire class of build/deploy drift. |
| **Express 5 + zod v4** | Boring, reviewable HTTP layer. Every body is schema-validated at the boundary; one error middleware produces a consistent `{error, details}` shape. |
| **MongoDB** | A ProseMirror document *is* a JSON tree - it stores natively with no ORM impedance. Free Atlas M0 tier keeps the live deployment $0. |
| **GridFS** for uploads | Files live inside the same free database, so attachments survive the ephemeral filesystem of free hosting tiers - no S3 account required of reviewers. |
| **TipTap 3 (ProseMirror)** | Production-grade editing semantics (marks, history, lists, keyboard shortcuts) without building an editor from scratch; its JSON output is the persistence format. |
| **React 19 + Vite** | Editor page is code-split (~148 KB gz lazy chunk) so login/dashboard stay light (~79 KB gz). |
| **JWT + bcryptjs** | Stateless auth that works on a single free dyno; login compares against a constant-time dummy hash on unknown emails to avoid account-existence timing leaks. |
| **node:test + mongodb-memory-server** | 27 E2E tests run the real HTTP app against a real (throwaway) MongoDB - no mocking of the layers under test. |

One process serves both the API and the built SPA in production - the
cheapest thing to deploy, the fewest CORS problems, one URL for reviewers.

## Data model

```
users          { email (unique), name, passwordHash, createdAt }
documents      { title, ownerId, content: PM-JSON, version, createdAt, updatedAt }
shares         { docId, userId, role: editor|viewer, grantedBy, createdAt }   unique(docId,userId)
doc_versions   { docId, version, title, content, savedBy, createdAt }         capped at 20/doc
attachments.*  GridFS bucket; file metadata { docId, uploadedBy, mimeType }
```

`PUT /content` is a `findOneAndUpdate({_id, version: baseVersion}, {$inc: version})`
 - the version check and bump are one atomic operation, which is what makes
the conflict detection trustworthy.

## Import pipeline

`.docx` -> mammoth -> HTML -> TipTap `generateJSON` (server-side) -> sanitizer
(strips nodes/marks outside the supported schema, e.g. images) -> the same
`validateContent` gate used by normal saves -> stored document. `.md` goes
markdown-it -> same tail; `.txt` becomes paragraphs. The title is derived
from the first heading. Seeding uses this same pipeline, so the demo data
exercises the real code path.

## What I intentionally deprioritized

- **Live multiplayer (OT/CRDT) editing** - replaced with optimistic
  concurrency + version history (see above). This is the headline scope cut.
- **Comments / suggestion mode** - orthogonal to the core slice.
- **Folders, search, tags** - dashboard lists suffice at demo scale.
- **Password reset / email verification** - mock-auth level is explicitly
  allowed by the brief.
- **Granular AI permissions** - anyone who can read a doc can run AI on it.

## What I'd build next with another 2-4 hours

1. **Presence indicators** (who has the doc open) over the existing SSE
   plumbing - the cheapest visible step toward real-time.
2. **PDF export** via headless print styling (Markdown/TXT export exists).
3. **AI "structure this document"** - turn a pasted wall of text into
   headings/lists using the existing import sanitizer as the safety gate.
4. **Presence-aware conflict UX** - show who else has the doc open before
   an edit collides, softening the 409 flow into an expected hand-off.

## Hardening applied after the adversarial review pass

A 32-agent review workflow (5 parallel reviewers × adversarial verifiers)
confirmed 17 distinct defects, all fixed and locked in by regression tests:

- **Version restore is now version-guarded** like any save (409 on a
  concurrent edit instead of silent loss) and every revision snapshot is
  recorded *after* its write commits, so history attributes the right
  author and timestamp to each version.
- **TipTap v3 toolbars** subscribe via `useEditorState` (v3 stopped
  re-rendering React on transactions - active states were stale).
- **The autosave machine keeps dirty tracking through conflict/denied
  states**, so the tab-close warning stays honest; access revocation
  mid-edit flips the editor read-only with an explanatory banner.
- **Zip-bomb guard** on `.docx` import: the ZIP central directory is read
  (no decompression) and the declared inflated size is capped before
  mammoth runs. Import surfaces mammoth's warnings (dropped images/tables).
- **Rate limiting** (in-memory fixed-window): per-IP on login/register,
  per-user on AI routes.
- **`javascript:`/`data:` link hrefs are stripped** at the validation
  boundary; Markdown export escapes metacharacters and no longer rewrites
  blank lines inside code blocks; non-ASCII upload filenames are decoded
  correctly (multer's latin1 default).
- The dev JWT secret is generated per machine (gitignored) instead of a
  hardcoded fallback; transient network failures at startup no longer log
  the user out (only a real 401 clears the session).

Deliberate residual tradeoff: registration and share-by-email reveal
whether an account exists. For an internal collaboration tool this is the
intended UX ("no account for x@y - ask them to register"), and the auth
rate limiter blunts bulk enumeration.

## AI misuse containment

The AI endpoints are product tools, not a general LLM proxy. Two layers
enforce that. Structural: every call requires an authenticated account and
access to a real document, actions and tones are server-validated enums,
selections/questions/context/output are all capped, and each user gets 60
AI calls per 5 minutes. Behavioral: every system prompt pins the document
text as untrusted data AND task-locks the model as a writing tool - probed
live: "expand" on an essay request expands the request sentence instead of
writing the essay, "rewrite" on a code request produces prose not code, and
off-document questions get "I can only answer questions about this
document." Worst-case spend per user is therefore bounded and on-task.
