// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Error mapping, config validation, timeouts and the mock provider.
import { expect, test } from 'bun:test'
import { parseRetryAfter } from './errors'
import { AiError, createProvider, type ProviderConfig } from './index'
import { collect, fakeFetch, jsonRes, sseRes } from './testkit'

const KEY = 'sk-test-SECRET-0123456789'
const req = { messages: [{ role: 'user' as const, content: 'x' }] }

async function errorFor(kind: 'anthropic' | 'openai', canned: Response | Error, extra: Partial<ProviderConfig> = {}): Promise<AiError> {
	const f = fakeFetch(canned)
	const p = createProvider({ kind, apiKey: KEY, defaultModel: 'm', ...extra }, { fetch: f.fetch })
	const e = await p.complete(req).catch((e) => e)
	expect(e).toBeInstanceOf(AiError)
	expect(JSON.stringify(e) + e.message + e.stack).not.toContain(KEY)
	return e
}

test('errors: HTTP status -> stable codes, for both API families', async () => {
	for (const kind of ['anthropic', 'openai'] as const) {
		expect(await errorFor(kind, jsonRes({ error: { message: 'bad key' } }, 401))).toMatchObject({ code: 'auth', status: 401, provider: kind })
		expect((await errorFor(kind, jsonRes({ error: { message: 'no' } }, 403))).code).toBe('auth')
		expect((await errorFor(kind, jsonRes({ error: { message: 'pay' } }, 402))).code).toBe('budget')
		expect(await errorFor(kind, jsonRes({ error: { message: 'slow down' } }, 429, { 'retry-after': '17' }))).toMatchObject({ code: 'rate_limit', retryAfter: 17 })
		expect((await errorFor(kind, jsonRes({ error: { message: 'slow down' } }, 429))).retryAfter).toBeUndefined()
		expect(await errorFor(kind, jsonRes({ error: { message: 'max_tokens: too big' } }, 400))).toMatchObject({ code: 'invalid', status: 400 })
		expect((await errorFor(kind, jsonRes({ error: { message: 'no such model' } }, 404))).code).toBe('invalid')
		expect((await errorFor(kind, jsonRes({ detail: [{ msg: 'bad' }] }, 422))).code).toBe('invalid')
		expect(await errorFor(kind, new Response('<html>Bad Gateway</html>', { status: 502 }))).toMatchObject({ code: 'unavailable', status: 502 })
		expect((await errorFor(kind, jsonRes({ error: { type: 'overloaded_error' } }, 529))).code).toBe('unavailable')
		const net = await errorFor(kind, new TypeError(`connect ECONNREFUSED, Authorization: Bearer ${KEY}`))
		expect(net).toMatchObject({ code: 'unavailable', status: undefined })
	}
})

test('errors: OpenAI insufficient_quota (429) is budget; message keeps the reason, never the key', async () => {
	const e = await errorFor('openai', jsonRes({ error: { message: `You exceeded your current quota (key ${KEY})`, type: 'insufficient_quota', code: 'insufficient_quota' } }, 429))
	expect(e.code).toBe('budget')
	expect(e.message).toContain('exceeded your current quota')
	expect(e.toJSON()).toEqual({ code: 'budget', message: e.message, provider: 'openai', status: 429 })
})

test('errors: Retry-After as seconds or HTTP date', () => {
	const now = Date.parse('2026-11-12T10:00:00Z')
	expect(parseRetryAfter('30', now)).toBe(30)
	expect(parseRetryAfter('Thu, 12 Nov 2026 10:01:00 GMT', now)).toBe(60)
	expect(parseRetryAfter('soon', now)).toBeUndefined()
	expect(parseRetryAfter(null, now)).toBeUndefined()
})

test('timeout -> unavailable; caller abort is rethrown as is', async () => {
	const hang = (c: { signal?: AbortSignal | null }) => new Promise<Response>((_, reject) => c.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
	const f = fakeFetch(hang, hang)
	const p = createProvider({ kind: 'openai', apiKey: KEY, defaultModel: 'm', timeoutMs: 20 }, { fetch: f.fetch })
	expect(await p.complete(req).catch((e) => e)).toMatchObject({ code: 'unavailable', message: expect.stringContaining('no answer') })
	const ctrl = new AbortController()
	const pending = p.complete({ ...req, signal: ctrl.signal }).catch((e) => e)
	ctrl.abort(new Error('user cancelled'))
	const e = await pending
	expect(e).not.toBeInstanceOf(AiError)
	expect(e.message).toBe('user cancelled')
})

test('stream: idle timeout when the body stalls', async () => {
	const f = fakeFetch((c) => new Response(new ReadableStream({
		start(ctrl) {
			ctrl.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
			c.signal!.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError')))
		},
	})))
	const p = createProvider({ kind: 'openai', apiKey: KEY, defaultModel: 'm', timeoutMs: 30 }, { fetch: f.fetch })
	const got: string[] = []
	const e = await (async () => { for await (const ev of p.stream(req)) if (ev.type === 'text') got.push(ev.text) })().catch((e) => e)
	expect(got).toEqual(['hi'])
	expect(e).toMatchObject({ code: 'unavailable' })
})

test('config validation: clear invalid errors', () => {
	const bad = (c: unknown, msg: string) => {
		let e: unknown
		try { createProvider(c as ProviderConfig) } catch (x) { e = x }
		expect(e).toBeInstanceOf(AiError)
		expect(e).toMatchObject({ code: 'invalid', message: expect.stringContaining(msg) })
	}
	bad({ kind: 'anthropic' }, 'API key is required')
	bad({ kind: 'openai', apiKey: '  ' }, 'API key is required')
	bad({ kind: 'mistral' }, 'API key is required')
	bad({ kind: 'openai-compatible' }, 'base URL is required')
	bad({ kind: 'openai-compatible', baseUrl: 'not a url' }, 'not a URL')
	bad({ kind: 'ollama', baseUrl: 'ftp://x' }, 'http or https')
	bad({ kind: 'gemini', apiKey: 'k' }, 'unknown provider kind')
	bad({ kind: 'openai', apiKey: 'k', timeoutMs: 0 }, 'timeoutMs')
	expect(createProvider({ kind: 'ollama' }).id).toBe('ollama')
	expect(createProvider({ kind: 'openai-compatible', baseUrl: 'http://litellm:4000', id: 'gw' }).id).toBe('gw')
})

test('a request without a model and no default model is invalid, nothing is sent', async () => {
	const f = fakeFetch()
	const p = createProvider({ kind: 'openai', apiKey: KEY }, { fetch: f.fetch })
	expect(await p.complete(req).catch((e) => e)).toMatchObject({ code: 'invalid', message: expect.stringContaining('no model') })
	expect(f.calls).toHaveLength(0)
})

test('mock: echo by default, scripted replies, recorded requests, simulated errors', async () => {
	const m = createProvider({ kind: 'mock', defaultModel: 'mock-big' })
	const r = await m.complete({ system: 's', messages: [{ role: 'user', content: 'hello' }] })
	expect(r).toMatchObject({ text: 'mock: hello', toolCalls: [], stopReason: 'end', model: 'mock-big' })
	expect(r.usage.inputTokens).toBeGreaterThan(0)
	expect(r.usage.outputTokens).toBe(3)

	m.enqueue({ toolCalls: [{ name: 'search_mail', input: { q: 'a' } }] }, (q) => ({ text: `saw ${q.messages.length} messages` }))
	m.failNext('rate_limit', { retryAfter: 5 })
	const t = await m.complete({ messages: [{ role: 'user', content: 'go' }] })
	expect(t.stopReason).toBe('tool_use')
	expect(t.toolCalls).toEqual([{ id: 'mock_call_2_0', name: 'search_mail', input: { q: 'a' } }])
	expect((await m.complete({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] })).text).toBe('saw 3 messages')
	expect(await m.complete(req).catch((e) => e)).toMatchObject({ code: 'rate_limit', status: 429, retryAfter: 5, provider: 'mock' })

	expect(m.requests).toHaveLength(4)
	expect(m.requests[0]).toEqual({ system: 's', messages: [{ role: 'user', content: 'hello' }] })
	expect(await m.complete({ messages: [{ role: 'user', content: [{ type: 'tool_result', toolCallId: 'x', content: '42' }] }] })).toMatchObject({ text: 'mock: 42' })
	m.reset()
	expect(m.requests).toHaveLength(0)
	expect(await m.testConnection()).toEqual({ ok: true, models: ['mock-big'] })
})

test('mock: streams the text in chunks, then tool calls, then done', async () => {
	const m = createProvider({ kind: 'mock' })
	m.enqueue({ text: 'one two  three', toolCalls: [{ id: 'c1', name: 'f' }] })
	const evs = await collect(m.stream(req))
	expect(evs).toEqual([
		{ type: 'text', text: 'one ' },
		{ type: 'text', text: 'two  ' },
		{ type: 'text', text: 'three' },
		{ type: 'tool_call', call: { id: 'c1', name: 'f', input: {} } },
		{ type: 'done', result: { text: 'one two  three', toolCalls: [{ id: 'c1', name: 'f', input: {} }], stopReason: 'tool_use', usage: expect.any(Object), model: 'mock-1' } },
	])
})

// --- after review (round 2) ---

test('errors: a plain 429 rate limit linking to the billing page stays rate_limit; retry-after-ms wins', async () => {
	const body = { error: { message: 'Rate limit reached for gpt-4.1 in organization org-x on tokens per min (TPM): Limit 30000, Used 30000. Please try again in 1.2s. Visit https://platform.openai.com/account/billing to increase your limit.', type: 'tokens', param: null, code: 'rate_limit_exceeded' } }
	const e = await errorFor('openai', jsonRes(body, 429, { 'retry-after': '2', 'retry-after-ms': '1200' }))
	expect(e).toMatchObject({ code: 'rate_limit', retryAfter: 2 })
	const e2 = await errorFor('openai', jsonRes(body, 429, { 'retry-after-ms': '300' }))
	expect(e2.retryAfter).toBe(1)
	// Free text alone never makes a budget error: only the structured fields do.
	expect((await errorFor('anthropic', jsonRes({ type: 'error', error: { type: 'rate_limit_error', message: 'see billing / insufficient quota' } }, 429))).code).toBe('rate_limit')
	expect((await errorFor('anthropic', jsonRes({ type: 'error', error: { type: 'billing_error', message: 'x' } }, 400))).code).toBe('budget')
})

test('redirects are not followed (key would travel along): 3xx -> invalid', async () => {
	for (const kind of ['anthropic', 'openai'] as const) {
		const f = fakeFetch(new Response(null, { status: 307, headers: { location: 'https://evil.example/v1/messages' } }))
		const p = createProvider({ kind, apiKey: KEY, defaultModel: 'm' }, { fetch: f.fetch })
		expect(await p.complete(req).catch((e) => e)).toMatchObject({ code: 'invalid', status: 307, message: expect.stringContaining('redirect') })
		expect(f.calls[0].redirect).toBe('manual')
	}
})

test('size limits: huge JSON answer -> unavailable; huge error body is cut but still classified', async () => {
	const big = 'x'.repeat(9 * 1024 * 1024)
	const f = fakeFetch(new Response(`{"a":"${big}"}`), new Response(JSON.stringify({ error: { message: 'bad key' }, pad: big }), { status: 401 }))
	const p = createProvider({ kind: 'openai', apiKey: KEY, defaultModel: 'm' }, { fetch: f.fetch })
	expect(await p.complete(req).catch((e) => e)).toMatchObject({ code: 'unavailable', message: expect.stringContaining('bytes') })
	expect(await p.complete(req).catch((e) => e)).toMatchObject({ code: 'auth', status: 401 })
})

test('stream: an SSE line that never ends -> unavailable', async () => {
	let sent = 0
	const f = fakeFetch(() => new Response(new ReadableStream({
		pull(ctrl) {
			if (sent++ > 300) return ctrl.close()
			ctrl.enqueue(new TextEncoder().encode('data: ' + 'y'.repeat(8192)))
		},
	})))
	const p = createProvider({ kind: 'openai', apiKey: KEY, defaultModel: 'm' }, { fetch: f.fetch })
	expect(await collect(p.stream(req)).catch((e) => e)).toMatchObject({ code: 'unavailable', message: expect.stringContaining('over') })
})

test('stream: the idle timeout does not count the time the caller spends between events', async () => {
	const body = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
	// Like a real connection, the body fails once our signal aborts.
	const f = fakeFetch((c) => {
		const inner = sseRes(body, 4).body!.getReader()
		return new Response(new ReadableStream({
			async pull(ctrl) {
				if (c.signal!.aborted) return ctrl.error(new DOMException('aborted', 'AbortError'))
				const { done, value } = await inner.read()
				if (done) ctrl.close()
				else ctrl.enqueue(value)
			},
		}))
	})
	const p = createProvider({ kind: 'openai', apiKey: KEY, defaultModel: 'm', timeoutMs: 30 }, { fetch: f.fetch })
	const got: string[] = []
	for await (const ev of p.stream(req)) {
		if (ev.type === 'text') got.push(ev.text)
		await Bun.sleep(60)
	}
	expect(got.join('')).toBe('ab')
})

test('stream: a caller abort carries the usage known so far too', async () => {
	const ctrl = new AbortController()
	const f = fakeFetch((c) => new Response(new ReadableStream({
		start(s) {
			s.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":12,"output_tokens":1}}}\n\n'))
			s.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'))
			c.signal!.addEventListener('abort', () => s.error(new DOMException('aborted', 'AbortError')))
		},
	})))
	const p = createProvider({ kind: 'anthropic', apiKey: KEY, defaultModel: 'm' }, { fetch: f.fetch })
	const e = await (async () => { for await (const ev of p.stream({ ...req, signal: ctrl.signal })) if (ev.type === 'text') ctrl.abort(new Error('stop')) })().catch((e) => e)
	expect(e).not.toBeInstanceOf(AiError)
	expect(e.usage).toEqual({ inputTokens: 12, outputTokens: 1, reported: true })
})
