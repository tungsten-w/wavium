# Atrium scoped app passwords

App passwords can carry scopes, stored in the token's scope JSON:

```json
{"filesystem": false, "atrium": {"v": 1, "scopes": ["mail:read", "mail:write"], "agent": true}}
```

Tokens without the `atrium` key are legacy tokens with full access.

- Grammar: `<area>:<action>`. `write` implies `read`; nothing else is implied.
  Humans may also hold `*` or `<area>:*`.
- Actions: `read`, `write`, `send`, `delete`, `share`. Anything outward-facing or
  destructive gets its own action, and a delayed delete counts as a delete.
- Agent tokens (`agent: true`):
  - never get `admin` or `security`;
  - never hold wildcards: every action is granted on its own, and a stored
    wildcard grants an agent nothing;
  - cannot create tokens.
- `security` covers app passwords, client login flows, 2FA, WebAuthn, sessions and
  wipe, and password and email changes. `account` is profile and settings only.

## Where it is enforced

| Layer | File |
| --- | --- |
| AppFramework routes | `lib/private/AppFramework/Middleware/Security/ScopeMiddleware.php` |
| Per-route scopes we own | `#[RequireScope(area, action)]` on the controller or method |
| Apps we do not own (NC Mail, Notes) | `RouteScopes.php` (static), `MailScopes.php` (depends on the request) |
| Routes with several meanings | `ScopeGuard::require()` / `requireForUser()` inside the controller |
| WebDAV, CalDAV, CardDAV | `apps/dav/lib/Connector/Sabre/ScopePlugin.php` |
| Token creation | `ScopeGuard::newTokenScope()` (occ `user:add-app-password --scope --agent`, settings API) |

A route without an attribute or override needs `<app area>:<action from the HTTP verb>`
(GET/HEAD/OPTIONS = read, DELETE = delete, else write). Admin routes always need
`admin:<action>` as well.

NC Mail: moves to Trash/Junk/Spam, `\Deleted` and `$junk` flags, emptying a folder and
changing the trash, junk or retention settings all need `mail:delete`, because Gmail
purges Trash and Spam after 30 days. Spam and ham reports need `mail:send`.

## Checks

- Unit tests: `tests/lib/Authentication/Scope/`,
  `tests/lib/AppFramework/Middleware/Security/ScopeMiddlewareTest.php`,
  `apps/dav/tests/unit/Connector/Sabre/ScopePluginTest.php`.
- Route audit: `build/atrium/scope-audit.php` fails on new routes that check admin in
  code, GET routes that seem to write, and new code that writes a token's scope or
  creates/rebuilds a token (each must keep the `atrium` key). Reviewed ones are listed
  in `scope-audit-reviewed.txt`.
- Token survival: `tests/lib/Authentication/Scope/ScopePreservationTest.php` (rotate,
  session renewal, password change, wipe, one-time to permanent, password-less login).
- Integration: `build/atrium/scope-integration.sh` against the test copy (never live). NC Mail
  cases run end to end against a local GreenMail server (moves, flags, empty folder, send).

## Known gaps

1. **REPORT on a mixed calendar collection.** A collection that holds both VEVENT and
   VTODO is treated as `calendar`, so a REPORT (calendar-query, multiget, sync) by a
   token with `calendar:read` but without `tasks:read` also returns its VTODOs. Writes
   are checked per object and are not affected.
   Planned fix: filter REPORT responses per component instead of requiring both areas.
   Drop the `<d:response>` entries whose calendar data holds a component the token
   may not read, for example in a Sabre `afterMethod:REPORT` hook or a calendar-query
   filter, so a calendar-only token still syncs mixed collections.
2. **Third-party apps** other than NC Mail and Notes fall back to the app id as the
   area and the HTTP verb as the action. Re-run the route audit after every app update.
