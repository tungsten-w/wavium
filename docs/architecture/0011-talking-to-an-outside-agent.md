# 0011: Talking to an agent that runs outside Wavium

Status: accepted (owner's ask 2026-11-25), built in V4-39 (branch `night/V4-39`).

## Goal

Give an agent a chat window in Wavium. The owner's `claude-mail` already runs
continuously on the machine that hosts the instance, on a personal Claude
subscription, driven from a terminal and cron. They asked to talk to it from
Wavium instead: "sans forcément passer par un terminal... pour qu'il exécute
des tâches".

This is not the built-in assistant (ADR 0009, `server/agent/assistant`). That
one *is* Wavium: it runs on the instance's AI provider, inside the request. The
agent here is somebody else's process, with its own AI, its own credentials and
its own schedule.

## Who reaches whom

The hard constraint is the direction of the connection.

| Way | For | Against |
| --- | --- | --- |
| **Wavium calls the agent** (an HTTP bridge on the host) | Real streaming; an answer feels immediate | A listener on the owner's machine, a shared secret inside a container, and `extra_hosts` in the compose file. The app containers sit on `backend` (`internal: true`) and have no route to the host today: this would open one. The bridge would also have to be trusted to run `claude` on demand. |
| **A container runs the agent** | No host process | The agent's credentials are a personal subscription. Copying `~/.claude` into a container is the wrong trade for a chat window, and the agent would lose the machine it works on. |
| **The agent calls Wavium** (chosen) | Nothing new is exposed: the agent already holds a token and already reaches the instance. No compose change, no new port, no new secret. A runner is ~120 lines of `sh`. | No push: the answer arrives when the agent next checks in and finishes a run. |

**Decision: the agent asks.** A thread lives in Wavium
(`oc_atrium_agent_chat`); the owner writes into it from the shell's assistant
panel; the agent polls, runs, and writes its answer back.

The latency this costs is smaller than it looks: a real run takes tens of
seconds anyway, so a 10-second poll is not what the owner waits for. What
matters is that the panel says *where* the message is rather than pretending
someone is typing.

## Surface

Owner side (session cookie), `server/agent/chat`:

- `GET /agent/v1/chat` — the agents this user can talk to, and what is waiting
- `GET /agent/v1/chat/<uid>` — the thread, `?after=<id>` for polling
- `POST /agent/v1/chat/<uid>` — send

Agent side, two shapes of the same two operations:

- tools `chat_poll` and `chat_say`, for an agent that speaks MCP
- `GET /agent/v1/chat/-/pending` and `POST /agent/v1/chat/-/say`, plain text,
  for an agent whose runner is a shell script. `-` is where a user id goes and
  a user id cannot contain a slash, so these can never shadow an agent.

Plain text is a deliberate second shape. Building and parsing JSON in `sh` is
where such runners rot, and the point of the runner is that it needs nothing
but `curl`.

## Rules this follows

- **No new grant area.** Both tools are base tools (`area: null`). A message
  the owner deliberately typed to their own agent is not access to their data,
  and the answer is the agent's own words. Nothing in this module reads mail,
  files, calendar or anything else — so there is nothing to grant.
- **Pausing an agent silences it.** `callTool` already refuses a paused agent;
  the plain-text routes check the same thing. The panel says a paused agent
  will not read the message, instead of leaving the owner waiting.
- **A message is answered once.** Reading marks it taken, in the same call, so
  two ticks of a runner (or two runners) cannot answer the same message twice.
- **Each agent sees only its own thread**, and only the owner of an agent can
  read or write it.
- **The event is addressed to the agent** (`enqueue({agent})`), so it is
  visible through `events_since` with no grant at all, and invisible to every
  other agent of the same owner.
- **A failure reaches the person waiting.** The runner answers in the thread
  when a run fails, times out or says nothing. The silent brief of V4-25 is why
  this is a rule.

## What is deliberately not here

- No streaming, and no "typing" indicator: there is nothing to stream.
- No push to the agent. A doorbell webhook (ADR 0006) cannot be delivered to a
  machine with no listener, which is the whole premise.
- No runner installed by Wavium. `services/agentchat/chat-loop.sh` is shipped
  and documented; starting it is the owner's decision, on their machine.
- No new credential: the runner uses the agent token that already exists.
