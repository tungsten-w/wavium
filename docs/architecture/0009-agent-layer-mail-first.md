# 0009: Agent layer, first slice: agents, approvals, events, mail tools

Status: accepted (2026-11-08, signed off by the owner). Not built yet.
Agreed in planning between the owner, the Atrium session (Atrium host) and the session
that maintains Nova (agent host). Builds on [0003](0003-agent-principal.md),
[0004](0004-agent-grants.md), [0005](0005-agent-tools.md), [0006](0006-events.md).

## Order

1. Shared pieces, built once: agent creation in Settings, grant enforcement,
   MCP + REST endpoint, approval queue, event log with cursor and webhook doorbell.
2. Mail, the first provider.
3. Daily Todo, then Calendar + Tasks (subscriptions included), Contacts, Files,
   Notes, Activity, Settings/Dashboard, then cross-app search. Every app must end up
   with agent tools and events; an app is not finished without them.

## 1. Agents and permissions

- Settings > Agents > New agent: name, avatar, description, permissions. Atrium
  creates the user account behind it (ADR 0003), owned by the creator. The account
  has no web login, no admin rights, and is not listed in Accounts.
- Permissions per agent, one row per app (area), one cell per action
  (`read`, `write`, `delete`, `send`, `share`), each cell `off`, `allowed` or
  `approval`. `write` implies `read`. `delete`, `send` and `share` default to
  `approval`. Presets: Mail only, Todo only, Everything (with approvals), custom.
  Stored in `atrium_agent_grants` (`actions` gains a mode per action).
- An agent sees only the tools of the areas it has at least `read` on.
- Wakes: a per-agent switch, **off by default** (most agents are not running all
  the time). See section 4.

### The agent's settings page

Opening an agent in Settings > Agents shows two parts:

1. **Agent-wide** (stored on the agent):
   - name, avatar, description
   - **paused**: a kill switch; every call is refused and no doorbell is sent, grants
     are kept. Events are still recorded; after unpausing they are delivered, with
     `wake` computed at delivery (an event older than the 30-day log is lost as usual)
   - **wakes** on/off (default off) and the **webhook URL** (shown only with wakes on);
     regenerate the webhook secret
   - tokens: list (name, created, last used), new token (connect box), revoke
   - **notify me about approvals** (ntfy) on/off, default on
2. **Per app** (one row per app on the owner's account, stored as grants):
   - access on/off (off = the agent does not see the app's tools or events)
   - `read`, `write`: allowed or off
   - `delete`, `send`, `share` (where the app has them): off, allowed or needs approval
   - presets fill the rows; editing a row makes it custom

Wakes are agent-wide; what wakes is set per app by its own rule (mail: the Curated
setting, section 4). Apps without a wake rule yet produce events with `wake: false`.
- The existing user `nova` is converted into the owner's agent once (occ command),
  so her history stays. Grants replace the calendar delegation and the hand-made
  Daily Todo share.

The agent's permissions: mail read + write allowed, mail send + delete `approval`.

## 2. Auth

- The connect box (shown once after creating an agent, or on "New token") gives:
  the MCP URL, an agent app password, a webhook secret, and config snippets.
- Endpoint: `https://atrium.example.com/agent/mcp` (MCP, Streamable HTTP).
  REST: `https://atrium.example.com/agent/v1/tools/<tool name>` (POST, JSON body = tool
  input), OpenAPI at `/agent/v1/openapi.json`.
- Header: `Authorization: Bearer <token>` (Basic `<agent uid>:<token>` also works,
  as for every app password).
- The token is a scoped agent token (`agent: true`, see
  `lib/private/Authentication/Scope/README.md`): no admin/security, no wildcards,
  cannot create tokens. What it may do on someone's data is the grant, checked on
  every call through `ScopeGuard`. Several tokens per agent; each can be revoked.
- Every call acts on one grantor's data. Default: the agent's owner. Tools take an
  optional `grantor` (user id) for agents granted access by several users.
- The same token also works on DAV/OCS, limited to the same grants.

## 3. Tools (base + mail)

Errors use MCP tool errors; REST returns `{error: {code, message}}` with codes
`forbidden`, `not_found`, `invalid_input`, `conflict`, `unavailable`.

### Base

| Tool | Scope | What |
| --- | --- | --- |
| `agent.whoami` | none | agent uid, owner, grants per area with modes, wakes on/off |
| `events.since({cursor?, limit?, types?})` | none (filtered by grants) | events after `cursor`, oldest first; `limit` default 100, max 500; returns `{events, next_cursor, has_more}`. No cursor = start from now (returns no events, only `next_cursor`) |
| `approvals.list({status?, cursor?, limit?})` | none | this agent's requests |
| `approvals.get({request_id})` | none | one request with status and result |
| `approvals.cancel({request_id})` | none | withdraw a pending request |

Events are kept 30 days. A cursor older than that returns `invalid_input`
(`cursor_expired`); the agent then restarts from now and catches up with the
normal tools.

### Mail

Identity: `message_key` = `<account id>:<md5 of Message-ID>` (Atrium's stable mail
identity: survives moves, archiving and resyncs). Mail without a Message-ID gets a
hash of its headers. `thread_key` groups a conversation.

| Tool | Scope | What |
| --- | --- | --- |
| `mail.accounts` | mail:read | accounts (id, email, name) with folders (id, name, role: inbox/archive/sent/drafts/trash/junk/other, counts) |
| `mail.message.list({...})` | mail:read | search, see filters below |
| `mail.message.get({message_key, html?, max_chars?, offset?})` | mail:read | headers, text body (stored copy), optional sanitized HTML, attachment list, flags, full classification, folder, `only_in_atrium`. Body paged: `max_chars` default 8000, returns `body_truncated`, `body_length`, `offset` |
| `mail.thread.get({thread_key, max_chars?})` | mail:read | the messages of a conversation; each body capped by `max_chars` (default 2000) with the same truncation fields |
| `mail.attachment.get({message_key, attachment_id})` | mail:read | metadata (filename, type, size) plus a download URL valid 15 min (REST `GET /agent/v1/mail/attachments/<id>`, same token); content inline as base64 only when the file is under 256 KB. Stores it on demand as for the UI |
| `mail.message.update({message_key, seen?, starred?, folder?})` | mail:write | flags and moves; `folder: "archive"` or a folder id. Moving to Trash/Junk is refused here (use delete) |
| `mail.message.delete({message_key})` | mail:delete | move to Trash; never a hard delete ([never-delete rule](../lessons.md)) |
| `mail.draft.list / get` | mail:read | drafts |
| `mail.draft.create({account, to, cc?, bcc?, subject, body, in_reply_to?, forward_of?, attachments?})` | mail:write | `in_reply_to`/`forward_of` are message keys; attachments as `{upload_id}` (file uploaded first with REST `POST /agent/v1/mail/uploads`, multipart, max 25 MB, kept 24 h), `{message_key, attachment_id}`, or `{filename, base64}` under 256 KB |
| `mail.draft.update({draft_key, ...})` | mail:write | same fields |
| `mail.draft.delete({draft_key})` | mail:write for a never-sent draft the agent created itself, mail:delete for any other draft | moves to Trash, like any mail (never a hard delete). Decided by the owner 2026-11-08: agents may trash their own drafts without approval |
| `mail.send({draft_key})` | mail:send | send a draft |

`mail.message.list` filters: `account`, `folder` (id or role; default inbox +
archive), `after`/`before` (ISO dates), `from`, `to`, `subject`, `text` (full text
over stored bodies), `category` (one or a list), `curated` (bool, uses the owner's
Curated setting), `urgency_min` (never/whenever/this_week/today/now),
`needs_reply`, `needs_action`, `seen`, `starred`, `has_attachments`. Sorted newest
first, `limit` default 25 (max 100), `cursor` for the next page. Each row: message
key, thread key, account, folder, date, from, to, subject, snippet (up to 300
chars), flags, has_attachments, and a compact classification (`category`, `urgency`,
`needs_reply`, `needs_action`, `suspicious`, rounded to 2 decimals). The full object
comes with `mail.message.get`.

Classification object (mail-v2, from `mail_triage`):

```json
{
  "schema": "mail-v2",
  "category": "personal|work|admin|orders|security|social|newsletter|ads|spam|other",
  "category_confidence": 0.93,
  "urgency": "never|whenever|this_week|today|now",
  "urgency_score": 0.41,
  "needs_reply": 0.82, "needs_action": 0.10, "has_deadline": 0.05,
  "written_by_person": 0.97, "suspicious": 0.02,
  "classified_at": "2026-11-08T10:00:03Z"
}
```

The predicates are probabilities (0 to 1), as stored today.

### Approval-gated calls

A call whose action is in `approval` mode checks the scope and validates the input,
then stores a request and returns, without acting:

```json
{ "status": "pending_approval", "request_id": "apr_01J...", "expires_at": "2026-12-08T10:00:00Z" }
```

- The payload is frozen and hashed when the request is made (for a send: the exact
  rendered message, recipients and attachments). If the draft changes afterwards,
  the request becomes `void` and the agent has to ask again.
- The owner approves or rejects (with an optional note) in Atrium; ntfy pings her.
- Approved: the action runs through the normal code path, recorded as
  "requested by nova, approved by alice". An approved delete is the usual Trash move.
- Requests expire after **30 days** (same as Trash retention).
- Request statuses: `pending`, `approved`, `rejected`, `expired`, `cancelled`,
  `void`, `executed`, `failed`.

## 4. Events

### Envelope

```json
{
  "id": "evt_01J...",
  "cursor": "c_000123",
  "type": "mail.received",
  "version": 1,
  "occurred_at": "2026-11-08T10:00:03Z",
  "app": "mail",
  "grantor": "alice",
  "wake": true,
  "data": { }
}
```

- The log is per agent: an agent only gets events about data its grants let it read.
- `wake` is computed per agent: true only if the agent has wakes on and the event
  matches the wake rule. One event, no separate wake copy: the bridge wakes on
  `wake: true` and still sees everything else in the stream.
- Webhook doorbell (agents with wakes on and a webhook URL; Nova: on the agent host,
  agent-host.lan): `POST <url>` with body `{agent, cursor, wake}` only, no mail data.
  Headers `X-Atrium-Timestamp`, `X-Atrium-Signature: sha256=<hex HMAC of
  "<timestamp>.<body>" with the webhook secret>`. Best effort, coalesced (at most
  one in flight per agent), retried with backoff. The agent then pulls
  `events.since()`, which is the source of truth.
- Responses: `2xx` done; `503`, timeouts and connection errors retried with backoff;
  `401` (bad or stale signature) is not retried in a loop: Atrium shows it on the
  agent's settings page and notifies the owner (secret mismatch or clock skew).
- the agent's doorbell: `http://agent-host.lan:7013/atrium/doorbell` (agent host, LAN only,
  plain HTTP is fine: no data in the body, HMAC signed). Her bridge also polls
  `events.since()` every 60 s and allows 5 min of timestamp skew.

### Wake rule for mail

`wake` is true for `mail.received` when the agent has wakes on AND the mail's
category is in the owner's **Curated** setting. Curated becomes a user setting
(which categories it shows; today hard-coded as everything except ads, spam,
newsletter and social). The wake rule reuses it: changing Curated changes the wakes.

### `mail.received`

Emitted only after the mail has been classified: there is no unclassified mail
event and no timeout. New mail is queued for classification as soon as sync
stores it (no longer only by the 5-min job). If classification gives up or is
paused (cap, tollgate down), no event goes out and the owner is alerted (Status page
+ ntfy); after recovery the waiting mails are classified and emitted in order.
Live mail only counts against the total daily cap, never the backlog cap.

```json
{
  "message_key": "3:9f2c...",
  "thread_key": "3:t:41ab...",
  "account": { "id": 3, "email": "owner@example.com" },
  "folder": { "id": 17, "role": "inbox", "name": "INBOX" },
  "date": "2026-11-08T09:59:40Z",
  "from": { "name": "Jane", "address": "jane@example.org" },
  "to": [{ "name": "", "address": "owner@example.com" }],
  "cc": [],
  "subject": "Lunch tomorrow?",
  "snippet": "Hey, are you free tomorrow around noon...",
  "has_attachments": false,
  "classification": { "schema": "mail-v2", "...": "as above" }
}
```

`classification.schema` changes if the categories ever change; the agent's bridge refuses
an unknown schema. Consumers dedupe on `message_key`.

### Approval events

`approval.approved`, `approval.rejected`, `approval.expired`, `approval.void`,
`approval.executed`, `approval.failed`. `wake` is true for all of them when the
agent has wakes on (the agent asked, so it wants the answer).

```json
{
  "request_id": "apr_01J...",
  "tool": "mail.send",
  "input": { "draft_key": "3:d:77..." },
  "requested_at": "2026-11-08T10:01:00Z",
  "decided_by": "alice",
  "decided_at": "2026-11-08T10:20:00Z",
  "note": "ok but cc Marc next time",
  "result": { "message_key": "3:aa01..." },
  "error": null
}
```

`result` is set on `executed`, `error` on `failed`.

## Changes to earlier decisions

- 0004: an action in a grant has a mode (`allowed` or `approval`), not just presence.
- 0005: a resource may leave out an operation agents must not have (mail messages
  have no `create`: mail arrives by sync, agents write drafts). The tool list says so;
  full CRUD stays the rule everywhere else.
- 0006: delivery is a per-agent log with a cursor; webhooks are only a doorbell.

## Implementation (2026-11-08)

New code is TypeScript first (CLAUDE.md, "Language"). This changes how 0005 is
built, not the wire contract above.

- **Bun server, `server/agent/`**: the MCP and REST endpoint, tool definitions,
  the event log, cursor and doorbell, approvals, uploads and download links, the
  agent settings API and the wake rule. Its tables (`atrium_agent_*`) are created
  and migrated by the Bun server through `Bun.SQL` (sqlite on dev, Postgres on
  test and live).
- **PHP, kept thin**: who a token or session belongs to (Bun forwards the
  request's auth headers to a PHP route and caches the answer about a minute), creating
  or converting the agent account and its app passwords, and the mail operations
  (drafts, send chain, Trash moves, attachments, IMAP). Bun calls PHP over FastCGI
  with an internal secret, and strips that header from outside requests.
- **Events start where they happen**: PHP writes a row into a queue table (mail
  sync and triage); Bun moves queued rows into the event log in order, so cursors
  never skip a row that committed late.
- **Tool names use underscores** (`mail_message_list`, `events_since`): OpenAI
  function names may not contain dots. REST also accepts the dotted spelling.
- PHP's `OCP\Agent` tool contracts and `ToolRegistry` (0005) are not used for the
  first slice; apps rewritten in TS define their tools in TS.
