# services/agentchat: letting an agent answer from inside Wavium

Wavium can talk to an agent that runs **outside** it (V4-39). You write in the
assistant panel, the agent reads on its own machine, does the work with its own
AI, and answers in the same thread.

Nothing here is installed by Wavium, and nothing here is required: an instance
without this runner simply has an agent that never answers.

## Why the agent asks instead of being told

`claude-mail` runs on the owner's machine on a personal Claude subscription.
Two things follow, and they shape the whole design:

- **Wavium cannot reach it.** The app containers sit on `backend`
  (`internal: true`) plus `edge`; there is no route into the host, and opening
  one would mean a listener on the machine, a shared secret inside a container,
  and a compose change. None of that is needed here.
- **Its credentials must not move.** A Claude subscription is the owner's, not
  the instance's. Copying `~/.claude` into a container would be the wrong trade
  for a chat window.

So the runner polls. It costs one small HTTP request every ten seconds and
starts a real agent run only when something is actually waiting.

## What it speaks

Two plain-text routes, with the agent's own token — the same token it already
uses for everything else. No new credential, no new port.

| Call | What it does |
| --- | --- |
| `GET /agent/v1/chat/-/pending` | The waiting messages, one per block, and marks them taken |
| `POST /agent/v1/chat/-/say` | The request body is what the agent says |

`-` is where a user id goes, and a user id can never contain a slash, so these
can never shadow somebody's agent. They are plain text on purpose: building and
parsing JSON in a shell script is where such scripts rot, and the point of this
runner is that it needs nothing but `curl`.

An agent that speaks MCP can use the tools `chat_poll` and `chat_say` instead —
same thing, same rules.

## Running it

```sh
WAVIUM_URL=https://wavium.example:8443 \
WAVIUM_AGENT=claude-mail \
WAVIUM_AGENT_TOKEN_FILE=$HOME/claude-mail/token \
services/agentchat/chat-loop.sh
```

Under `systemd --user` (`wavium-chat.service.example` here), or from cron with
`@reboot`. One instance at a time: it takes a lock and leaves quietly if
another copy holds it.

Two traps worth knowing, both met while installing this for real:

- **Quote any `Environment=` value containing a space.** systemd splits an
  unquoted one on whitespace, so `--cacert /path` arrives as `--cacert` with no
  argument and every poll fails.
- **Point the unit at a copy of the script**, not at the file in a git working
  tree, or changing branch stops the service.

| Variable | Default | What for |
| --- | --- | --- |
| `WAVIUM_URL` | required | Where Wavium is |
| `WAVIUM_AGENT_TOKEN_FILE` | required | A file holding the agent token; never passed as an argument |
| `WAVIUM_AGENT` | `claude-mail` | Which `--agent` to run |
| `WAVIUM_CHAT_DIR` | `$HOME/.wavium-chat/<agent>` | Lock, session id, log |
| `WAVIUM_CHAT_EVERY` | `10` | Seconds between polls |
| `WAVIUM_CHAT_TIMEOUT` | `900` | Longest run before it is cut |
| `WAVIUM_CHAT_ONCE` | `0` | `1` = answer one batch and exit (a cron line, or the tests) |
| `WAVIUM_CURL_OPTS` | empty | Extra curl options, e.g. `--cacert` for a private CA |
| `CLAUDE_BIN` | from `PATH` | The binary to run |

## What it promises

- **A failure reaches the person waiting.** A run that fails, times out or says
  nothing posts a message saying so. The silent brief of V4-25 is the reason
  this is a rule and not a nicety.
- **A message is answered once.** `pending` hands a message to one caller and
  marks it taken, so two ticks of the loop cannot answer the same thing twice.
- **The token stays in a header.** It is read from the file per call and never
  put on a command line, where `ps` would show it.
- **One bad turn does not poison the next.** The Claude session id is kept for
  continuity and dropped when a run fails.

Tested for real — fake Wavium, fake `claude` — in
`server/agent/chat/loop.test.ts`.
