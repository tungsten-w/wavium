# Night plan: from today's main to Atrium v2

- Written 2026-11-13 by session A, for session A and session B (and any session
  that picks it up after a context or usage reset).
- Start: `main` = 0ca5d2f6. Done so far: P0, P1, P2-1 to P2-6, P3-1 to P3-7,
  P5-1, P5-4, P6-3.
- The human said (2026-11-13 evening): keep working through the night, do not
  stop before v2 is finished.

## What "v2 done" means

Every task of TASKS.md is `[x]` and in `main`, except the ones that need the
human (below). Each task:
- has its own tests;
- passes `make lint` and `make test`;
- has an end-to-end check on its own stack;
- has a report `reports/<ID>.md`.

The last step is a release note (`reports/V2.md`) and a morning note.

**Only the human can do these:**
- **P6-2:** publishing images to GHCR is an outward push and needs credentials.
  Prepare the workflow and the Makefile target only; never push.
- Real-provider checks (rule A2: the mock only).
- **Merging into `main`.** The human merged merge-check-3 themselves. Do the
  same as tonight: prepare `night/merge-check-N` (main + ready branches, fully
  tested) and ask in the morning note. If the human has explicitly authorized
  fast-forward merges for the night, do them: `--ff-only`, never push, and list
  them in the morning note.

## Split (one owner per file area, to avoid conflicts)

| Order | session A (mail / AI features) | session B (agents / apps / install) |
| --- | --- | --- |
| 1 | P5-2 AI reply drafts through approval | P2-8 Several agents per user + activity page |
| 2 | P5-3 Filing rules in natural language | P2-7 OAuth 2.1 for MCP |
| 3 | P5-5 Assisted unsubscribe | P5-6 Built-in assistant panel (after P2-8) |
| 4 | P5-7 Mail → tasks / calendar | P4-2 Calendar, P4-3 Tasks |
| 5 | P4-1 Mail gaps | P4-4 Files, P4-5 Dashboard, P4-6 Vue settings pages |
| 6 | P6-1 Production compose (Bun + Caddy) | P6-4 Install + migration guide; P6-2 prepared, not pushed |

**Shared files:** `server/agent/index.ts` (one line in the modules list),
`docs/agents-journal.md`, `docs/lessons.md` and `TASKS.md`. session B owns
`TASKS.md` on main and claims tasks there.

**Ports:**
- session A: 8201 and up (`atrium-p52` …);
- session B: 8101 and up.

## Rules that keep the night safe

- AGENTS.md section A above all:
  - no production, no real keys;
  - one task = one branch `night/<ID>` = one worktree under `../wt/`;
  - never commit on main, never force-push, never delete a mail.
- Docker through `sg docker -c "..."`; every worktree sets
  `COMPOSE_PROJECT_NAME` and `ATRIUM_PORT`; stop the stack when done.
- `server/agent/**` never imports `server/ai/**` except through
  `server/agent/ai.ts`. Use `ai.forTask(uid, task)` (added in P5-1) for AI
  calls. The P2-1 acceptance test enforces it.
- sqlite numbers `$n` by first appearance: write placeholders in order.
- PHP edits need `docker compose restart php` (opcache), and one class per file
  (PSR-4).
- Internal Bun → PHP calls have no session user: set the volatile active user
  (see the calendar controller).
- Before saying done:
  - a mutation check;
  - `make lint` and `make test` in Docker;
  - an end-to-end run with curl as alice on the task's stack;
  - the report.
- Blocked more than 30 min: write it in the report, set the task back to
  `[ ]`, take the next one.

## Designs (enough to start without re-reading everything)

### P5-2 AI reply drafts through approval (session A)

- Agent tool `mail_draft_reply`, plus an owner route for the UI button
  "Suggest a reply". It takes a `message_key` and an optional instruction.
- The model works on the thread text (`getThread`); task `draft`, so the large
  model (P2-5); it goes through `ai.forTask`.
- The result is saved as a **Mail draft** (existing draft API, Drafts folder).
  It is never sent.
- Sending stays the existing `mail_send` with action `send`, which needs an
  approval by default. The UI shows the draft in the compose window, and the
  human clicks Send.
- Prompt-injection guard: the mail is data.
- Tests:
  - the mock writes the draft;
  - nothing is sent;
  - the approval is required for send;
  - budget errors come back as clear messages.

### P5-3 Filing rules in natural language (session A)

- Rule = `{when: {from_domain?, from?, category?, subject_contains?}, then:
  {move_to_folder | add_tag | mark_read}}`, stored per user in a Bun table.
- **Applied without AI**: on `mail.received` (arrival watcher), and on demand
  for the existing mail. Moves go through the pending-ops path, never a
  delete.
- The AI only **proposes**: "les factures → dossier Admin" + the last 200
  classified mails → rule JSON (forced tool). The UI shows the rule and how
  many mails match, then the human validates.
- Tests:
  - the rule engine is pure;
  - the proposal works with the mock;
  - nothing applies before validation;
  - folder moves are idempotent.

### P5-5 Assisted unsubscribe (session A)

- Use the stored headers (`mail_bodies.headers`): `List-Unsubscribe` and
  `List-Unsubscribe-Post`.
- One-click (RFC 8058 POST) only after confirmation in the UI. The agent tool
  is action `send` (approval).
- `mailto:` unsubscribes become a draft for the human to send.
- URL fetches go through netguard: no internal addresses.
- In tests the HTTP is a fake: never call a real list.

### P5-7 Mail → tasks and calendar (session A)

- "This mail has an appointment / a deadline": the AI extracts title, start,
  end, place and due date (forced tool, task `triage` or `summary`).
- It becomes a **proposal**, shown in the reader as "Create event?" /
  "Create task?". One click creates it through the calendar internal API
  (P3-2).
- For agents: the existing calendar tools already cover it; add the extraction
  tool `mail_extract_dates`.

### P4-1 Mail gaps (session A)

Order by value:
1. undo delete (move back from Trash);
2. contact autocomplete (Contacts internal API, P3-3);
3. threads view;
4. tags;
5. snooze;
6. unified inbox;
7. HTML compose;
8. Sieve last.

A gap that is too big goes back as its own `[ ]` line in TASKS.md with a
note.

### P6-1 Production compose (session A)

- `deploy/compose.yaml` is the old stack: do **not** run it.
- Write `deploy/v2/compose.yaml`: php-fpm, cron, Bun web, Postgres, Redis and
  Caddy (HTTPS from `ATRIUM_DOMAIN`), with everything from `.env`.
- Set `ATRIUM_SERVER_URL` for PHP → Bun (triage).
- Validate it **only** with `docker compose config` and a local run on a test
  project name, `ATRIUM_DOMAIN=localhost`, internal CA. No real domain.

### P2-8, P2-7, P5-6, P4-2…P4-6, P6-4 (session B)

See PLAN.md. Notes:
- **P5-6:** the assistant calls the same `callTool` path as an external agent,
  as a built-in agent account of the user, so permissions and approvals come
  for free. Use `ai.forTask(uid, 'assistant')` with tools; stream the answers.
- **P2-7:** reuse `apps/oauth2`. The consent screen shows the agent's areas and
  modes.

## Resuming after a reset

1. `cd <dossier du dépôt> && git log --oneline -3 main && cat TASKS.md`
2. Read this file, then the last `reports/*.md`, then `docs/lessons.md`.
3. `ListAgents` → message the other session: what you take, which port.
4. Continue the first task of your column that is not `[x]`.

## Morning note

At the end, or when the human wakes up, write
`reports/MORNING-<date>.md`:
- what is in which branch;
- the merge-check branch and its one-line merge command;
- the test results;
- the open questions, each answerable in one word.
