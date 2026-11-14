# Atrium architecture

Atrium is a self-hosted hub for one household or team, used through the same
data by **humans** (a web GUI) and by **agents** (MCP and REST). It is a hard fork
of Nextcloud 34.0.5. Every Nextcloud client must keep working.

```
                 humans                                agents (Nova, Claude Code, ...)
                   |                                         |
          React shell + app UIs                     MCP  /  REST  (same tools)
                   |                                         |
   +---------------+-----------------------------------------+---------------+
   |  Bun server (static UI, routing)  ->  PHP-FPM (Nextcloud backend, APIs)  |
   |                                                                          |
   |  core:  users  |  agents (next to users)  |  grants/scopes  |  events    |
   |  apps:  apps/<id>/  one self-contained directory per app                 |
   +--------------------------------------------------------------------------+
                   |                                         |
        DAV, OCS, login flow (unchanged)            Nextcloud clients (phone, desktop, DAVx5)
```

Runs only as containers (`deploy/`). There is no bare-metal install.

## Decisions

| # | Topic | Status |
| --- | --- | --- |
| [0001](0001-containers-only.md) | Containers are the only supported deployment | accepted |
| [0002](0002-app-modules.md) | One self-contained directory per app | accepted, groundwork in place |
| [0003](0003-agent-principal.md) | Agents are special user accounts owned by a user | accepted, data model in place |
| [0004](0004-agent-grants.md) | Per user, per agent, per area grants | accepted, data model in place |
| [0005](0005-agent-tools.md) | One tool definition per app, MCP and REST, full CRUD | accepted, contracts in place |
| [0006](0006-events.md) | Push events to agents | accepted; built for mail (event log + cursor + signed doorbell, `server/agent/events.ts`) |
| [0007](0007-frontend-and-server.md) | React UIs, Bun server in front of PHP-FPM | accepted; built (`server/`, `core/web/`, `apps/*/web/`), in production since 2026-11-01 |
| [0008](0008-client-compatibility.md) | What clients use and must keep working | accepted |
| [0009](0009-agent-layer-mail-first.md) | Agent layer first slice: agents, approvals, events, mail tools | accepted (2026-11-08); built in TypeScript (`server/agent/`), in production since 2026-11-08 |
| [0010](0010-messages-google-bridge.md) | Messages app linked to Google Messages (SMS, RCS) through a libgm sidecar | proposed (2026-11-14) |

The phase checklist is `todo.md` at the repo root.

## Where things live

| What | Where |
| --- | --- |
| Agent public API (for apps) | `lib/public/Agent/` (`OCP\Agent`) |
| Agent core implementation | `lib/private/Agent/` (`OC\Agent`) |
| Agent tables | `core/Migrations/Version34000Date20261101000000.php` (`atrium_agents`, `atrium_agent_grants`) |
| Scopes (token permissions) | `lib/private/Authentication/Scope/` (see its README) |
| Apps | `apps/<id>/` |
| Deployment | `deploy/` (see its README) |
| Atrium-only checks | `build/atrium/` |
| Bun web server | `server/` (`index.ts`, `routes.ts`, `php.ts`, `fastcgi.ts`) |
| Agent layer (MCP, REST, approvals, events) | `server/agent/`; its tables `atrium_agent_*` are created by the Bun server (`server/agent/schema.ts`) |
| React shell and design system | `core/web/` |
| Dev stack | `compose.yaml` + `Makefile` at the root, scripts in `deploy/dev/` |
