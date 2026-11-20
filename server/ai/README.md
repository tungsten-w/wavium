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

const ai = createProvider({ kind: 'anthropic', apiKey, defaultModel: 'claude-sonnet-5-5' })

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

With nothing queued it answers `mock: <last user text>`, or, when the request
forces a tool (`toolChoice: { name }`), calls that tool with a sample input
built from its schema (first enum value, 0.5, ...). So mail triage works on the
dev stack with the mock and no script.

## Rules

- API keys live only in request headers. Never log them, never put them in a
  URL or an error message (`AiError` messages are redacted).
- No real network in tests: pass a fake `fetch` (`createProvider(cfg, { fetch })`)
  or use the mock. See `testkit.ts`. No real key anywhere (rule A2).
- Limits: error body 64 KB, JSON answer 8 MB, SSE line 1 MB. Redirects are not followed.
- Open items from review (usage on shared abort signals, JSON cap socket
  cleanup, base-URL checks) are listed in `reports/P2-1.md`.

## Budgets and usage (`budget.ts`, P2-3)

```ts
import { Budget, BudgetBlocked } from './budget'
import { SqlUsageStore } from './usage-store'

const budget = new Budget(new SqlUsageStore(db), () => ({
	rules: [
		{ task: 'triage', dailyCost: 0.5 },          // $0.50 a day for triage, all providers
		{ provider: 'claude', monthlyCost: 20 },      // $20 a month on that provider
		{ monthlyTokens: 5_000_000 },                 // everything together
	],
	prices: { 'claude:claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 } }, // USD / M tokens
}))
const ai = budget.wrap(createProvider(cfg), { user: 'alice', task: 'triage' })
// same AiProvider interface; a refused call throws BudgetBlocked (code 'budget', .until, .reason)
```

- Every call is stored in `atrium_ai_usage` (tokens, cost, estimated, error), also failed,
  aborted and early-stopped streams. No usage from the server: estimated, 4 chars = 1 token.
- Caps: daily / monthly, in USD and/or tokens, scoped by provider and/or task. Checked
  before each call (calls in flight can pass a cap a little). Day and month = local time.
- Pauses (`atrium_ai_pause`, per user and provider), as in TriageService: no credit until
  midnight, bad key 1 h, rate limit Retry-After, unavailable backoff 30 s → 30 min.
  `budget.resume(user, provider)` lifts one. `budget.summary(user, providers)` feeds a usage page.
- Rules and prices are read at each call (a function), so settings changes apply at once.
- A model without a price costs 0 (its tokens still count for token caps).

## Model per task (`routing.ts`, P2-5)

```ts
import { providerForTask, describeRouting } from './routing'

// providers: the user's ProviderConfig[] (P2-2 settings)
const routing = { routes: { triage: { provider: 'local', model: 'qwen2.5:7b' }, draft: { provider: 'claude' } }, defaultProvider: 'claude' }
const { ai, route } = providerForTask('triage', routing, providers)
await ai.complete({ messages })          // model already set (an explicit req.model still wins)
describeRouting(routing, providers)     // { routes, problems } for the settings page
```

- Tiers: `triage` = small, `summary` / `draft` / `assistant` / anything else = large.
- Model: the route's model → (large tasks) the provider's `defaultModel` → the kind's
  suggested model for the tier (`SUGGESTED_MODELS`: Anthropic, OpenAI, Mistral) →
  `defaultModel`. Ollama and OpenAI-compatible gateways need a model set somewhere.
- Provider: the route's → `defaultProvider` → the first configured. A route to a provider
  that is not configured is an `AiError('invalid')`, never a silent switch.
- With budgets (P2-3): `budget.wrap(providerForTask(task, ...).ai, { user, task })`.

## Mail triage (`triage.ts`, `triage-route.ts`, P2-4)

Mail's `TriageService` (PHP) keeps the queue, the IMAP fetch, its € caps and
the `mail-v2` tables. For each mail it calls the Bun server:

```
POST /agent/v1/internal/ai/triage     X-Atrium-Internal: <HMAC of the secret>
{ "uid": "<account owner>", "input": "<headers + text>", "questions": [... questions.json ...] }
```

- The owner's AI settings choose the provider (their default, else the
  instance one); the task is `triage`, so the small model (P2-5); the call goes
  through the budget (P2-3) as `task: "triage"`.
- The questions become one forced tool call `classify` (schema built from
  `questions.json`: enums for choices and levels, 0..1 numbers for predicates).
  The answer is checked; one retry on a bad answer.
- The answer has the decisions shape TriageService already read from tollgate
  (`answers[]` with choice / predicate / score), so `summarize()`, the `raw`
  column and every reader of `mail_triage` are unchanged.
- Status codes TriageService acts on: 200; 409 no AI configured; 402 budget
  (with `until`); 401 key refused; 429 / 503 (with `until` when known);
  422 the model kept answering badly (one attempt counted on that mail).
- Mail app config `triage_backend` = `ai` | `tollgate`. Unset: `tollgate` when a
  tollgate token exists (existing installs keep working), else `ai`.
  PHP finds the Bun server at `ATRIUM_SERVER_URL` (dev: `http://web:8080`),
  or system config `atrium.server_url`.

## What builds on it

- P2-2: provider settings and key storage; must validate user-entered base URLs and headers.
- P2-3: budgets and pauses, driven by `AiError` codes and `usage`.
- P2-4: mail triage with a forced tool call (done, see above).
- P2-5: the other AI features (summaries, drafts, assistant).
