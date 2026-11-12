# 0004: Per user, per agent, per area grants

Status: accepted (2026-11-01). Data model and store in place; enforcement in phase 3.

## Decision

Every user can grant any agent access to their own data, from their Settings:

- full access, or
- per area (an app or a group of apps: `contacts`, `calendar`, `tasks`, `files`,
  `daily_todo`, `mail`, ...), with read, write or both, plus the extra actions an area
  defines (`delete`, `send`, `share`).

Grants use the scope grammar that already exists for app passwords
(`<area>:<action>`, `lib/private/Authentication/Scope/`), so one permission language
covers tokens and agents.

`atrium_agent_grants`: `agent_uid`, `grantor_uid`, `area`, `actions` (comma list),
`created_at`, unique per (agent, grantor, area).

- Full access is stored as area `*`. It is expanded when checked, to every area the
  grantor has, minus `admin` and `security`, so an agent still never holds a wildcard.
- `write` implies `read`, as for tokens. `delete`, `send` and `share` are never implied.

## API

`OCP\Agent\IAgentGrantManager`: `getGrantsForAgent()`, `getGrant()`, `setGrant()`,
`revokeGrant()`, `revokeAllForAgent()`, `revokeAllFromGrantor()`.

## Phase 3

Enforcement: when an agent acts on a grantor's data (DAV, OCS, agent tools), the
grant is checked through the same `ScopeGuard` / `ScopeMiddleware` / DAV
`ScopePlugin` path as scoped tokens.
