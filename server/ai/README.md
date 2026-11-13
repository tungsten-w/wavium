# server/ai: AI provider layer

One TypeScript interface for the AIs Atrium calls itself (triage, summaries,
drafts, assistant). Each provider maps Atrium's neutral types to its own wire
format. Configured providers live in `settings.ts` (Settings > AI, P2-2).

## Kinds

| kind | default base URL | key |
| --- | --- | --- |
| `anthropic` | `https://api.anthropic.com` | required |
| `openai` | `https://api.openai.com/v1` | required |
| `mistral` | `https://api.mistral.ai/v1` | required |
| `ollama` | `http://ollama:11434/v1` | no |
| `openai-compatible` | none, `baseUrl` required (LiteLLM, vLLM, OpenRouter...) | optional |
| `mock` | none, no network | no |

## Usage

```ts
import { AiError, createProvider } from './index'

const ai = createProvider({ kind: 'anthropic', apiKey, defaultModel: 'claude-sonnet-4-5' })

// One answer.
const res = await ai.complete({ messages: [{ role: 'user', content: 'Hello' }], maxTokens: 200 })
console.log(res.text, res.usage.inputTokens, res.usage.outputTokens)

// Streaming: always use for-await (or break), so the stream gets closed.
for await (const ev of ai.stream({ messages: [{ role: 'user', content: 'Tell a story' }] })) {
	if (ev.type === 'text') process.stdout.write(ev.text)
	else if (ev.type === 'done') console.log(ev.result.stopReason, ev.result.usage)
}

// Tools, with a forced call.
const tools = [{ name: 'classify', description: 'Label a mail', inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } }]
const r = await ai.complete({ messages: [{ role: 'user', content: mailText }], tools, toolChoice: { name: 'classify' } })
const call = r.toolCalls[0] // check it is there: some servers ignore toolChoice

// Errors: branch on the code.
try {
	await ai.complete({ messages })
} catch (e) {
	if (!(e instanceof AiError)) throw e // a caller abort is rethrown as is
	switch (e.code) {
	case 'auth': /* bad key: tell the admin */ break
	case 'budget': /* no credit: pause the feature */ break
	case 'rate_limit': /* wait e.retryAfter seconds */ break
	case 'unavailable': /* retry later */ break
	case 'invalid': /* our request is wrong: do not retry */ break
	}
}
```

Notes: `model` falls back to `defaultModel`. `usage.reported` is false when the
server sent no usage; budgets must then estimate. `inputTokens` includes cached
tokens (`cacheReadTokens`, `cacheWriteTokens` give the parts). Tool results go
in a user message as `tool_result` blocks.

## Configured providers (Settings > AI)

Users and admins add providers on the Settings > AI page (`/settings/user/ai`).
Server code gets them from `AiSettings` (`server/ai/settings.ts`), reachable as
`aiModule().settings()` in the agent layer:

```ts
const settings = ai.settings()! // ai = the aiModule() passed to createLayer (startAgentLayer)
const provider = await settings.provider(uid)    // the user's default, or null
const { providers, defaultProvider } = await settings.config(uid) // keys decrypted, server only
```

- Instance providers (owner `''`, admins) and personal ones (one user; an admin
  can turn them off). Default: the user's choice, else the instance default,
  else the first instance provider.
- Keys: AES-256-GCM, key = HKDF(instance secret), provider id as associated
  data. Never sent back to the browser (`hasKey`, `keyHint` = last 4 chars).
  If the instance secret changes, keys must be entered again.
- A personal provider's base URL may not reach internal addresses (same guard
  as agent webhooks; `ATRIUM_AI_ALLOW` lifts it). Checked at save and before
  every request. Instance providers are trusted.
- The `mock` kind is offered only with `ATRIUM_AI_MOCK=1` (the dev stack sets it).
- API: `/agent/v1/ai/*`, see `server/agent/ai.ts`.

## The mock

```ts
const ai = createProvider({ kind: 'mock' })
ai.enqueue({ text: 'hi' }, { toolCalls: [{ name: 'classify', input: { label: 'spam' } }] })
ai.failNext('rate_limit', { retryAfter: 5 })
ai.requests // every request received
```

With nothing queued it answers `mock: <last user text>`.

## Rules

- API keys live only in request headers. Never log them, never put them in a
  URL or an error message (`AiError` messages are redacted).
- No real network in tests: pass a fake `fetch` (`createProvider(cfg, { fetch })`)
  or use the mock. See `testkit.ts`. No real key anywhere (rule A2).
- Limits: error body 64 KB, JSON answer 8 MB, SSE line 1 MB. Redirects are not followed.
- Open items from review (usage on shared abort signals, JSON cap socket
  cleanup, base-URL checks) are listed in `reports/P2-1.md`.

## What builds on it

- P2-2: provider settings and key storage; must validate user-entered base URLs and headers.
- P2-3: budgets and pauses, driven by `AiError` codes and `usage`.
- P2-4: mail triage with a forced tool call.
- P2-5: the other AI features (summaries, drafts, assistant).
