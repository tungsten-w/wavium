# 0005: One tool definition per app, exposed as MCP and REST, full CRUD

Status: accepted (2026-11-01). Contracts and registry in place; transports in phase 3.

## Decision

Each app describes what agents can do with it once, in PHP, in its own directory.
Core turns that into tools and serves them two ways:

- **MCP** (Streamable HTTP) for agents: Nova, Claude Code, Hermes, OpenClaw.
- **REST + OpenAPI** for scripts and anything that is not an LLM.

Same tools, same permissions, two front doors. Disabling an app removes its tools.

Raw DAV and OCS stay for clients, but they are too low level for agents (adding a
contact over CardDAV means writing a vCard). Tools are shaped for agents:
`contacts.contact.create({name, email, phone})`.

## Full CRUD is mandatory

A resource is exposed through `OCP\Agent\Tool\IAgentResourceProvider`, which has
`list`, `get`, `create`, `update` and `delete`. An app cannot expose a resource
without all five. Each becomes a tool:

| Operation | Tool name | Scope needed |
| --- | --- | --- |
| list | `<app>.<resource>.list` | `<area>:read` |
| get | `<app>.<resource>.get` | `<area>:read` |
| create | `<app>.<resource>.create` | `<area>:write` |
| update | `<app>.<resource>.update` | `<area>:write` |
| delete | `<app>.<resource>.delete` | `<area>:delete` |

Things that are not CRUD (send a mail, move a task to tomorrow) are actions,
`OCP\Agent\Tool\IAgentActionProvider`: tool `<app>.<action>`, scope `<area>:<action>`
as the provider declares (`mail:send`).

Every call runs with an `OCP\Agent\IAgentContext`: which agent, on whose data
(the grantor), so providers act as that user and activity records the agent.

## Registration

In the app's `Application::register()`:

```php
$context->registerAgentResourceProvider(ContactResourceProvider::class);
$context->registerAgentActionProvider(SendMailAction::class);
```

`OC\Agent\Tool\ToolRegistry` collects the providers of enabled apps and builds the
tool list (names, JSON input schemas, required scope). Invalid or duplicate providers
are skipped and logged.

## Phase 3

MCP endpoint and REST controller on top of the registry, grant checks before every
call ([0004](0004-agent-grants.md)), first providers for Contacts, Calendar, Tasks and
Daily Todo.
