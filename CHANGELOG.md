# Changelog

Wavium (formerly Atrium) is a hard fork of Nextcloud 34.0.5. Versions are
tagged in git (`v1`, `v2`, ...).

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
