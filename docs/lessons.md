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

## Working method

- Check that a new test really tests: break the code it covers and watch it fail.
- In zsh, unquoted `$VAR` is not word-split: run curl scripts with `bash -c`.
