# Tasks

From `PLAN.md` (section B). Claim a task before starting (rule A4):
`[~] (instance X, date)`. Legend: `[ ]` free, `[~]` in progress, `[x]` done
(branch ready), `[!]` blocked (see the report). `deps:` = wait for those first.
One branch per task: `night/<ID>`; one report: `reports/<ID>.md`.

## Phase 0: groundwork (one instance, first)

- [x] P0-1 Git repository from the zip (`import atrium-main 2026-11-08`)
- [x] P0-2 Remove personal data; `memory/` archived outside; `docs/lessons.md`
- [x] P0-3 Dev stack in one command (`docker compose up`): Bun + PHP-FPM, PostgreSQL, Redis, GreenMail, demo data
- [x] P0-4 `Makefile`: up, down, test, lint, build, reset
- [x] P0-5 CI: GitHub Actions running `make lint test` (not run yet: no remote)
- [x] P0-6 Agent files: CLAUDE.md, AGENTS.md, TASKS.md, reports/
- [x] P0-7 Atrium README
- [x] P0-8 Agent team: `.claude/agents/*.md`, `night.sh`, `docs/agents-journal.md` (one full cycle on P2-1; night.sh unattended run needs a token)

## Phase 1: clean up and secure

- [x] P1-1 Docs up to date: deploy/README (Bun/FPM), ADR table, todo phase 3, Dockerfile duplicate comment — branch ready: night/P1-1
- [x] P1-2 Chunked uploads (`server/php.ts`): no full body in RAM; test > 2 GB — branch ready: night/P1-2 (on top of P1-3)
- [x] P1-3 Bun limits: `idleTimeout`, `ATRIUM_MAX_BODY` — deps: P1-2 (same file area) — branch ready: night/P1-3 (merge first)
- [x] P1-4 Auth cache (`server/agent/auth.ts`): revoked token refused at once — branch ready: night/P1-4
- [x] P1-5 Webhooks: block internal addresses unless `ATRIUM_WEBHOOK_ALLOW` — branch ready: night/P1-5
- [x] P1-6 React tests: shell + Mail (list, open, send a draft), vitest + fake server — branch ready: night/P1-6
- [x] P1-7 Playwright end-to-end: login, Mail, Calendar, Files not empty — branch ready: night/P1-7

## Phase 2: AI (after P0)

- [x] P2-1 Provider layer `server/ai/`: Anthropic, OpenAI, Mistral, OpenAI-compatible, Ollama, mock — branch ready: night/P2-1 (review items all fixed; usage via AiRequest.onUsage)
- [x] P2-2 Settings > AI: providers, encrypted keys, test connection — deps: P2-1 — branch ready: night/P2-2
- [x] P2-3 Budgets and usage: daily/monthly caps, tokens and cost, pause on errors — deps: P2-1 — branch ready: night/P2-3
- [x] P2-4 Mail triage on the provider layer (instead of tollgate), `mail-v2` kept — deps: P2-1, P2-3 — branch ready: night/P2-4
- [x] P2-5 Model per task (small for triage, bigger for summaries/drafts) — deps: P2-1 — branch ready: night/P2-5
- [x] P2-6 "Connect an agent" box: Claude Code, Claude Desktop, Cursor, Codex, REST — branch ready: night/P2-6
- [~] (sodium-93, 2026-11-13) P2-7 OAuth 2.1 for MCP (discovery, PKCE, consent screen)
- [x] P2-8 Several agents per user, activity page — deps: P2-6 — branch ready: night/P2-8

## Phase 3: agent tools for every app (ADR 0009 order)

- [x] P3-1 Daily Todo tools + `todo.*` events — branch ready: night/P3-1
- [x] P3-2 Calendar + Tasks tools, discoverable delegated calendars, `calendar.*` / `task.*` events — branch ready: night/P3-2
- [x] P3-3 Contacts tools (simple fields, no raw vCard) — branch ready: night/P3-3
- [x] P3-4 Files tools (share = approval) — branch ready: night/P3-4
- [x] P3-5 Notes, then Activity (read only) — branch ready: night/P3-5
- [x] P3-6 Cross-app `search` tool — deps: P3-1..P3-5 — branch ready: night/P3-6
- [x] P3-7 Undo an agent action from the activity log — branch ready: night/P3-7

## Phase 4: finish the React apps

- [~] (sodium-7a, 2026-11-13) P4-1 Mail: threads, contact autocomplete, HTML compose, tags, snooze, unified inbox, Sieve, undo delete
- [~] (sodium-93, 2026-11-13) P4-2 Calendar: appointments, attendees, subscriptions, old event URLs
- [~] (sodium-93, 2026-11-13) P4-3 Tasks: recurring, drag sort, sharing
- [~] (sodium-93, 2026-11-13) P4-4 Files: versions, comments, tags, file requests, templates, external storage
- [~] (sodium-93, 2026-11-13) P4-5 Dashboard: JS widgets, weather
- [~] (sodium-93, 2026-11-13) P4-6 Last Vue settings pages: Availability, Flow, External storage, Passkeys

## Phase 5: mail organiser (after P2-1..P2-4)

- [x] P5-1 Daily digest: what needs a reply or an action today — branch ready: night/P5-1 (on top of P2-4)
- [x] P5-2 AI reply drafts through approval (nothing sent without a click) — branch ready: night/P5-2
- [~] (sodium-7a, 2026-11-13) P5-3 Filing rules in natural language (AI proposes, human validates, applied without AI)
- [x] P5-4 Scam detection: display name vs address domain — branch ready: night/P5-4 (heuristics; AI signal waits for P2-4)
- [~] (sodium-7a, 2026-11-13) P5-5 Assisted newsletter unsubscribe (`List-Unsubscribe`, confirmation)
- [~] (sodium-93, 2026-11-13) P5-6 Built-in assistant panel (provider + MCP tools, same permissions)
- [~] (sodium-7a, 2026-11-13) P5-7 Mail → tasks and calendar ("this mail has a meeting → create it?")

## Phase 6: installable by anyone

- [~] (sodium-7a, 2026-11-13) P6-1 Generic production compose (domain, Caddy with HTTPS, resources from .env)
- [~] (sodium-93, 2026-11-13) P6-2 Images on GHCR (amd64 baseline + arm64), tagged
- [x] P6-3 `make backup` / `make restore`, tested — branch ready: night/P6-3
- [~] (sodium-93, 2026-11-13) P6-4 Install guide + migration from an existing Nextcloud
