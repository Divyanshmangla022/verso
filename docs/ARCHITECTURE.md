# Architecture note

## What I prioritized, and why

The brief asks for depth in a few areas over shallow coverage everywhere. I
chose four deep slices and cut everything else deliberately:

1. **A document model that actually round-trips.** Content is stored as
   ProseMirror JSON (the editor's native tree), not HTML strings. Every save
   passes an explicit allowlist (node types, mark types, heading levels, a
   2 MB size cap, a depth cap) *and* is then built against the editor's own
   schema with `Node.fromJSON(...).check()` - the same StarterKit the browser
   runs. A name-level allowlist alone would still accept valid names in
   invalid arrangements (an empty text node, a list holding text directly),
   and TipTap responds to those by silently swapping in an empty document,
   which autosave would then persist over the real content. So the database
   cannot hold content the product can't display, and formatting survives
   save -> reopen byte-for-byte (asserted by a test).

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
   (`gemini-3.6-flash`); without a key every flow still works through a
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
| **node:test + mongodb-memory-server** | 55 E2E tests run the real HTTP app against a real (throwaway) MongoDB - no mocking of the layers under test. |
| **Playwright for the parts tests cannot see** | 38 checks drive the built app in Chromium as two users. Undo after opening a document, a menu clickable behind its own backdrop, a bubble menu that follows the right scroll container: these fail only in a browser. |

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

## Export

Markdown and plain text are serialized server-side from the stored JSON.
The Markdown writer is deliberately careful: text that would otherwise *become*
structure is escaped (a paragraph reading `1. Install` stays a paragraph), code
spans get a backtick run longer than anything inside them, link targets are
percent-encoded, and a hard break inside a heading becomes a space rather than
ending the heading early.

PDF goes through the browser's own print pipeline: a print stylesheet hides the
app chrome, opens up the scroll containers, and sets page margins and break
rules. That yields real selectable text, working links and full Unicode from
system fonts - and it costs the server nothing. The alternative, a headless
Chromium, would add roughly 300 MB to the image and is an out-of-memory risk on
a 512 MB instance; a canvas-based library would rasterize the text.

## What I'd build next with another 2-4 hours

1. **Presence indicators** (who has the doc open) over the existing SSE
   plumbing - the cheapest visible step toward real-time.
2. **Presence-aware conflict UX** - show who else has the doc open before
   an edit collides, softening the 409 flow into an expected hand-off.
3. **AI "structure this document"** - turn a pasted wall of text into
   headings/lists using the existing import sanitizer as the safety gate.
4. **A `.docx` writer** for export, mirroring the Markdown serializer.

## Hardening applied after the review passes

Two rounds of review, each run the same way: several reviewers read the code
from different angles (server logic, security, frontend state, data integrity,
tests, deployment), and every finding was then handed to independent verifiers
whose job was to *refute* it by reading the actual code and the installed
library sources. Only findings that survived that attack were fixed; several
plausible-sounding ones were disproved and deliberately left alone rather than
patched with dead code.

### First round

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
  (The second round found that this was not enough - see below.)
- **Rate limiting** (in-memory fixed-window): per-IP on login/register,
  per-user on AI routes.
- **`javascript:`/`data:` link hrefs are stripped** at the validation
  boundary; Markdown export escapes metacharacters and no longer rewrites
  blank lines inside code blocks; non-ASCII upload filenames are decoded
  correctly (multer's latin1 default).
- The dev JWT secret is generated per machine (gitignored) instead of a
  hardcoded fallback; transient network failures at startup no longer log
  the user out (only a real 401 clears the session).

### Second round

The interesting result of the second pass was that two of its findings were
defects *in the first round's fixes* - a reminder that a guard is only worth
what its adversarial test proves.

- **The zip-bomb guard was decorative.** It summed the uncompressed sizes
  declared in the ZIP central directory - numbers the uploader controls. JSZip
  (under mammoth) only compares the real inflated length against the declared
  one *after* inflating the whole entry, so an archive claiming 1 KB could
  still expand to gigabytes in memory. The guard now inflates each entry itself
  with the declared size as a hard output cap, so a lying header aborts after a
  kilobyte. A test builds a real bomb (200 MB from a few-KB archive, generated
  by streaming so the test never holds it either) and asserts the process does
  not grow.
- **Loading a document was part of the undo stack.** `setContent` is an
  ordinary transaction, so one Ctrl+Z right after opening a document reverted
  to the editor's empty starting state - and autosave then wrote that empty
  document over everyone's copy. The editor is now rebuilt around each loaded
  version, which makes loaded content the initial state rather than an edit.
  The same change removes a phantom save after "Load latest version" that could
  bounce two collaborators between conflict banners.
- **Rate limiting was one global bucket in production.** `req.ip` is the
  proxy's address unless Express is told how many hops to trust, so 30 failed
  logins from anyone locked out every user. `trust proxy` is now a configured
  hop count (never `true`, which would let clients spoof the header).
- **Autosave retried permanently-rejected content forever.** Any non-4xx-aware
  failure re-sent the whole document every 900 ms. Client errors that cannot
  succeed now stop with the server's reason shown and a retry button; transient
  failures back off up to 30 s.
- **Leaving the page inside the debounce window dropped the last edits**, since
  no `beforeunload` fires for in-app navigation. The editor now flushes on
  unmount.
- **Uploads had no rate limit** while buffering whole files in memory, and an
  attachment could be written after its document was deleted (an orphan no
  route could ever reach). Both are fixed.
- **`body-parser` and multer failures became 500s** with stack traces; an
  oversized document produced an opaque error the client retried forever. They
  now map to 400/413 with actionable messages.
- **Markdown export could change the document's structure** on re-import
  (unescaped block starts, backticks inside code spans, spaces in link targets,
  a hard break ending a heading). All four are fixed and tested.
- Smaller: `.docx` underline is preserved, `.md` imports warn about dropped
  tables and images, CR-only text files split into paragraphs correctly, the
  non-ASCII filename guard compared against the literal string `FFFD` instead
  of U+FFFD, dialogs trap focus and close on Escape, keyboard users can reach
  the card actions, the export menu can no longer be clicked through, the
  selection menu follows the editor's own scroll container, JWT verification
  pins HS256, shutdown drains in-flight requests before closing the database,
  and the AI key mask now also covers Google's newer `AQ.` key format.
- **Upstream capacity errors are retried.** On the free Gemini tier a 503
  ("model overloaded") or a momentary 429 is routine and clears within seconds;
  driving the live site showed them on roughly half of rapid calls. The engine
  now retries such failures twice with a short pause (honouring the request's
  abort signal) before reporting an error, so a reviewer sees an answer that is
  a little late rather than a failure.

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
