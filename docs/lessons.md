# Lessons learned (2026-10-31 → 2026-11-08)

Summary of the technical lessons from the original working notes of the Atrium
sessions. The notes themselves (with their personal and incident details) are
not part of this repository.

## Non-negotiable rules

- **Never delete mail.** Delete = move to Trash; a mail stays in Trash at least
  30 days (`MailManager::MIN_TRASH_DAYS`). "Empty Trash" and deleting a folder
  that still holds mail are refused. An expunge from Trash (user after 30 days,
  `TrashRetentionJob`, or the provider's own purge) only removes the *server*
  copy: Atrium keeps its row, flagged "Only in Atrium".
- **Atrium's database is the source of truth**, the mail server is a source
  and a mirror. Every mail's headers and text body live in `mail_bodies`, keyed
  by (account, md5(Message-ID)). Reads (list, reader, search) are DB first.
- **Client compatibility** (ADR 0008): DAV, OCS, login flow v1/v2, OAuth2 and
  public share links must keep working for the stock Nextcloud clients.

## Mail

- *Kept mails*: a row whose mail vanished from the server has `server_gone_at`
  set and `uid = -id` (never collides with a real UID, never sent to IMAP).
  When UIDs vanish, a row is a duplicate (a move/archive) if another row of the
  same account has that Message-ID; otherwise it is the last copy and is kept.
  Trash and `\All` are synced first so moves are known before INBOX copies vanish.
- *DB-first writes*: flag, move and move-to-Trash write the DB at once and queue
  the IMAP side in `mail_pending_ops` **only on connection-type errors** (not bad
  logins, not refusals). Backoff 1, 2, 4 … min (max 1 h), `failed` after 8 tries.
  A queued move uses a stand-in row (`uid = -id`) replaced when the real row syncs.
- *Gmail login lockout* ("Too many auth attempts"): many parallel IMAP logins
  (12–24 workers, or 16 restarted at once) lock **all** accounts, including
  Atrium's own sync. Rule: **one connection per account per run**, few logins,
  staggered (≈ 20 s apart), never restart all workers together.
- *Classification (triage)*: schema `mail-v2`, 10 categories (personal, work,
  admin, orders, security, social, newsletter, ads, spam, other) + urgency,
  needs-reply, needs-action, deadline, suspicious. Keep the set small.
  ≈ 2 100 tokens / mail, ≈ €0.0002 / mail after input cleanup (links → domain,
  invisible chars and base64 runs dropped: long newsletters ≈ 3× smaller).
  Caps: €1/day total, €0.30/day backlog. Pauses: 402 → until midnight, 401 → 1 h,
  5xx → backoff; IMAP fetch retried, parked after 5 failures.
  The LLM call (~2–15 s) is the bottleneck; ~10–12 parallel calls is the sweet spot.
  Better design: fetchers store bodies (few IMAP logins), classifiers work only
  on stored bodies (no mail server traffic).
- *Merged-view polling bug*: calling `/mailboxes/N/sync` with `ids=[]` makes the
  server treat the whole mailbox as new (huge CPU, 70 s calls). Sync-only callers
  send `ids=[0]`.
- Attachments are stored only when someone downloads them (90-day retention).
- Mail bodies are shown in a **sandboxed iframe** (mail CSS leaked into the app).
- `occ upgrade` upgrades *every* app and may pull stock apps from the app store
  into `custom_apps/`, shadowing Atrium's forks. `appstoreenabled=false` is set;
  before an upgrade check `occ app:update --showonly`. Upgrade leaves
  maintenance mode on.
- After an app version bump in `info.xml`, every request returns 503 until
  `occ upgrade` runs (dev too).

## GreenMail (fake mail server for dev/test)

- Users `test1`/`test2@atrium.test`, password `test-only`, IMAP 3143 / SMTP 3025,
  no TLS. Mail needs `allow_local_remote_servers=true` to accept a local host.
- Starts with only INBOX: create Sent/Drafts/Trash, or sending fails.
- Bug: single-part messages fail on `BODY.PEEK[1]` (ClassCastException) → seed
  test mail as **multipart**.

## Bun server / infra

- Hosts without AVX (Celeron N5105, Pentium G4400…): stock Bun dies with SIGILL
  (exit 132). Use the `bun-linux-x64-baseline` build everywhere.
- Bun talks FastCGI to PHP-FPM itself; frames get CSS injected with
  HTMLRewriter, and `Accept-Encoding` is dropped for frames because PHP gzips.
- Routes are cached in php-fpm's APCu (not shared with `occ`, the CLI):
  new/removed app routes 404/500 until APCu is cleared (a FastCGI request that
  runs `apcu_clear_cache()`), or php-fpm restarts.
- Spinning disks: I/O, not CPU, is the bottleneck. Avoid recursive greps over
  data and image builds while the site is under load.
- A production deploy costs **≈ 7 minutes** of downtime on that hardware (build
  separate, 10–15 min). Batch fixes, test on dev, announce deploys.
- The dev web container must run as the repo owner (`config.php` is 0640).

## React front end

- `bun build/atrium/web-build.ts [--watch|<app>]` builds `core/web/dist` and
  every `apps/<id>/web/dist` (gitignored). Icons added to `@atrium/ui` need a
  full build (the shell bundle carries the UI kit).
- Build dev bundles **without** `NODE_ENV=development` (the import map has no
  `jsx-dev-runtime`).
- Files: uploads > 10 MB use Nextcloud chunking v2 (MKCOL + numbered PUTs + MOVE
  `.file`). Trash restore (MOVE to `/trashbin/<user>/restore/<name>`) needs
  `Overwrite: T` (F → 412).
- Calendar: one `calendar-query` with `<c:expand>` per calendar; the server
  expands recurrences. Editing "all events" must shift EXDATE/RECURRENCE-ID too.
- Login must send `rememberme`, or sessions die with the browser / after 24 h.
- Settings: `GET /ocs/v2.php/core/atrium/settings/{personal|admin}/{section}`
  returns any section's initial state, so new React sections need no new PHP.

## Agent layer

- Written in TypeScript (`server/agent/`); PHP only for auth lookup, account and
  token operations, mail operations and emitting events.
- Bun → PHP internal calls carry `X-Atrium-Internal` (HMAC of the instance
  secret); Bun strips it from outside requests.
- Tool names use underscores (`mail_message_list`): OpenAI function names forbid dots.
- `mail_message_get` must fetch the reader copy when `reader_meta` is null
  (the classifier stores only a text body).
- Left-out actions in an access preset default to `approval`: set `off` explicitly.
- Pain points of an agent using stock Nextcloud (what the layer fixes):
  delegated calendars not discoverable; 5-min polling + local copies conflict
  with UI edits; no push events; Daily Todo future days and sharing set by
  hand; one unscoped full-access password; no per-item "done by agent X";
  shell wrappers instead of one MCP server.

## Dev stack and tests (2026-11-13)

- **Never run Nextcloud PHPUnit tests on an instance whose data you want.**
  `tests/lib/TestCase::tearDownAfterClass` deletes everything in the data
  directory and empties `filecache`, `storages` and `shares`. `make test-php`
  runs on its own instance (`deploy/dev/test-instance.sh`: `config-autotest/`,
  `data-autotest/`, DB `atrium_test`). Found when an e2e test saw an empty Files.
- `docker compose down -v` deletes the DB volume but leaves `config/config.php`
  ("installed") and `data/` in the checkout: `init.sh` now detects it and
  reinstalls (old files kept in `data.stale.<time>/`). Prefer `make reset`.
- Unit tests written against SQLite may bind PHP `false` for booleans; on
  PostgreSQL that becomes `''` and fails. Use SQL `true`/`false` literals or
  typed parameters.
- Bun's SQLite binds `$1..$n` in the order they first appear in the query, not
  by number: `UPDATE ... SET a = $2 ... WHERE id = $1` silently updates nothing.
  Number placeholders in order of appearance (PostgreSQL does not care).
- PHP changes in the dev stack can take up to 60 s to show: the Nextcloud
  image sets `opcache.revalidate_freq=60`. Restart `php` (or wait) before
  concluding a fix did not work.
- Internal (Bun → PHP) calls have no session user. Services that read it
  (Notes' TagService, activity attribution) need
  `IUserSession::setVolatileActiveUser($user)` for the call, and must be
  resolved after it (not injected into the controller).
- Apps shipped with the server (files, dav, ...) load classes from a frozen
  Composer classmap (`apps/<app>/composer/composer/autoload_{classmap,static}.php`):
  a new class must be added there by hand. A route to a missing controller
  makes **every** request 500, not just that route.
- One dev stack per checkout: `config/` and `data/` are bind-mounted from the
  working tree, so a second stack (another COMPOSE_PROJECT_NAME) started from
  the same directory installs over the first one's `config.php`, and the
  first then answers 500. For a second stack (e2e, backup test), use another
  worktree.
- Agent layer SQL: on sqlite, `$1`, `$2` are *named* parameters numbered by
  first appearance, so `SET x = $2 WHERE uid = $1` with `[uid, x]` swaps them
  (Postgres is fine). Write placeholders in order of the params array.
- Test UI changes in a real browser too: a unit-test fixture with the wrong
  shape (the agent `restUrl`) hid a bug that a Playwright run found at once.

## Working method

- Check that a new test really tests: break the code it covers and watch it fail.
- In zsh, unquoted `$VAR` is not word-split: run curl scripts with `bash -c`.

## DOM tests cannot read CalDAV listings (happy-dom) — 2026-11-13 (P4-2, P4-3)

happy-dom's `DOMParser` ignores XML namespaces: `parseMultistatus` returns
nothing, so a component that lists calendars or task lists over PROPFIND
shows nothing in a DOM test, and `vi.mock` of the module did not take under
the Bun runner. What works: give components their lists as props in tests,
parse fixed DAV structures as text where it is simple (`oc:invite`), and
check the full route in a real browser (Playwright on the task's stack).

## Two quick edits of one CalDAV object overwrite each other — 2026-11-13 (P4-3)

Each edit PUTs the whole object with If-Match. Two edits sent before the
first answer (a due date, then the repeat) both start from the same old copy:
the second wins and drops the first. Queue the edits per object and apply
each to the version the previous one saved (`apps/tasks/web/index.tsx`).
A browser test that fills two fields in a row catches it; the DOM test did not.
