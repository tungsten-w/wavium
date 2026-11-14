# Agent-team journal

One entry per task (PLAN.md section D.4): task, agents used, round trips,
duration, what worked, what got stuck, agents created/changed/removed and why,
one idea for the next night. Newest last.

## 2026-11-13 — P2-1 AI provider layer (first full team cycle)

- **Mode**: run from an interactive session acting as chef (no `night.sh`
  container: no long-lived Claude token on the host yet, see below). Agents
  were spawned one by one with the role files of `.claude/agents/`.
- **Cycle**: dev (opus, ~9 min) → testeur (sonnet, ~3 min, +17 acceptance
  tests, 3 mutation checks, no bug) → relecteur (opus, ~3 min: 7 should-fix,
  0 blocker) → dev round 2 (opus, ~4 min after a usage-limit interruption,
  resumed with its context) → relecteur round 3 (~1.5 min: OK to merge,
  2 new should-fix + 3 nits) → doc (sonnet, <1 min).
  **3 round trips of 3.** Result: 62 tests in `server/ai`, `make test-server`
  99/0, lint OK. Branch `night/P2-1`, 8 commits.
- **Worked well**: the testeur and relecteur found different things (tests vs
  wire-format/security issues); the relecteur's round-1 list was concrete
  enough (file, why, fix) for the dev to fix everything in one pass. Resuming
  the same dev agent kept its context: much cheaper than a new agent.
- **Got stuck**: the relecteur's line numbers did not match the files (the doc
  agent noticed; the chef replaced them by function names). The relecteur
  cannot run tests (no Bun on its path) — fine for a reader, but say so in its
  brief. One API usage limit stopped the dev mid-fix; resuming worked.
- **Agents**: unchanged. Idea: give the relecteur the local Bun path so it can
  run one test when in doubt; ask for function names, not line numbers.
- **Idea for next night**: create a long-lived token (`claude setup-token`) so
  `night.sh` can run the same cycle unattended in its isolated containers.

## 2026-11-13 — P1-1, P2-6, P5-4, P6-3 (single instance, no team)

Done directly by the phase-0 instance between team steps. Browser checks
(Playwright on each branch's own dev stack) found one real bug the unit tests
missed (P2-6: wrong `restUrl` shape in the fixture). Lesson: for UI tasks the
testeur should also run a browser check (`tests/e2e/` from P1-7).

## 2026-11-13: P2-2 (instance A, solo) and the split with the other session

After the human fast-forwarded `main`, the two sessions split phase 2 by files:
A took P2-2 (settings store, routes, page); the other session took P2-3
(budgets) and P2-5 (model per task) in their own modules (`budget.ts`,
`routing.ts`), each creating its own tables, so no shared migration list and no
shared file except the AI README. Agreed boundaries by message before starting;
both P2-3 and P2-5 were ready before P2-2 with no conflict.

### 2026-11-13 · P2-4 (session A)

Mail triage moved from tollgate to the provider layer without moving the
pipeline: PHP keeps the queue, IMAP and caps and only swaps the HTTP call for
an internal one to Bun, which answers in tollgate's decisions shape. A P2-1
acceptance test (server/agent imports server/ai only through agent/ai.ts)
caught the first layout; the route moved to server/ai with the header check
injected from agent/ai.ts, instead of loosening the rule.
## 2026-11-13: P3-6 (instance A, solo)

After the second fast-forward of `main`, split again by message: the other
session took P2-4 (mail triage), A took P3-6 then P3-7. P3-6 reuses the app
tools through the registry instead of adding PHP, so it touched only one new
folder and one line of `server/agent/index.ts`. The real-stack check found
nothing in the tool; it found that the owner API ignores an unknown preset
(noted in the report).
## 2026-11-13: P3-7 (instance A, solo)

Journal + undo built on the existing tools instead of new PHP: each undo is an
inverse tool call computed from the action's own result. The real-stack run
caught a script mistake (events_since needs a cursor) and a thin summary for
notes created from content only (fixed: fall back to the result's fields).

### 2026-11-13 · P5-1 (session A)

Daily digest as one agent-layer module (`server/agent/digest/`) plus a Today
card on the Dashboard. Sources are injected, so the assembly is tested without
PHP; the live sources reuse the mail read helpers and the calendar / Daily Todo
internal routes from P3-1 and P3-2. Two catches from testing: sqlite numbers
`$n` placeholders by first appearance (lesson added), and the end-to-end run
showed a phishing demo mail listed as "reply": suspicious mail is now left out,
at the Mail chip threshold.

## 2026-11-13: P2-8 (session B, solo) — start of the v2 night

The other session wrote the v2 night plan (`reports/V2-NIGHT-PLAN.md`) and the
split; this session owns `TASKS.md` on main and marks the other column's
branches ready on request. P2-8 merges two tables into one paged timeline; a
mutation (tie condition) survived until the paging test inserted seconds out
of order, a reminder that test data that grows with time hides cursor bugs.
## 2026-11-13: P2-7 (session B, solo)

Read the MCP authorization spec (2025-11-25) first: it changed the plan (the
plan said "reuse apps/oauth2"; that app's admin-registered clients and
whole-account tokens do not fit self-registering MCP clients acting as one
agent). The OAuth server lives in Bun and issues its own tokens. The browser
run (logged out → login → consent → app callback) passed first time; the only
surprise was a type import line already changed by P3-7 (caught by lint, not
by vitest, which does not typecheck).
## 2026-11-13: P5-6 (session B, solo)

The assistant is an agent account, so it needed no permission code of its
own: everything goes through callTool. The dev mock could not drive a tool
loop on the real stack, so it learned one dev-only convention (`mock-tool:`);
the browser screenshots then found two UI bugs the DOM tests could not see
(z-index under the app's mobile drawer, text of two turns glued together).
### 2026-11-14 · P5-2 (session A)

AI reply drafts reuse what was there: `ai.forTask` (P5-1) for the model and
budget, the Mail bridge for drafts, `mail_send` with its approval for sending.
The end-to-end run caught what the fixture could not: on a fresh stack the mail
text is not stored yet, so the model saw only headers; the body is now fetched
first. Work was split around a usage-limit pause: a WIP commit with numbered
resume steps in the report made the restart cheap.

### 2026-11-14 · P5-3 (session A)

Filing rules split along the plan: a pure engine that runs on every new mail
without AI, and the AI only turning a sentence into that same data, checked by
the same validator (folder = enum of real folders, Trash never offered). A
claim table makes filing idempotent, which the reclassify button exercises in
the end-to-end run.

### 2026-11-14 · P5-5 (session A)

Nextcloud Mail already had one-click unsubscribe in PHP but no React UI and
nothing for agents. Kept its route for the UI, added two internal ops for the
agent tool (link frozen in the approval, re-checked before executing), and
never executed against the demo list: its domain is real (rule A1), so the
POST is covered by fakes only.

### 2026-11-14 · P6-1 (session A)

Generic install in `deploy/wavium/`, tested for real on localhost with three
fresh installs; each run found something a config check could not:
- Caddy refuses an empty global `email`;
- Daily Todo was not enabled;
- the installer gives the admin Nextcloud's sample files before any hook can
  stop it.

The post-install hook now handles the last two.
## 2026-11-13: P4-2 (session B, solo)

Done outside the v1 the other session assembled (agreed by message). Two
test-environment limits shaped the tests: happy-dom's DOMParser ignores XML
namespaces (no CalDAV multistatus in DOM tests) and `vi.mock` did not take
under the Bun runner, so components got their calendars as props and the
full route was checked in a real browser with two users (alice invites, bob
accepts).
## 2026-11-13: P4-3 (session B, solo)

The browser run found a real bug the DOM tests could not: two quick edits of
one task overwrote each other. Fixed with a per-task queue and proved by
removing the queue and watching the browser test fail. Also: /tmp (tmpfs)
filled up during the night; large scratch copies were moved, not deleted, to
a scratch folder outside the repository.
