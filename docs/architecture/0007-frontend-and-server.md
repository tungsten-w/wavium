# 0007: React UIs, Bun server in front of PHP-FPM

Status: accepted (2026-11-01), phase 2.

## Decision

- Backend stays the Nextcloud PHP code and its APIs. New JSON endpoints get added where
  pages today receive data from PHP templates.
- Frontend: React only, no PHP-rendered pages. A core shell (login, header and nav,
  settings frame, theming) loads each enabled app's UI from `apps/<id>/web/dist`.
  Look: Nextcloud / Material Expressive, with our own components and design tokens.
- Bun replaces Apache: it serves the frontend and passes PHP requests to PHP-FPM over
  FastCGI. Bun builds the frontends too. Baseline build only (no AVX on the host).
- Old Vue app bundles keep working inside the shell until each app is ported.
- Every UI change is checked in a real browser through Bloom Web Link.

## What the Bun server must reproduce from Apache and `.htaccess`

Pretty URLs (`index.php` removal), `/.well-known/caldav|carddav|webfinger|nodeinfo`
redirects, `remote.php`, `public.php`, `ocs/v1.php`, `ocs/v2.php`, `status.php`,
`ocs-provider/`, security headers, blocked paths (`/data`, `/config`, `/lib`, ...),
large uploads and streaming downloads, and every URL in
[0008](0008-client-compatibility.md).
