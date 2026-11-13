// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Acceptance tests for P2-1 that the per-provider files do not cover:
// stream error paths, abort, key hygiene, no request on bad config, mock.
import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AiError, createProvider, type AiProvider, type AiRequest, type ProviderConfig } from './index'
import { collect, fakeFetch, jsonRes, sse, sseRes } from './testkit'

const KEY = 'sk-test-ACCEPT-0123456789'
const req: AiRequest = { messages: [{ role: 'user', content: 'x' }] }
const FAMILIES: ProviderConfig[] = [
	{ kind: 'anthropic', apiKey: KEY, defaultModel: 'm' },
	{ kind: 'openai', apiKey: KEY, defaultModel: 'm' },
	{ kind: 'mistral', apiKey: KEY, defaultModel: 'm' },
	{ kind: 'openai-compatible', apiKey: KEY, baseUrl: 'http://gw:4000/v1', defaultModel: 'm' },
	{ kind: 'ollama', apiKey: KEY, defaultModel: 'm' },
]

test('criterion 1: every kind exposes the same interface', () => {
	const kinds = [...FAMILIES, { kind: 'mock' } as ProviderConfig]
	for (const c of kinds) {
		const p: AiProvider = createProvider(c, { fetch: fakeFetch().fetch })
		expect(p.kind).toBe(c.kind)
		for (const m of ['complete', 'stream', 'listModels', 'testConnection'] as const) expect(typeof p[m]).toBe('function')
	}
})

test('criterion 4: HTTP errors before a stream starts are normalized too, with Retry-After', async () => {
	for (const c of FAMILIES) {
		const cases: Array<[number, string, Record<string, string>]> = [[401, 'auth', {}], [402, 'budget', {}], [429, 'rate_limit', { 'retry-after': '9' }], [400, 'invalid', {}], [503, 'unavailable', {}]]
		for (const [status, code, headers] of cases) {
			const f = fakeFetch(jsonRes({ error: { message: 'x' } }, status, headers))
			const p = createProvider(c, { fetch: f.fetch })
			const e = await collect(p.stream(req)).catch((e) => e)
			expect(e).toBeInstanceOf(AiError)
			expect(e).toMatchObject({ code, status })
			if (code === 'rate_limit') expect(e.retryAfter).toBe(9)
		}
	}
})

test('criterion 4: a network failure when opening a stream is unavailable', async () => {
	for (const c of FAMILIES) {
		const p = createProvider(c, { fetch: fakeFetch(new TypeError('fetch failed')).fetch })
		expect(await collect(p.stream(req)).catch((e) => e)).toMatchObject({ code: 'unavailable' })
	}
})

test('criterion 3: OpenAI stream error event and bad JSON are AiErrors, key redacted', async () => {
	const body = sse([[null, { choices: [{ delta: { content: 'a' } }] }], [null, { error: { message: `boom ${KEY}` } }]])
	const p = createProvider(FAMILIES[1], { fetch: fakeFetch(sseRes(body)).fetch })
	const e = await collect(p.stream(req)).catch((e) => e)
	expect(e).toMatchObject({ code: 'unavailable' })
	expect(e.message).not.toContain(KEY)
	const p2 = createProvider(FAMILIES[1], { fetch: fakeFetch(sseRes('data: {not json\n\n')).fetch })
	expect(await collect(p2.stream(req)).catch((e) => e)).toMatchObject({ code: 'unavailable' })
})

test('criterion 3: Anthropic mid-stream error types map to codes, message redacted', async () => {
	const map: Record<string, string> = { rate_limit_error: 'rate_limit', authentication_error: 'auth', invalid_request_error: 'invalid', api_error: 'unavailable' }
	for (const [type, code] of Object.entries(map)) {
		const body = sse([['error', { type: 'error', error: { type, message: `nope ${KEY}` } }]], '\r\n')
		const p = createProvider(FAMILIES[0], { fetch: fakeFetch(sseRes(body, 3)).fetch })
		const e = await collect(p.stream(req)).catch((e) => e)
		expect(e).toMatchObject({ code })
		expect(e.message).not.toContain(KEY)
	}
})

test('criterion 3: usage that only arrives at the end, \\r\\n framing, exactly one done (OpenAI)', async () => {
	const body = sse([
		[null, { model: 'm', choices: [{ delta: { role: 'assistant', content: 'He' } }] }],
		[null, { choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] }],
		[null, { choices: [], usage: { prompt_tokens: 11, completion_tokens: 5 } }],
		[null, '[DONE]'],
	], '\r\n')
	const p = createProvider(FAMILIES[1], { fetch: fakeFetch(sseRes(body, 5)).fetch })
	const evs = await collect(p.stream(req))
	expect(evs.filter((e) => e.type === 'done')).toHaveLength(1)
	expect(evs.at(-1)).toMatchObject({ type: 'done', result: { text: 'Hello', stopReason: 'end', usage: { inputTokens: 11, outputTokens: 5 } } })
	expect(evs.filter((e) => e.type === 'text').map((e: any) => e.text).join('')).toBe('Hello')
})

test('criterion 3: caller abort during a stream is rethrown as is, no AiError', async () => {
	const ctrl = new AbortController()
	const f = fakeFetch((c) => new Response(new ReadableStream({
		start(s) {
			s.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
			c.signal!.addEventListener('abort', () => s.error(new DOMException('aborted', 'AbortError')))
		},
	})))
	const p = createProvider({ ...FAMILIES[1], timeoutMs: 5000 }, { fetch: f.fetch })
	const e = await (async () => {
		for await (const ev of p.stream({ ...req, signal: ctrl.signal })) if (ev.type === 'text') ctrl.abort(new Error('stop it'))
	})().catch((e) => e)
	expect(e).not.toBeInstanceOf(AiError)
	expect(e.message).toBe('stop it')
})

test('criterion 3: an already aborted signal sends nothing', async () => {
	const ctrl = new AbortController()
	ctrl.abort(new Error('early'))
	for (const c of FAMILIES) {
		const f = fakeFetch()
		const p = createProvider(c, { fetch: f.fetch })
		expect(await p.complete({ ...req, signal: ctrl.signal }).catch((e) => e)).toMatchObject({ message: 'early' })
		expect(await collect(p.stream({ ...req, signal: ctrl.signal })).catch((e) => e)).toMatchObject({ message: 'early' })
		expect(f.calls).toHaveLength(0)
	}
})

test('criterion 5: key only in headers; never in url, body, or an error echoing it', async () => {
	for (const c of FAMILIES) {
		const ok = c.kind === 'anthropic'
			? jsonRes({ content: [{ type: 'text', text: 'ok' }], usage: {} })
			: jsonRes({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
		const f = fakeFetch(ok, jsonRes({ error: { message: `invalid key ${KEY} / Bearer ${KEY}` } }, 401), new Response(`echo ${KEY}`, { status: 500 }))
		const p = createProvider(c, { fetch: f.fetch })
		await p.complete(req)
		const e1 = await p.complete(req).catch((e) => e)
		const e2 = await p.complete(req).catch((e) => e)
		const hdr = c.kind === 'anthropic' ? f.calls[0].headers['x-api-key'] : f.calls[0].headers.authorization
		expect(hdr).toContain(KEY)
		expect(f.calls[0].url).not.toContain(KEY)
		expect(JSON.stringify(f.calls[0].body)).not.toContain(KEY)
		for (const e of [e1, e2]) {
			expect(e).toBeInstanceOf(AiError)
			expect(JSON.stringify(e) + e.message + e.stack).not.toContain(KEY)
		}
		expect(e1.code).toBe('auth')
		expect(e2.code).toBe('unavailable')
	}
})

test('criterion 5: testConnection error never contains the key either', async () => {
	const p = createProvider(FAMILIES[1], { fetch: fakeFetch(jsonRes({ error: { message: `bad ${KEY}` } }, 401)).fetch })
	const r = await p.testConnection()
	expect(r).toMatchObject({ ok: false, error: { code: 'auth' } })
	expect(JSON.stringify(r)).not.toContain(KEY)
})

test('criterion 6: invalid config -> AiError(invalid) and no request is sent', async () => {
	const f = fakeFetch()
	const bad: unknown[] = [
		{ kind: 'anthropic' }, { kind: 'openai' }, { kind: 'mistral', apiKey: '' },
		{ kind: 'openai-compatible' }, { kind: 'openai-compatible', baseUrl: '   ' },
		{ kind: 'nope', apiKey: 'k' },
	]
	for (const c of bad) {
		let e: unknown
		try { createProvider(c as ProviderConfig, { fetch: f.fetch }) } catch (x) { e = x }
		expect(e).toBeInstanceOf(AiError)
		expect((e as AiError).code).toBe('invalid')
	}
	expect(f.calls).toHaveLength(0)
})

test('criterion 6: openai-compatible without a key is allowed, sends no Authorization; ollama and mistral base URLs', async () => {
	const f = fakeFetch(jsonRes({ choices: [{ message: { content: 'a' }, finish_reason: 'stop' }] }), jsonRes({ choices: [{ message: { content: 'a' }, finish_reason: 'stop' }] }), jsonRes({ data: [] }))
	await createProvider({ kind: 'openai-compatible', baseUrl: 'http://gw:4000/v1/', defaultModel: 'm' }, { fetch: f.fetch }).complete(req)
	await createProvider({ kind: 'ollama', defaultModel: 'm' }, { fetch: f.fetch }).complete(req)
	await createProvider({ kind: 'mistral', apiKey: KEY }, { fetch: f.fetch }).listModels()
	expect(f.calls[0].url).toBe('http://gw:4000/v1/chat/completions')
	expect(f.calls[1].url).toBe('http://ollama:11434/v1/chat/completions')
	expect(f.calls[2].url).toBe('https://api.mistral.ai/v1/models')
	expect(f.calls[0].headers.authorization).toBeUndefined()
	expect(f.calls[1].headers.authorization).toBeUndefined()
	expect(f.calls[2].headers.authorization).toBe(`Bearer ${KEY}`)
})

test('criterion 8: testConnection / listModels only GET /models, never POST, even on failure', async () => {
	for (const c of FAMILIES) {
		const f = fakeFetch(jsonRes({ data: [{ id: 'a' }] }), jsonRes({ data: [{ id: 'a' }] }), jsonRes({}, 500))
		const p = createProvider(c, { fetch: f.fetch })
		expect(await p.listModels()).toEqual(['a'])
		expect(await p.testConnection()).toEqual({ ok: true, models: ['a'] })
		expect((await p.testConnection()).ok).toBe(false)
		expect(f.calls).toHaveLength(3)
		for (const call of f.calls) {
			expect(call.method).toBe('GET')
			expect(call.url).toMatch(/\/models(\?|$)/)
			expect(call.body).toBeUndefined()
		}
	}
})

test('criterion 8: a network failure in testConnection is reported, not thrown', async () => {
	const p = createProvider(FAMILIES[3], { fetch: fakeFetch(new TypeError('ECONNREFUSED')).fetch })
	expect(await p.testConnection()).toMatchObject({ ok: false, error: { code: 'unavailable' } })
})

test('criterion 7: mock failNext then a normal reply; errors also fail streams; abort', async () => {
	const m = createProvider({ kind: 'mock' })
	m.failNext('unavailable')
	m.failNext('auth', { message: 'nope', status: 403 })
	expect(await m.complete(req).catch((e) => e)).toMatchObject({ code: 'unavailable', status: 503 })
	expect(await collect(m.stream(req)).catch((e) => e)).toMatchObject({ code: 'auth', status: 403, message: expect.stringContaining('nope') })
	expect((await m.complete(req)).text).toBe('mock: x')
	expect(m.requests).toHaveLength(3)
	for (const code of ['budget', 'rate_limit', 'invalid'] as const) {
		m.failNext(code)
		expect(await m.complete(req).catch((e) => e)).toBeInstanceOf(AiError)
	}
	const ctrl = new AbortController()
	ctrl.abort(new Error('mock abort'))
	expect(await m.complete({ ...req, signal: ctrl.signal }).catch((e) => e)).toMatchObject({ message: 'mock abort' })
})

test('criterion 7: mock stream yields exactly one done, last, with usage', async () => {
	const m = createProvider({ kind: 'mock' })
	m.enqueue({ text: 'a b', usage: { inputTokens: 7, outputTokens: 2 } })
	const evs = await collect(m.stream(req))
	expect(evs.filter((e) => e.type === 'done')).toHaveLength(1)
	expect(evs.at(-1)).toMatchObject({ type: 'done', result: { usage: { inputTokens: 7, outputTokens: 2 } } })
})

test('criterion 2: tool call/result round trip through the mock request log', async () => {
	const m = createProvider({ kind: 'mock' })
	m.enqueue({ toolCalls: [{ id: 'c1', name: 'f', input: { a: 1 } }] })
	const r1 = await m.complete(req)
	const r2 = await m.complete({ messages: [
		...req.messages,
		{ role: 'assistant', content: r1.toolCalls.map((c) => ({ type: 'tool_call' as const, ...c })) },
		{ role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'r', isError: true }] },
	] })
	expect(r2.text).toBe('mock: r')
	expect(m.requests[1].messages[1].content).toEqual([{ type: 'tool_call', id: 'c1', name: 'f', input: { a: 1 } }])
})

test('criterion 9: nothing in server/index.ts or server/agent/ imports server/ai; no new dependency', () => {
	const root = join(import.meta.dir, '..')
	const files: string[] = [join(root, 'index.ts')]
	const walk = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n)
			if (statSync(p).isDirectory()) walk(p)
			else if (/\.(ts|tsx|js)$/.test(n)) files.push(p)
		}
	}
	if (existsSync(join(root, 'agent'))) walk(join(root, 'agent'))
	for (const f of files) {
		if (!existsSync(f)) continue
		expect(readFileSync(f, 'utf8')).not.toMatch(/from\s+['"][^'"]*\/ai(\/[^'"]*)?['"]|import\(['"][^'"]*\/ai['"]/)
	}
	// ai/ itself only imports relative files and node: builtins
	for (const n of readdirSync(import.meta.dir).filter((n) => n.endsWith('.ts'))) {
		const src = readFileSync(join(import.meta.dir, n), 'utf8')
		for (const m of src.matchAll(/from\s+'([^']+)'/g)) expect(m[1]).toMatch(/^(\.|node:|bun:)/)
	}
})
