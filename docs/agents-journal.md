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
## 2026-11-17: v4 (one Claude session, solo, branch night/v4)

The owner gave the go for Messages and asked for a finished, tested and
checked v4 in one run, so the tasks shared one branch (one commit each).
The security pass found a real stored XSS in the note preview that no test
covered: the bare-URL linker also ran inside HTML attributes. Lesson: when a
renderer escapes first and then adds tags with regexes, every later regex
must skip tags. Two environment notes: Docker had run out of network
address pools (many old stopped stacks; only their empty networks were
removed), and the sandbox refused to download and run govulncheck, so that
check is left to the owner.
## 2026-11-20: V4-17 (Claude session, solo)

Asked to make the mail side "100 % operational" for daily use. Using the app
on a fresh stack found five bugs no existing test covered (no way to add a
second account from Mail, one-letter usernames for unknown providers, edits
wiping passwords and Google sign-in, triage paused after the AI was added,
filed mail invisible in its folder). Every new test was run against the old
code first and failed. Real Gmail/Orange servers were not touched (rule A1).
## 2026-11-23: V4-21 and V4-22 (Claude session, solo, branch night/V4-21)

Asked overnight for two things: the version next to the logo, opening a page
that tells what each version brought, and a sweep for the bugs a first-time
user would hit. The useful move was reading the **production log of a real
install** before touching the code: it held a 500 nobody had reported (pick an
accent colour, then a wallpaper). The cause was Atrium's own cache-buster
listener writing `theming/userCacheBuster` as a string while upstream wrote it
as "mixed", and Nextcloud refusing to change a stored value's type. Lesson:
when a fork adds a writer to a key upstream also writes, the *type* has to
match, and the failure only appears in the order colour-then-wallpaper.

The second finding came from the same log: a generated, gitignored file
(`core/js/mimetypelist.js`) is missing from the production image, so every
classic page logged a missing resource until an admin ran an occ command. The
dev stack copies the file from the release, which is exactly why nobody saw
it -- a workaround in the dev environment hid a real gap in the image.

The browser tests then crashed twice ("Page crashed"). It was not the app: the
container gave Chromium 64 MB of /dev/shm (fixed with `--ipc=host`), and the
machine itself was out of memory, swap full, with the production stack and the
dev stack both running. Worth remembering before blaming the code.

Last: every e2e test logged in as alice or bob, who have demo data, so the
screens a newcomer sees had never been opened by a test. The demo instance now
has an account with nothing in it, and a spec walks every app with it on
desktop and phone. It found no crash, but it is what makes the class of
first-run bugs above visible from now on. What it did show, in a screenshot,
is that the interface speaks two languages at once (English React parts,
translated classic pages) -- reported, not fixed: that is a translation
project.

## 2026-11-23 — V4-23: when "empty" means "I have not looked yet"

The report was "Curated shows nothing, All shows everything" on a mail account
connected minutes earlier. Three plausible causes were offered with the task
(empty preferences, classification not computed yet, inverted logic) and all
three were wrong. The production database settled it in two queries: the
account's 3354 messages were there, the triage table was empty, and the exact
SQL the Curated filter runs matched 3354 of 3354 rows. The filter was right.

The answer was in the request log. The label list never appeared with a failure
— it answered `200` nine times in two minutes while `POST /mailboxes/1/sync`
answered `428` fourteen times. The plain list says "this folder has no local
copy", which is the signal that makes the client start the first sync; the label
list ran a query over an empty cache and answered honestly that it found
nothing. Nobody was wrong about the data; one of the two endpoints could not
express "not yet". Lesson worth keeping: when two endpoints serve the same
list, the error contract is part of the API, and a faster path that skips it
brings back every bug the slow path already solved.

Two things about verification. First, the browser test written for this bug
does not reproduce it: in the dev stack a three-message folder is already
cached by the time the first list runs, so it passed with the fix removed. It
was kept as an end-to-end walk of Mail, and the bug is pinned by a controller
test and a client test, each checked by breaking the fix and watching them
fail. Writing the e2e test first and trusting it would have shipped nothing.

Second, that walk found a second bug nobody had reported: Favorites listed the
account's `\Flagged` folder, which Gmail has and Orange, Free, SFR and iCloud
do not — so the page was always empty for most people, in a sidebar entry
shown to everyone. Chasing it cost an hour down the wrong path (GreenMail
advertises no CONDSTORE, so flags set on the mail server never reach Wavium's
copy, which looks exactly like a bug in the app). Both findings are in
`docs/lessons.md`.

Rule A1 was bent, deliberately and with the owner's explicit instruction: the
diagnosis was made against their live instance. Read-only — `SELECT`s,
container logs, deployed files — no write, no mail sent, no credential read.
Without it the real cause would have been guesswork, because the dev stack
cannot reproduce the condition.

## 2026-11-24 — V4-28: the cheapest bug to write is the one that spends money

Two halves of the same card: let a person choose which folders get classified,
and let them redo mail sorted by an older set of questions. The first half is a
setting; the risk is in the second.

The interesting part was neither. `enqueue()` kept one cursor for the whole
instance (`scannedUpTo`) because it only ever scanned two folders. Add a folder
to that and there are exactly two outcomes, both wrong: the folder's mail is
older than the cursor and is never seen, or the cursor is reset and a thousand
old mails are queued as *new* mail — the lane whose budget is the whole daily
cap, spent in one pass. The fix was to give each folder its own cursor and let a
folder with no cursor start at zero in the backlog lane, which is what the very
first scan of the inbox already did. The one-time hand-over of the old global
cursor to Inbox and Spam is guarded by the presence of the new key, so no
instance rescans what it already classified. A test pins both directions: mail
already in a folder chosen later is backlog, the next mail to arrive there is
new mail.

The catch-up leaves two things alone: mail the owner corrected by hand — a
re-run must never overwrite a person's answer — and mail already queued. It
prices itself from the average of the last hundred real classifications, so the
page can say "about €0.0006" before anything runs, and a hard cap of 500 per
call sits on top of the daily backlog cap.

Then the dev stack found what six green unit tests could not. `POST /triage/backfill`
with `max` 9999 answered **500**: the framework range-checks any controller
parameter *named* `limit` against 1..500 and throws before the controller runs,
so the service's own clamp never happened. Renaming the parameter fixed it.
Lesson kept in `docs/lessons.md`: a parameter name can carry framework
behaviour, and a clamp is only tested if the value reaches the code that clamps.

Verification followed V4-23's rule: every test was checked by breaking the code
it guards — four mutations of the service, two of the UI, each failing exactly
the tests meant to catch it — and the whole thing was then run against the live
dev instance, including a staged old question set with one mail marked as
corrected by hand.

## 2026-11-24 — V4-34: the status page said "on" for a pipeline that could not dial out

This session started as an inventory, not a task: find what works in Wavium and
repair what does not. The inventory is in
`reports/INCIDENT-2026-11-24-disques.md` section 12. One thing it found is worth
keeping here, because the shape of the bug is more interesting than the fix.

Classification had 3401 mails queued and 0 classified. Not a subtle failure: the
queue's own `last_error` column held the answer in plain text, `cURL error 7 ...
for http://127.0.0.1/agent/v1/internal/ai/triage`. Nobody had read it, because
nothing surfaced it — the Mail status page showed the pipeline as enabled, which
it was, and said nothing about it being unable to reach anything.

`ATRIUM_SERVER_URL` sat in the `x-app` environment block of
`deploy/wavium/compose.yaml`, shared by `app` and `cron` through a YAML anchor.
`http://127.0.0.1:80` is correct for `app`, which runs Bun in the same
container. The triage worker runs in `cron`, where nothing listens on port 80.
A value that is right for one consumer of a shared block and wrong for the
other: the anchor made the mistake invisible, because the line reads correctly
wherever you look at it.

The same inspection found `deploy/compose.yaml` declaring no
`ATRIUM_SERVER_URL` at all, falling back to the default `http://web:8080` — the
dev stack's service name, in a stack whose services are `app`, `cron`, `db`,
`redis`. Two stacks, two different ways to be unreachable, both silent.

Both now name `app`: from the `app` container the service name resolves to
itself, so one value is right everywhere and there is no second copy to drift.
The test asserts the invariant rather than the value — declared, not loopback,
and naming a service of that same file — so it catches both failures and any
third one of the same family. Checked by breaking the code in both directions.

Two lessons worth carrying:

- **A queue that records why it failed is worth little if nothing reads the
  column.** The queue had been failing since before the disk incident: the
  `pre-v42` backup of 2026-11-23 already held 3398 pending rows, 0 classified
  and 0 AI providers. Classification had never once run in production.
- **A YAML anchor hides per-consumer assumptions.** `127.0.0.1` carries an
  implicit "in this container", and an anchor copies the text without the
  assumption. Service names carry no such assumption, which is why the fix is
  also the simpler configuration.

Deployed the same evening, on the owner's instruction: `atrium:v4.2` built from
`night/V4-34` (`6fabe4e1c54d`, `WITH_DAILY_TODO=1`), which carries V4-24 through
V4-28 as well — none of them had ever been built into an image, so the live
instance had been running `atrium:v4.1` from 2026-11-23 while five finished
tasks sat in branches. `mail_message_tag` (V4-24) went from absent to live:
`tools/list` returns 24 tools instead of 23, and the handler validates its
input. No migration to run (same `OC_Version`, so the entrypoint's code sync
and `occ upgrade` reported "No upgrade required"), which also means the
rollback is a plain image swap. A verified backup was taken first.
