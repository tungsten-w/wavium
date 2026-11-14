# Changelog

Wavium (formerly Atrium) is a hard fork of Nextcloud 34.0.5. Versions are
tagged in git (`v1`, `v2`, ...).

## v4 (in progress)

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
