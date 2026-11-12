# 0002: One self-contained directory per app

Status: accepted (2026-11-01). Backend contract in place; frontend part lands in phase 2.

## Decision

An app is its directory. Everything the app needs lives in `apps/<id>/`, and adding,
removing or toggling an app never requires editing core files or core build config.

```
apps/<id>/
  appinfo/info.xml    manifest in Nextcloud's format: id, version, namespace,
                      <dependencies> (including other apps), navigation, <scopes>
  appinfo/routes.php  API routes (OCS/JSON); no PHP-rendered pages once ported
  lib/                PHP backend (OCA\<Namespace>\), own composer autoloader
  lib/Agent/          the app's agent tools (resource and action providers, 0005)
  web/                the app's React UI: package.json, src/, built with Bun to web/dist
  l10n/ img/ tests/ openapi.json
```

- Add: put the directory in place, `occ app:enable <id>`.
- Remove: `occ app:disable <id>`, then `trash put apps/<id>`.
- Toggle: `occ app:enable|disable <id>`. Its UI, routes, scopes and agent tools appear
  and disappear with it.

## How it works today (2026-11-01)

- Backend: already per app (manifest, routes, `lib/`, autoloader), toggled at runtime.
- Frontend: not per app. Build entries are listed centrally in
  `build/frontend/vite.config.ts` and `build/frontend-legacy/webpack.modules.cjs`, and
  everything is emitted into one shared `dist/`. Phase 2 replaces this with `apps/<id>/web`.
- Pages: rendered by PHP (`TemplateResponse` in 61 files, `Util::addScript` 77 times).
- Coupling: core imports app classes (`build/atrium/coupling-audit.sh` lists them) and
  apps import each other. Those imports are the decoupling work list.
- `core/shipped.json` `alwaysEnabled` lists 14 apps that cannot be disabled.
- Apps come from three places: `apps/` in the repo, the release tarball (added by
  `deploy/Dockerfile`), and app-store installs in the live volume's `custom_apps/`
  (calendar, contacts, mail, notes, tasks, ...).

## Rules for new code

1. Core never imports `OCA\...`. Apps use `OCP` interfaces and events, and other apps
   only through a declared dependency.
2. An app registers its extension points in its `Application::register()` through
   `IRegistrationContext` (scopes in `info.xml`, agent tools via
   `registerAgentResourceProvider()` / `registerAgentActionProvider()`).
3. Shrink `alwaysEnabled` to what is really core.
4. Open question: bring the app-store apps we use into `apps/` (one place, but we own
   their updates) or keep `custom_apps/` with the same layout rules.
