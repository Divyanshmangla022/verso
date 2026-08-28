# AI workflow note

The brief asks how AI was used to build this, where it helped, what was
rejected, and how correctness was verified.

## Tools used

- **Claude Code (Opus)** as the primary engineering agent: scaffolding,
  implementation, test writing, and orchestrated multi-agent code review.
- **Google Gemini** is the AI *inside the product* (rewrite/summarize/ask),
  not part of the build workflow.

## Where AI materially sped things up

- **Breadth in one pass.** The full vertical slice — Express routes, Mongo
  layer, TipTap editor wiring, SSE streaming client, CSS system — was
  drafted quickly enough to leave real time for verification, which is
  where the actual engineering judgment went.
- **The test suite.** 27 end-to-end API tests (auth, permission matrix,
  concurrency conflicts, import, attachments, versions, AI SSE) were
  generated against the real app and then tightened by hand — writing these
  manually would have consumed a large share of the timebox.
- **Adversarial review at scale.** After the app worked, a multi-agent
  review pass ran five parallel reviewers (server logic, security, frontend
  state machines, data integrity, UX edge cases), and every finding was then
  attacked by an independent "skeptic" agent instructed to refute it by
  reading the actual code and library sources (32 agents total). 24 of 27
  findings survived refutation (~17 distinct defects after dedup) and were
  fixed with regression tests; 3 were proven wrong and discarded. The
  standout catch: TipTap v3 silently stopped re-rendering React toolbars on
  editor transactions - invisible in a quick manual test, guaranteed to be
  noticed by a careful reviewer.

## AI output that was changed or rejected

- **Express 5 typing drift:** generated route code assumed Express 4's
  `req.params` typing; Express 5 types params as `string | string[]`. Fixed
  with a single normalizing helper (`pathParam`) rather than sprinkling casts.
- **SSE "note" hack:** the first AI-streaming implementation smuggled the
  heuristic-mode notice through a response header plus an empty keep-alive
  chunk. Rejected and redesigned so the notice travels in the typed `meta`
  event — one contract, no header parsing on the client.
- **Refuted review findings were discarded, not "fixed":** several reviewer
  agents proposed defensive patches for scenarios the verifier agents proved
  impossible in this codebase (guards already present, or library behavior
  mis-remembered). Applying them would have added dead code.
- **Editor schema guesses:** node/mark names in the server-side validator
  were verified against the *installed* TipTap sources (`bold` vs `strong`,
  StarterKit v3 including underline/link) instead of trusting model memory.

## How correctness, UX quality, and reliability were verified

1. **Automated:** `npm test` (27 E2E API tests) and strict `tsc` across all
   three workspaces on every change; `npm audit` clean; the production
   Docker image is built and smoke-tested (health, login, SPA serving)
   before deploy.
2. **Behavioral, not just unit-level:** tests assert outcomes a user would
   feel — a stale save returns 409 with the current version; a revoked user
   really loses access; a `.docx`/`.md` import produces headings and lists;
   downloaded attachment bytes equal the upload.
3. **Real-browser verification:** a scripted Playwright session logs in as
   both demo users, types formatted text, watches the autosave state reach
   "All changes saved", opens the AI bubble/modal/panel, the share dialog,
   and version history, and screenshots every step (see
   `docs/screenshots/`). Console errors fail the run; the shipped build has
   zero.
4. **Human judgment on the product:** scope cuts (no CRDT multiplayer, no
   comments), the conflict-banner UX, the heuristic-fallback design, and the
   permission model were product decisions made deliberately, not emergent
   from generation.
