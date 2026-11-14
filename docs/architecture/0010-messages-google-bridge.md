# 0010: Messages app, linked to Google Messages (SMS and RCS)

Status: proposed (2026-11-14). Waits for the owner's go.

## Goal

Read and answer your phone's SMS and RCS from Wavium, like Mail: one app
(Messages), a local copy of every message, agent tools and events, and
nothing sent by an agent without a click.

## How to reach Google Messages

Google gives no API for Messages. Three ways:

| Way | For | Against |
| --- | --- | --- |
| **libgm** (Go, the protocol library of `mautrix-gmessages`, AGPL-3.0) | Same pairing as messages.google.com/web: QR code, or Google account. SMS **and** RCS, images, reactions, read receipts. Maintained (releases in 2026), used by Beeper. | Unofficial: Google can change the protocol and break it for a while. The phone must stay online. Written in Go, not TypeScript. |
| Android companion app | Official Android APIs | SMS only (no RCS for third-party apps); has to be the default SMS app to send; one more app to write and install. |
| Full Matrix bridge (`mautrix-gmessages` + homeserver) | Nothing to write on the protocol side | A Matrix homeserver just to carry messages: heavy, and a second user model. |

**Decision: a small Go sidecar built on libgm** (`services/gmessages/`), not the
whole Matrix bridge.

- Container `gmessages` in the stack, profile `messages` (off unless used).
  Image built from a pinned libgm version (`go.mau.fi/mautrix-gmessages`, exact
  tag in `go.mod`); one container per instance, one session per Wavium user.
- Talks only to the Bun server, on the internal Docker network, with a shared
  secret: `POST /pair` (returns the QR data or the Google account step),
  `GET /conversations`, `GET /messages`, `POST /send`, `POST /read`,
  and a WebSocket of events (new message, status, typing, phone offline).
- The pairing session (keys and cookies) is stored encrypted with the same key
  as the AI provider keys (P2-2), never in logs.
- Go is a new language in the repo. Reason (rule A6): rewriting libgm in
  TypeScript means maintaining the Google protocol ourselves; the sidecar keeps
  it a version bump.

## Data (Bun, like the agent layer)

- `atrium_msg_conversations`, `atrium_msg_messages`, `atrium_msg_attachments`
  (files in the user's data under `Messages/`). Every message is kept, even if
  deleted on the phone (same rule as Mail: never delete, hide instead).
- Phone numbers matched to Contacts (P3-3) for names and avatars.

## Agents (ADR 0009)

- Area `messages`: `read` (list, search, read), `send` (default **approval**),
  `write` (mark read, archive).
- Events: `message.received`, `message.sent`, `message.failed`,
  `messages.phone_offline`.
- One-time codes (2FA SMS) are **hidden from agents** by default (setting per
  agent), since an agent with them can take over accounts.

## Limits, said in the UI

- The phone must be on and online; Wavium shows "phone offline since ...".
- Unofficial link: it can break after a Google update until libgm is bumped.
- Only one web session at a time on some phones: pairing Wavium may log out
  messages.google.com/web in a browser.
- Public demo: the sidecar is off; a fake conversation set is seeded instead.
