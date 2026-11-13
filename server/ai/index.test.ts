// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Error mapping, config validation, timeouts and the mock provider.
import { expect, test } from 'bun:test'
import { parseRetryAfter } from './errors'
import { AiError, createProvider, type ProviderConfig } from './index'
import { collect, fakeFetch, jsonRes } from './testkit'

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
