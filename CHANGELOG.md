# Changelog

Wavium (formerly Atrium) is a hard fork of Nextcloud 34.0.5. Versions are
tagged in git (`v1`, `v2`, ...).

## v4.3

- **Mail: "Run now".** Classification used to start only on its own schedule,
  up to five minutes after you turned it on, picked a folder or added an AI
  key -- so every one of those looked like nothing had happened. The button
  next to the Classification switch runs it immediately and says what came of
  it: how many mails were classified, how many are queued, or why nothing
  happened. One press also clears a backoff pause: a pause exists to stop the
  schedule hammering an AI that keeps failing, and a person pressing once is
  not hammering.
- **Fixed: tags were painted white on white.** A tag Wavium discovered on the
  mail server carried no colour, and the column it is stored in defaults to
  white -- so 668 of the 676 tagged mails showed a white chip on a white
  background, a tag you could not see. Every tag now gets a colour, the ones
  already stored included, and the two tags an agent can set that had no
  colour of their own (spam, promotion) got one.
- **Agents can tag mail.** An agent could read the classifier's answer and
  star a mail; that was its whole write access. It can now set and remove the
  five tags, which is what sorting mail actually needs.
- **Fixed: classification could never reach the AI.** On both production
  stacks the queue failed on every mail with "cURL error 7: Failed to connect
  to 127.0.0.1 port 80" -- the classifier asked the web server for its own AI
  settings over a loopback address that answers nothing inside a container.
  3401 mails had been waiting.
- **Classification turns itself on when an AI provider is added**, instead of
  staying off behind a switch only an admin ever sees. Everything built on it
  -- Curated, the category chips, "Needs action", "Why is this mail here?" --
  was dead with it.
- **You choose which folders are classified**, per account. The pipeline only
  ever looked at Inbox and Spam. Changing the question set also re-asks about
  mail already classified, instead of leaving an account's history on the old
  questions forever.
- **A category for school and university** (`etudes`): a timetable, an exam
  result and a tax notice used to come out as the same thing. The four labels
  that no mail could ever carry -- school, finance, calendar, unknown -- are
  gone from the interface.
- **Fixed: the twice-daily mail brief failed silently under cron.** It died
  with "failed to run command 'claude'" and left the previous brief in place,
  so there was nothing to notice.
- Build: a release build no longer leaves a 478 MB copy of the repository
  inside the repository, which had been making the test suite run twice
  against a half-stripped tree.

## v4.2

- **Fixed: a mail account you had just connected looked empty.** Mail listed
  nothing with the default "Curated" filter -- "This folder is empty" -- while
  "All" showed every message. The two lists ask for mail differently: the plain
  one answers "this folder has not been copied here yet", which starts the first
  sync, and the filtered one simply found nothing and said so. Nothing ever
  started that sync, so Curated stayed empty until the next scheduled one.
- **A filter that hides everything now says so**, names the filter and offers
  "See all mail", instead of looking exactly like an empty folder.
- **The filter you pick is remembered** (per device), so Mail opens where you
  left it instead of always on Curated.
- **Fixed: Favorites was always empty.** Gmail has a "Starred" folder to list;
  Orange, Free, SFR, iCloud and most IMAP servers have none, so the page had
  nothing to show. It now lists everything you starred, whichever folder it is
  in, and says "No favorites yet" when there is nothing rather than reading as
  an empty folder.
- **Fixed: adding a mail account failed with "HTTP 400" and no reason.** The
  mail server's answer -- wrong password, server unreachable, wrong port -- was
  thrown away before it reached you. It now says which server refused and what
  it said. App passwords (Gmail, iCloud, Yahoo, Outlook) are also accepted with
  the spaces those providers print them with.
- **Agents could not see mail that had not been classified yet.** On an
  instance with no AI set up, `mail.list` with the Curated filter matched
  nothing at all. Mail with no category counts as shown, like in the interface.
- Tests: Mail is now walked end to end by a browser test -- connecting an
  account, reading, starring, every folder, sending a message to yourself,
  search, archiving -- and the demo instance has someone with mail waiting on
  the server and no account yet, which is the state this version is about.

## v4.1

- **The version is written next to the logo** in the header. Click it to see
  what each version brought (Settings > What's new), the newest first, with the
  one you are running marked.
- **Fixed: Notes dropped letters while you typed.** Typing at a normal pace in a
  note lost characters -- "Courses" was saved as "Couses" -- because the editor
  was being overwritten with a copy of the text that predated the last
  keystrokes. Nothing was lost on the server: what you type is now what is
  saved, letter for letter.
- **Fixed: changing the accent colour failed on a new account.** Every new
  account is given a random accent colour, and the first time the person chose
  their own in Settings > Appearance, the request answered "Internal server
  error" and the colour did not change. Accounts already in that state repair
  themselves at the next change.
- **Fixed: choosing a colour and then a wallpaper failed.** Settings >
  Appearance answered "Internal server error" on every wallpaper change once
  the accent colour had been changed, and kept doing it. (Both halves of
  Wavium wrote the same setting with a different declared type, which
  Nextcloud refuses.)
- **Fixed: a fresh install logged an error on every classic page** for a file
  the image did not carry (`core/js/mimetypelist.js`, generated and therefore
  not in the repository). Installs made before this version can also get it
  with `occ maintenance:mimetype:update-js`.
- **Fixed: a mail account added with a command had no tags**, so every sync
  logged an error and never marked anything important. Adding an account in
  the interface always worked; existing accounts can be repaired with
  `occ mail:account:add-missing-tags`.
- Tests: the Messages browser test was reading the page before it had finished
  loading, so it skipped the very flow it checks. The demo instance now has an
  account with nothing in it, and the
  browser tests walk every app with it, on desktop and on a phone -- the
  screens a new person sees first were never opened by a test before. The
  browser used to die mid-run on a small machine; it no longer does.

## v4

- **Messages: your phone's texts in Wavium** (ADR 0010). Link your Android
  phone with a QR code (or your Google account) and read, search and answer
  SMS and RCS. Wavium keeps a copy of every text, even those deleted on the
  phone; names come from Contacts; "phone offline" is said plainly. Agents
  can read texts, and every text they write waits for your OK; one-time
  codes stay hidden from them unless you allow one. Texts are in the header
  search, and the morning digest says which ones wait for a reply. The link
  runs in a small Go service (`services/gmessages`, libgm pinned): on with
  `docker compose --profile messages up -d`; the dev stack runs a fake phone,
  the public demo made-up conversations.
- **Mail: "Why is this mail here?"** in plain words under each mail, and
  **Wrong?** to fix it: the mail moves at once, and the next mails from that
  sender are sorted the way you said.
- **Agents**: a **Test** button for the doorbell (webhook); each token shows
  when and from where it was last used, and revokes in one click; **quiet
  hours** (no doorbell and no ping at night unless urgent, what waits is in
  the morning digest).
- **Demo polish**: a too-big file is refused before uploading (Files, Mail
  attachments); the demo AI answers in your language; the Dashboard's
  "Important mail" shows what the classifier calls important.
- **More motion**: moving between apps slides the page, the light/dark
  switch grows as a circle from your click, buttons ripple, notifications
  arrive on a spring (all off with Calm or reduce-motion).
- **Security check**: fixed a stored XSS in the note preview (a link in an
  image's description could add script); stricter cleaning of pasted mail
  HTML; the web server no longer serves UI sources, `services/` or
  `reports/`; Permissions-Policy everywhere, CSP and COOP on the app page;
  test tooling updated (no known vulnerable package left).
- **Installing**: a fresh install now works on **arm64** (a Raspberry Pi, an
  Apple Silicon Mac, an ARM server) — the build took the x86-only Bun — and on a
  **local network**, where there is no public name for Let's Encrypt to certify:
  `WAVIUM_TLS_ISSUER=internal` serves Caddy's own certificate, an IP address
  works (a browser sends no name for one, which used to fail the handshake), and
  alternate ports keep their port in every redirect. An app that a new version
  adds (Messages here) is now switched on by an update too, not only by a fresh
  install.
- Tests: browser tests open every app (desktop and phone) with a screenshot
  each, in CI.

From friends' feedback on the v3 demo:

- **It moves now**: pages fade up, lists and cards arrive one after the
  other, buttons react to the press, the logo writes itself in on the login
  page, done tasks strike through. Settings > Appearance > Animations: Lively
  or Calm (per device); the system's reduce-motion setting is respected.
- **Settings > Your data**: where each kind of your data is stored on the
  machine (files, versions, trash, database and its tables, Docker volumes),
  with sizes and a copy button. Hidden host paths in the public demo.
- **Is it safe to install?** A yes / partly / no chart of Wavium next to
  Nextcloud, Proton, Google and Microsoft 365, in the app and the README.
- **Mail > Status > Where your mail goes**: per address, threads that split
  into important, everyday, hidden by Curated, spam and not sorted yet, then
  into categories. Hover for numbers, click a category to open it.
- Fix: the Theme previews in Settings > Appearance were empty.

## v3

- **Public demo mode** (`ATRIUM_PUBLIC_DEMO=1`, `deploy/demo/`): anyone can
  try Wavium with shared accounts and fake data.
  - Login page: "Log in as Alice / Bob" in one click.
  - A banner says it is a demo, when it resets, and links to **Give
    feedback** (GitHub issue forms); also in the account menu.
  - Locked for strangers: passwords, accounts, mail servers, 2FA, share
    links, federation, external storage, personal AI providers, webhooks,
    local network access; quotas.
  - `deploy/demo/setup.sh`: one command to start, reset, or install the
    nightly reset.
- `ATRIUM_BIND`: publish the dev stack on a VPN address for a reverse proxy.

## v2.1

- **Logo everywhere**, drawn inline so it can never be a broken image (login,
  header, boot screen, agent consent page).
- **Leave Google easily**:
  - known mail providers fill in their servers;
  - Sign in with Google for Gmail (admin page to set it up);
  - Settings > Move from Google for Gmail, Calendar (subscribe or import
    .ics), Contacts (.vcf) and Drive.
- **Settings > Tutorial**: an illustrated nine-step tour.
- **One-command install**: `bash deploy/wavium/install.sh`.

## v2

- **Name and logo**: Wavium everywhere a person sees it (login, header, tab,
  app icon); code identifiers keep `atrium`.
- **Mail**: tags, HTML compose, undo delete, contact autocomplete,
  conversation view, snooze.
- **Calendar**: attendees and answers to invitations, subscriptions,
  appointment pages, classic event URLs.
- **Tasks**: repeating tasks, manual order, list sharing.
- **Agents**: several agents per user with an activity page, OAuth 2.1 for
  MCP (custom connector on claude.ai), built-in assistant panel.
- **Install**: `deploy/wavium/`, a generic install with automatic HTTPS
  (Caddy), with backup and restore.
- A demo instance with fake data and a keyword-based demo AI
  (`deploy/dev/demo.sh`).

## v1

- React UI served by Bun in place of Apache; the agent layer (MCP + REST,
  permissions, approvals, events) with tools for Mail, Calendar, Tasks,
  Contacts, Files, Notes, Activity and Daily Todo, plus cross-app search and
  undo.
- AI provider layer (Anthropic, OpenAI, Mistral, OpenAI-compatible, Ollama),
  Settings > AI, budgets, a model per task.
- Mail organiser:
  - classification on the AI of your choice;
  - morning digest;
  - AI reply drafts (never sent without a click);
  - filing rules in plain language;
  - scam detection;
  - assisted unsubscribe;
  - mail → calendar / tasks.
- Mail is never deleted; Wavium keeps its own copy.
