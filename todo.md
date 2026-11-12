# Atrium todo

Order agreed with the user on 2026-11-01: groundwork, then modernization, then the agent
layer, then mail. Lessons: `docs/lessons.md`.

Legend: `[ ]` todo, `[~]` in progress, `[x]` done.

## Phase 0: move off ../nextcloud (done 2026-10-31)

- [x] Live runs `atrium:local` from `deploy/`
- [x] Data, `.env`, backups in `live/` (gitignored); Daily Todo in `apps/daily_todo` with history
- [x] Weekly backup repointed; `../nextcloud` trashed
- [x] Cron container gets internet (Gmail sync was failing)

## Phase 1: architecture groundwork (make the features implementable, do not build them)

User, 2026-11-01: agent foundations are low priority, just leave room so phase 3 knows where things go. Remaining toolchain/dev-container items are done at the start of phase 2, where they are needed.

- [x] `docs/architecture/`: layers overview + one decision record per topic (0001-0008)
  - [x] App modules: one self-contained dir per app (`appinfo/ lib/ web/ agent`), toggle/add/remove without touching core
  - [x] Agent principal: agents are special user accounts owned by a user, next to the user layer
  - [x] Agent grants: per user, per agent, per app area, read/write/both or full
  - [x] Agent tools: one definition per app, exposed as MCP and REST, full CRUD mandatory
  - [x] Events: push to agents (no polling)
  - [x] Frontend + server: React per app, Bun (baseline build: host has no AVX) in front of PHP-FPM
  - [x] Client compatibility contract (DAV, OCS, login flow URLs)
- [x] Public API `OCP\Agent`: agent, manager, grants, context, resource provider (CRUD), action provider
- [x] Core implementation `OC\Agent`: manager + grant store (DB tables, migration), tool registry
- [x] `IRegistrationContext::registerAgentResourceProvider()` / `registerAgentActionProvider()`
- [x] Unit tests for the registry, the CRUD tool naming/scopes and the stores
- [x] Toolchain in containers only (no host installs): Bun baseline image (`deploy/dev/bun.Dockerfile`, `atrium-bun:dev`) for frontend builds, PHP image for tests/lint/composer
- [x] Coupling audit: `build/atrium/coupling-audit.sh` (56 core files import apps)
- [x] Dev containers (`deploy/dev/`, php on 127.0.0.1:8092; bun profile `tools`): repo bind-mounted, PHP changes live, Bun watch for frontends, no rebuild per change
- [x] Verify on the test copy (migration runs, nothing else changes); live untouched (2026-11-01, with the `atrium:bun` image)

## Phase 2: modernization

- [x] Containers only: remove bare-metal paths (web installer -> env/occ in the image, server self-updater + `updatenotification`, Apache/`.htaccess` handling, `flake.nix` dev shell, other webserver configs) (2026-11-01; `deploy/removed-apps` lists apps dropped from the release)

- [x] Bun server: static frontend + FastCGI to PHP-FPM, every client URL kept (DAV, OCS, `.well-known`, login flow, `status.php`) (`server/`, route tests, 300 MB streamed upload/download verified)
- [x] Image variant: PHP-FPM + Bun instead of Apache (test copy first) (`atrium:bun` on atrium-test 2026-11-01; agent tables migrated there; live still on Apache `atrium:local` until switched)
- [x] Design system: Nextcloud / Material Expressive tokens and React components (`core/web/ui`: ui.css tokens from one seed colour, light/dark; components in index.tsx; 2026-11-01)
- [x] React shell: login, header/nav, app switching, settings frame, theming; discovers enabled apps by API (`core/web/shell`, `core/atrium/session`; Bun serves it for page loads; checked in the browser on the dev stack 2026-11-01)
- [x] Per-app frontend build: `apps/<id>/web` built with Bun; the central lists in `build/frontend*/` go away (React UIs: `apps/<id>/web/index.tsx` discovered by `build/atrium/web-build.ts`; classic Vue entries: `apps/<id>/web/legacy.json` discovered by `build/atrium/legacy-entries.cjs`, entry sets verified identical to the old lists; 2026-11-01)
- [x] Old Vue app bundles keep running inside the shell until ported (LegacyFrame iframe; Bun hides the classic header in frames; 2026-11-01)
- [x] JSON endpoints for data that pages get from PHP templates today (`GET /ocs/v2.php/core/atrium/settings/{personal|admin}/{section}` returns the initial state of any settings section; apps use their own JSON/DAV APIs, 2026-11-01)
- [~] Port apps one by one (Daily Todo, Contacts, Calendar, Tasks, Files, Settings done; Mail next)
  - [x] Daily Todo (`apps/daily_todo/web`, all views, checked in the browser on dev 2026-11-01)
  - [x] Contacts (`apps/contacts/web`, CardDAV, checked in the browser on dev 2026-11-01)
  - [x] Calendar (`apps/calendar/web`, CalDAV, checked in the browser on dev 2026-11-01; appointments/attendees/subscriptions not ported yet)
  - [x] Tasks (`apps/tasks/web`, VTODO over CalDAV, checked in the browser on dev 2026-11-01; recurring tasks, sort-order drag and sharing not ported yet)
  - [x] Files (`apps/files/web`, WebDAV + OCS shares, checked in the browser on dev 2026-11-01; versions, comments, tags, file requests, templates and external storage UI not ported yet)
  - [x] Settings (React: Profile, Security, Appearance, Sharing, Agents; admin Overview, Basic settings, Accounts, Apps, Sharing, Theming; checked in the browser on dev 2026-11-01. App-contributed sections (Availability, Flow, Presets, admin Security, External storage, Assistant, Groupware, Delegation) still run their classic Vue page in a frame)
  - [x] Mail (`apps/mail/web`, tested in the browser against greenmail on dev 2026-11-01; threads, contact autocomplete, HTML compose, tags, snooze, filters not ported yet)
  - [x] Shell header (user 2026-11-01): logo + global search (unified search) left, apps centered, account right; logo opens Dashboard; Dashboard out of the app list (done 2026-11-01)
  - [x] Chrome (buttons, nav, headers) not text-selectable (2026-11-01)
  - [x] Center content on wide screens (no empty right side): Calendar list view, every Settings page (user 2026-11-01) (done 2026-11-01)
  - [x] Two-factor settings in React (quick port, user does not use 2FA) (done 2026-11-01: backup codes + provider list/turn off; setup of other providers stays classic)
  - [x] Notes (still the classic page in a frame): React + material expressive, same shell header (user 2026-11-01; done 2026-11-01: `apps/notes` vendored 6.1.0, `apps/notes/web` with CodeMirror live-preview Markdown; at deploy trash live `custom_apps/notes`; tables still raw in the live editor)
  - [x] Activity (classic page with its own old header: the header icons differ there, e.g. Daily Todo shows a checkbox instead of the sunset). Port to React, show every app's activity incl. Daily Todo (agent, 2026-11-01; done 2026-11-01: `apps/activity` vendored 7.0.0 + `web/`; Daily Todo publishes completions, Notes publishes create/edit/delete; Mail still publishes nothing)
  - [x] Dashboard (React in `apps/dashboard/web`, done 2026-11-01; React port renders straight on the wallpaper, no white panel, user 2026-11-01)
  - [x] Settings sections ported to React (2026-11-01, `core/web/shell/settings/Extra.tsx`): personal Notifications, admin Activity, Groupware, Quick presets, admin Security (two-factor enforcement), Administration privileges (Assistant was removed earlier)
  - [ ] Settings sections still classic (framed): personal Availability (absence + working hours), Flow (personal + admin, workflow rule editor), admin External storage, Passkeys/WebAuthn tab in personal Security, Calendar/Contacts example-content toggles under Groupware, any section a future app adds
  - [x] Tabler icons (user 2026-11-01): every UI icon is a Tabler outline icon (`core/web/ui/tabler/`, aliases keep old names working, Settings section icons by id); app logos, favicon and server-supplied images unchanged
  - [ ] Goal (user, 2026-11-01): every frontend is React, no PHP-rendered UI left (login flow pages for clients stay compatible)
- [ ] Close the gaps in ported apps (user, 2026-11-01: problematic, must be done)
  - [ ] Calendar: appointments, attendees, subscriptions
  - [ ] Calendar: open classic event URLs `/apps/calendar/edit/<base64>` (global search results land on "New event" today)
  - [ ] Dashboard: JS-only widgets (tasks, daily_todo_calendar) and status widgets (weather) not shown yet
  - [x] Calendar: endless month view without a visible scrollbar, virtualized (render only the weeks near the viewport) (user 2026-11-01, done 2026-11-01)
  - [ ] Tasks: recurring tasks, sort-order drag, sharing
  - [ ] Files: versions, comments, tags, file requests, templates, external storage UI
  - [ ] Mail: threads, contact autocomplete in To, HTML compose, tags, snooze, unified inbox, filters/sieve, undo delete
- [ ] (low priority, user 2026-11-01) Decentralized app store (Settings > Apps): every app in the apps dir is installable; "install from git URL" clones into the apps dir and enables it; no apps.nextcloud.com (user vision 2026-11-01, see docs/lessons.md)
- [ ] Full browser pass in the browser on the test copy (`atrium:bun`, the image that goes live), every app and settings page
- [ ] Test real clients against the test copy (phone login flow, DAVx5/phone calendar + contacts sync); needs the user with a phone for the final check
- [x] Switch live (2026-11-01, build 3f37f025; rollback in docs/lessons.md): backup, `bash deploy/build.sh` (Bun image), up, trash `custom_apps/{contacts,calendar,tasks,mail}` duplicates
- [x] Live fixes after the switch (user reports, 2026-11-01): phone nav drawer closes (scrim tap without click-through, close button, Escape); unread counts no longer cover the folder ⋮ menus on touch; Mail first load fast (preview analysis without full fetch, 20 per page); "Could not load messages" 400 on never-synced folders fixed; live sync every 60 s + heartbeat, refresh asks only for changes

## Phase 3: agent layer

Plan of 2026-11-08 (the owner + the agent's own session): build the shared pieces once, mail is the first provider, then Daily Todo. Every app must end up MCP compatible. Contract: `docs/architecture/0009-agent-layer-mail-first.md` (accepted 2026-11-08).

- [ ] Settings > Agents > New agent creates the hidden user + connect box (URL, token, snippet); per-agent permission table (per app: read/write/delete/send/share, each off / allowed / needs approval), presets; wakes switch per agent, off by default
- [ ] Convert the existing `nova` user into the owner's agent (one-time admin step, keeps history)
- [ ] Generic approval queue: frozen + hashed payload, approve/reject in the UI, ntfy ping, events back to the agent, expiry 30 days (same as Trash)
- [ ] Event cursor `events.since()` (source of truth) + HMAC webhook doorbell (agent host on the LAN)
- [ ] Mail provider: search (date, account, folder, category/urgency/needs-action, from, subject, text, snippets), read, drafts, flags, archive; send/delete approval-gated
- [ ] Mail: classify on arrival (not every 5 min), `mail.received` only after classification (`schema: mail-v2`, `message_key`), alert instead of waking when classification fails
- [ ] Curated categories as a user setting; agent wakes reuse it
- [ ] Agent accounts in Settings: add an agent, grant per app read/write/both or full
- [ ] Grant enforcement (reuse the scope system: `ScopeGuard`, `ScopeMiddleware`, DAV `ScopePlugin`)
- [ ] MCP endpoint (Streamable HTTP) + REST, generated from the tool registry
- [ ] Full CRUD tools: Contacts, Calendar, Tasks, Daily Todo first, then Files, ...
- [ ] Events/webhooks to agents (calendar, tasks, Daily Todo, mail)
- [ ] Approvals for risky actions; activity feed with undo; per-item "done by agent X"
- [ ] Cross-app search tool
- [ ] Nova migration (7 pain points, see `docs/lessons.md`)

## Phase 4: mail

User, 2026-11-01: classification comes first, the mail agent part later. mailvault is never used; everything goes into Atrium Mail.
Non-negotiable: never delete mail; delete = move to Trash, kept there 30 days at least (`docs/lessons.md`).

- [x] Classification pipeline in Mail (decisions API via tollgate, gpt-6-luna): queue + results tables, TriageJob every 5 min, new mail first then backlog newest first, daily caps, pause/backoff, 10 categories (mail-v2: personal, work, admin, orders, security, social, newsletter, ads, spam, other) + urgency/needs reply/action/deadline/suspicious; chips in the message list (tested on dev 2026-11-01)
- [x] Mail Status page (`/apps/mail/status`): pipeline state, on/off switch (admin), spending vs caps, 14-day chart, categories, urgency, accounts, recent, problems, folders, background jobs (2026-11-01)
- [x] Per-mail classification state (waiting / done / gave up / not classified) in the reader, ⋮ › Reclassify (2026-11-01)
- [x] Deploy triage to live, token set, turned on (2026-11-01)
- [~] Classify ALL mail (14,299, measured ~€0.0002/mail, ~€2.8 total; 12 one-off workers running 2026-11-01; tollgate temporarily 150/month + caps €5, restore after)
- [ ] Archive everything older than 2 months, on Gmail and in Atrium (out of INBOX, stays in All Mail, nothing deleted)
- [x] Never-delete guarantee in code: no delete in Trash before 30 days there, no emptying Trash, no deleting folders that hold mail, auto-cleanup never under 30 days (2026-11-01)
- [ ] User checks everything works
- [~] Keep every message body in Atrium as our own copy (not a cache); never attachments, never remote images/tracking pixels. Table `mail_bodies` (mail 5.12.8) is live and fills as the classifier fetches (2026-11-01). Left: backfill the ~570 mails classified before it existed, store a body when the user opens a mail, folder-sync fetching of all bodies, search over stored bodies
- [x] Classifier input cleaned (links -> domain, no invisible filler/base64), hard 8000-char cap per mail (2026-11-01, hot-patched on live)
- [ ] Mail list loads older mail automatically on scroll (done on dev 2026-11-01, waits for the next deploy)
- [~] Filter by triage labels: chips for category and "needs action" over Inbox/Archive (`GET /api/triage/list`), done on dev 2026-11-01. Left: type `category:ads` in the search box, sort by urgency
- [~] Sidebar: merged Inbox + Archive across accounts, collapsible account sections with a settings gear, done on dev 2026-11-01. Left: mark-all-read for the merged Inbox, per-account folders inside collapsed groups check on phone
- [x] Mail body shown in a sandboxed iframe (mail CSS leaked into the app), composer overflow fixed, folder menu no longer covers the unread count, reader title smaller (dev 2026-11-01, waits for deploy; see docs/lessons.md)
- [x] Status page: "Gmail vs our copy" per folder (on server, in Atrium, body stored, classified) (dev 2026-11-01)
- [ ] ONE batched deploy (announce ~5 min downtime): infinite scroll, sidebar groups, label filters, iframe sandbox, composer and sidebar fixes. Do it after the backlog finishes
- [~] Sender address always shown in list rows and reader (scam check; user request 2026-11-01), done on dev, waits for the next deploy. Idea: warn when the display name and the address domain disagree
- [~] Curated filter on by default (hides ads, spam, newsletter, social; unclassified mail stays), Outbox moved under Archive, merged views refresh every minute; label queries match on the Message-ID hash, not db ids (dev 2026-11-01, next deploy)
- [ ] After the backlog: restore budgets (tollgate 30/month, caps 1.0 and 0.30), then archive older than 2026-09-01 (`archive.php`, tell the user first)
- [ ] Mail agent part (approval-gated send, tools for Nova), then Nova goes over all mail for anything to do
- [ ] Retire `services/mailvault` (never ran; `questions.json` / `classify.ts` were the reference)

## Mail UI wishes from the user, 2026-11-01 (done on dev unless noted, live at the next deploy)
- [x] Favorites view (all starred mail, both accounts) above Archive; Outbox under Archive; Curated filter default (hides ads/spam/newsletter/social)
- [x] Sender address always shown; mail body in a sandboxed iframe; account gear smaller
- [x] Drag the apps in the header to reorder them (per browser; localStorage `atrium-app-order`). Todo: store per user on the server so it follows them across devices
- [ ] Reorder the mail sidebar top entries and account sections too (user said only the app bar for now)
- [ ] Warn when the sender's display name and address domain disagree
- [x] Open draft button in the composer next to Save draft (dev 2026-11-01, picker works; loading the draft body could not be tested on dev, greenmail bug)
- [x] Status: "Our copy and the mail server" per account (with text / text missing / only in Atrium), dev 2026-11-01, next deploy
- [x] IMPORTANT (user, 2026-11-01, see docs/lessons.md): mails that vanish from Gmail must stay in Atrium. DONE on dev 2026-11-01 (0fd1b6bc, 0bbf81b5; docs/lessons.md), next deploy. Today ImapToDbSynchronizer/Cache delete `mail_messages` rows that vanished on the server (body survives in `mail_bodies`, the list row does not). Change: mark them "only in Atrium" instead of deleting, keep them listed, never auto-delete; then Atrium can be the master copy even if the Google data is wiped
- [ ] Fetch ALL bodies, not just Inbox/Spam: after the backlog, a fetcher for every folder (All Mail, Sent, ...) so the copy is complete
- [ ] DB FIRST, not as a fallback (user 2026-11-01): scrolling the list, opening a mail and flag/move actions must not need the mail server. Verified today: the list rows come from the DB, but IMAP/PreviewEnhancer::process fetches BODYSTRUCTURE from Gmail for every listed mail without a preview (only 3450 of 14488 are analyzed), opening a mail always fetches over IMAP (MessagesController::getBody), actions write straight to IMAP, the open folder syncs every 60 s. Plan: previews from stored text, reader from `mail_bodies` first (store sanitized HTML too), actions written to the DB at once with a retry queue to IMAP. Given to the Opus agent after the vanished-mails task
  - [x] Reader from mail_bodies (reader_body/reader_meta), list previews from stored text with no IMAP, body search on stored text, list not blocked during sync (dev 2026-11-01, 0fd1b6bc)
  - [ ] Flag/move/delete: write to the DB at once, queue + retry the IMAP write (today they still go to IMAP first and fail if it is down)
  - [ ] Backfill reader copies for bodies stored before mail 5.12.10 (their first open still hits IMAP once)
  - [ ] Attachments on demand / stored (downloads still need IMAP; kept mails show names only)

- [~] 2026-11-01 Reader-copy backfill running on live (scratchpad reader-backfill.php, one login per account, logs /tmp/rb1.log /tmp/rb2.log in nextcloud-app): fills mail_bodies.reader_body/meta for every live mail without one, so opening never waits on Gmail. Turn it into a proper background job in the app.

## Tomorrow (noted 2026-11-01)
- [ ] Reader-copy backfill (running as a script on live) -> real background job; check /tmp/rb1.log /tmp/rb2.log in nextcloud-app, watch for Gmail lockout.
- [ ] Classification backlog finish (~4,900 left at 22:10). Then restore budgets (tollgate MONTHLY_BUDGET_EUR=30, mail caps 1.0 / 0.30), then archive older than 2026-09-01 (`archive.php alice 2026-09-01 --go`, tell the user first).
- [ ] DB-first writes: flag/move/delete on server mails still go to IMAP first; need a DB-first write with a retry queue. Attachments are not stored.
- [ ] Tests for shipped mail code (idsByLabel, curated, body storage, category: search, merged views); web/React has none. See CLAUDE.md "Tests".
- [ ] Calendar subscription (iCal URL) events: verify in the live browser; endpoint is calendar/subscription/{uri}/events, hot-patched on live (not in the image until next build; commits 0605230c and later).
- [ ] Next deploy: the image now has everything except the calendar hot-fixes (already in repo).

## Done 2026-11-02
- [x] Daily Todo public status route + public_items column (migration 1005, app 1.5.1); see docs/lessons.md
- [x] Archive older than 2026-09-01 (7445 + 6383 mails, INBOX -> All Mail)
- [x] Reader-copy backfill finished (account 2: 5567 mails gone from Gmail, no reader copy possible)
- [x] Undid stock Mail 5.13.0 pulled by `occ upgrade` (docs/lessons.md); appstoreenabled=false
- [ ] Restore budgets once the 233 old pending triage items are decided: tollgate MONTHLY_BUDGET_EUR 150 -> 30 (and reset the month), mail caps 5/5 -> 1.0/0.30
- [ ] Check mail sync still works after the 2026-11-02 upgrade incident
- [ ] Restart/verify the six triage-worker2.php (silent since 09:29-12:33); then DB-first writes + mail tests
- [x] 2026-11-02 Budgets restored (tollgate 30 with the month's backfill rows cleared, mail caps 1.0/0.30); 233 old pending triage items left unclassified.
- [x] 2026-11-02 Mail tests for idsByLabel / reader copy / helpers (TriageServiceTest) and DB-first flag writes + retry queue (9f830c77). Not deployed: next image build creates mail_pending_ops (mail 5.12.11); announce the ~5 min downtime first.
- [ ] DB-first move/delete (needs a design: stand-in uid, no duplicate row on resync); tests for merged views and `category:` search; attachments on demand.
- [x] 2026-11-02 DB-first move/delete-to-Trash with retry queue (94b18e4b); attachments stored only when downloaded (cf9971c1); tests for label search + merged views (461b4c50). All committed, NONE deployed: next image build applies mail 5.12.14 migrations (mail_pending_ops, target_mailbox_id, mail_stored_attachments). Announce ~5 min downtime first; use the build path, not a manual `occ upgrade`.
- [x] 2026-11-02 Reader-copy backfill job + unavailable marking, attachment retention (90 days), status tiles for queued writes (35b01e30). 233 old pending triage items set to `skipped` on live.
- [x] 2026-11-02 17:30 UTC Live switched to atrium:c35124187400 (mail 5.12.15). Rollback image: atrium:f78d83971a54. Pre-deploy DB dump: session scratchpad pre-deploy-2026-11-02.dump (88 MB; copy it somewhere permanent if you want to keep it).
- [x] 2026-11-02 Reader lists the downloaded attachments of mail that left the server (copyJson + TriageService::storedAttachments).
