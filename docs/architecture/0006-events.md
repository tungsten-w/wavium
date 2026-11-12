# 0006: Push events to agents

Status: accepted (2026-11-01), not started.

## Decision

Agents get woken by Atrium instead of polling: a new mail, an event starting soon,
a task due, a Daily Todo item changed, a file uploaded. Nova polls every 5 minutes
today and works on stale local copies; push removes both.

## Direction

- Build on Nextcloud's typed events (`IEventDispatcher`) and the shipped
  `webhook_listeners` app, which already delivers events to HTTP endpoints.
- Delivery is filtered by the agent's grants: an agent only hears about data it may read.
- Each app declares its agent-relevant events in its own directory, like its tools.
- MCP clients can also subscribe over the MCP connection once the transport exists.
