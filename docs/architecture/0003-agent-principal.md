# 0003: Agents are special user accounts owned by a user

Status: accepted (2026-11-01). Data model and manager in place; no UI or API yet.

## Decision

An agent is a real Atrium user account, flagged as an agent and owned by a human user.
The agent layer sits next to the user layer (`lib/private/Agent` beside
`lib/private/User`); it does not replace it.

Because an agent is a user, everything that works for users works for agents with no
special cases: it has a display name and avatar, shows up in activity ("done by
Nova"), can be shared with, mentioned, assigned tasks, and can log in with app
passwords. Nova already runs this way today as the user `nova`.

What makes it special:

- `atrium_agents` row: `uid`, `owner_uid`, `description`, `created_at`.
- It has an owner, the user who added it in Settings.
- It never gets admin rights or the `admin`/`security` scope areas, and never holds
  wildcard scopes (rules already enforced for agent tokens, see
  `lib/private/Authentication/Scope/README.md`).
- What it may do with other users' data comes only from grants ([0004](0004-agent-grants.md)).

## API

`OCP\Agent\IAgentManager`: `isAgent()`, `getAgent()`, `getAgentsOwnedBy()`,
`registerAgent()` (marks an existing account as an agent), `unregisterAgent()`.
Deleting the account removes the agent row and its grants; deleting the owner
unregisters their agents (the accounts stay, for the owner's admin to decide).

## Phase 3

Settings page "Agents" (create the account and register it in one step), agent-only
login restrictions, and the agent's view of what it was granted.
