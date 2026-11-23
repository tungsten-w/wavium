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
- [x] P2-7 OAuth 2.1 for MCP (discovery, PKCE, consent screen) — branch ready: night/P2-7
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

- [~] (session A, 2026-11-13) P4-1 Mail: threads, contact autocomplete, HTML compose, tags, snooze, unified inbox, Sieve, undo delete
- [x] P4-2 Calendar: appointments, attendees, subscriptions, old event URLs — branch ready: night/P4-2
- [x] P4-3 Tasks: recurring, drag sort, sharing — branch ready: night/P4-3
- [~] (session B, 2026-11-13) P4-4 Files: versions, comments, tags, file requests, templates, external storage
- [~] (session B, 2026-11-13) P4-5 Dashboard: JS widgets, weather
- [~] (session B, 2026-11-13) P4-6 Last Vue settings pages: Availability, Flow, External storage, Passkeys

## Phase 5: mail organiser (after P2-1..P2-4)

- [x] P5-1 Daily digest: what needs a reply or an action today — branch ready: night/P5-1 (on top of P2-4)
- [x] P5-2 AI reply drafts through approval (nothing sent without a click) — branch ready: night/P5-2
- [x] P5-3 Filing rules in natural language (AI proposes, human validates, applied without AI) — branch ready: night/P5-3 (on top of P5-2)
- [x] P5-4 Scam detection: display name vs address domain — branch ready: night/P5-4 (heuristics; AI signal waits for P2-4)
- [x] P5-5 Assisted newsletter unsubscribe (`List-Unsubscribe`, confirmation) — branch ready: night/P5-5 (on top of P5-3)
- [x] P5-6 Built-in assistant panel (provider + MCP tools, same permissions) — branch ready: night/P5-6
- [x] P5-7 Mail → tasks and calendar ("this mail has a meeting → create it?") — branch ready: night/P5-7 (on top of P5-5)

## Phase 6: installable by anyone

- [~] (session A, 2026-11-13) P6-1 Generic production compose (domain, Caddy with HTTPS, resources from .env)
- [~] (session B, 2026-11-13) P6-2 Images on GHCR (amd64 baseline + arm64), tagged
- [x] P6-3 `make backup` / `make restore`, tested — branch ready: night/P6-3
- [~] (session B, 2026-11-13) P6-4 Install guide + migration from an existing Nextcloud

## Phase 7: v4

Order: V4-1 first (small, makes the demo better), then Messages (V4-2..V4-7,
ADR 0010, waits for the owner's go), the rest in any order.

### v3 leftovers

- [x] V4-1 Demo polish: upload limit shown before uploading (Files, Mail attachments; IDEAS 3); the AI answers in the UI language (digest said "Aujourd'hui" on an English UI); Dashboard "Important mail" widget not empty on the demo — night/v4

### Messages: Google Messages in Wavium (ADR 0010) — done on night/v4 (Claude session, 2026-11-17)

- [x] V4-2 Sidecar `services/gmessages/` (Go, libgm pinned): pair (QR + Google account), conversations, messages, send, events over WebSocket; fake mode for tests and the demo
- [x] V4-3 Bun side: tables, sync from the sidecar, local copy kept forever, attachments in `Messages/`, encrypted pairing session — deps: V4-2
- [x] V4-4 Messages app (React): Settings > Messages > Link my phone (QR), conversation list, thread, send SMS/RCS, images, search, "phone offline" banner — deps: V4-3
- [x] V4-5 Agent tools and events `messages.*` (send = approval, one-time codes hidden from agents) — deps: V4-3
- [x] V4-6 Contacts: phone number → name and avatar; Messages in the cross-app search and the morning digest ("2 SMS need a reply") — deps: V4-3
- [x] V4-7 Demo: fake conversations for alice and bob, sidecar off — deps: V4-4

### Ideas picked from reports/IDEAS.md

- [x] V4-8 Webhook test button in Settings > Agents (IDEAS 1) — night/v4
- [x] V4-9 Agent tokens page: last use, IP, revoke in one click (IDEAS 2) — night/v4
- [x] V4-10 "Why is this mail here?" with "wrong" button feeding the classifier (IDEAS 5) — night/v4
- [x] V4-11 Quiet hours for agents, pings queued into the morning digest (IDEAS 8) — night/v4
- [x] V4-12 `make test-e2e` in CI with screenshots per app (IDEAS 9) — night/v4

### Friends' feedback on v3 (2026-11-14)

- [x] V4-13 Animations everywhere: pages fade up, rows and cards arrive one after another, press/hover feedback, logo writes itself in, done items strike through; Settings > Appearance > Animations (Lively / Calm, per device); system reduce-motion respected — branch ready: night/v4-feedback
- [x] V4-14 Settings > Your data: where each kind of data is stored (host path and in-container path, Docker volume, database tables), sizes — branch ready: night/v4-feedback
- [x] V4-15 "Is Wavium safe to install?" chart next to Nextcloud, Proton, Google, Microsoft 365, in Settings > Your data and the README — branch ready: night/v4-feedback
- [x] V4-16 Mail status: "Where your mail goes" flow chart per address (important / everyday / hidden by Curated / spam / not sorted yet, then categories; click opens them) — branch ready: night/v4-feedback

### Daily use (goal 2026-11-20: "100 % operational")

- [x] V4-17 Accounts and sorting for daily use: "Add a mail account" in Mail; username follows the address (unknown providers); editing keeps passwords and Google sign-in; classification starts as soon as an AI is added; filed mail shows at once in its folder — branch ready: night/V4-17
- [x] V4-18 Rules for "all my accounts": one rule per account, folder matched by role or name; account shown per rule — branch ready: night/V4-18
- [x] V4-19 Current Claude models (Haiku 5.5 for triage, Sonnet 5.5 for the rest): no temperature, no forced tool choice, thinking blocks sent back in tool loops — branch ready: night/V4-19
- [x] V4-20 Fresh install with deploy/wavium/install.sh came up broken (umask 077 leaked into the build: code unreadable in the image); fixed and replayed on a fresh clone — branch ready: night/V4-20

### Version in the header, and a sweep for bugs (2026-11-23)

- [x] V4-21 The version next to the logo in the header, linking to a page that says what each version brought (Settings > What's new), with the history of every version — branch ready: night/V4-21
- [x] V4-22 Sweep for bugs a first-time user would hit: every app opened on desktop and phone, test suites green, what is found fixed with a test — branch ready: night/V4-21 (5 bugs fixed)

### Mail for daily use (2026-11-23)

- [x] V4-23 Mail: the Curated filter showed an empty Inbox on a freshly connected account (the label list never ran the initial sync); a filter that hides everything now says so and offers "See all mail"; the filter is remembered; account setup shows the real reason the mail server refused instead of "HTTP 400" — also: Favorites was always empty without a \Flagged folder; report: reports/V4-23.md — branch ready: night/V4-23

### Mail: tags, classification and daily use (2026-11-23, audit `docs/audit-2026-11-23.md`)

- [x] V4-25 The twice-daily mail brief was failing under cron (`claude` not on cron's PATH, rc=127) and nobody saw it, because `brief.md` kept the previous report: explicit PATH, binary checked before use, `brief.status` written on every pass — fixed outside the repo (`/home/oxygen/claude-mail/brief.sh`, not versioned); report: reports/V4-25.md
- [x] V4-27 Category `etudes` in the classifier, and the dead labels removed (school, finance, calendar, unknown): the three category lists (questions.json, the agent tools, the Mail chips) now have a test that fails when they drift apart; question set bumped to mail-v3 — report: reports/V4-27.md
- [ ] V4-26 Classification turns itself on as soon as an AI provider is added, and its state is visible to a non-admin user
- [ ] V4-24 Tags an agent can set: spam/promo/important/urgent/etudes derived from the classification, MCP tool `mail_message_tag` (action write, so approvals apply), IMAP keyword mirror, lock on mail the human corrected — deps: V4-26, V4-27
- [ ] V4-28 Classify the folders the user picks, not only Inbox and Spam; bounded catch-up of mail classified by an older questions version — deps: V4-26
- [ ] V4-29 Deterministic rules fired on mail arrival (no AI), `tag` action, per-domain exclusion list: replaces the external Python sorter — deps: V4-24
- [ ] V4-30 A human correction applies deterministically instead of being a prompt hint, and per domain as well as per address
- [ ] V4-31 `make up` on a half-finished dev install: a clear diagnosis instead of looping on `permission denied for table oc_migrations`; `make doctor` target
- [ ] V4-32 Agents read and filter tags (`mail_message_list`, `mail_message_get`)
- [ ] V4-33 Per-account setting: publish the 5 tags as IMAP keywords so a phone sees them — deps: V4-24
