// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Usage reporting (AiRequest.onUsage) and the review's last should-fix items.
import { expect, test } from 'bun:test'
import { anthropicBody } from './anthropic'
import { readCapped } from './http'
import { AiError, createProvider } from './index'
import { fakeFetch } from './testkit'
import type { Usage } from './types'

const KEY = 'sk-test-usage'
const msg = { messages: [{ role: 'user' as const, content: 'hi' }] }

function anthropicStream(input: number, abortable = false) {
	return (c: { signal?: AbortSignal | null }) => new Response(new ReadableStream({
		start(s) {
			s.enqueue(new TextEncoder().encode(`data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":${input},"output_tokens":1}}}\n\n`))
			s.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'))
			if (abortable) c.signal?.addEventListener('abort', () => s.error(new DOMException('aborted', 'AbortError')))
			else s.close() // cut before message_stop
		},
	}))
}

test('onUsage: called once on complete, once at the end of a stream (mock and real kinds)', async () => {
	const mock = createProvider({ kind: 'mock' })
	const seen: Usage[] = []
	await mock.complete({ ...msg, onUsage: (u) => seen.push(u) })
	for await (const _ of mock.stream({ ...msg, onUsage: (u) => seen.push(u) })) { /* drain */ }
	expect(seen.length).toBe(2)
	expect(seen.every((u) => u.reported && u.inputTokens > 0)).toBe(true)

	const f = fakeFetch(() => Response.json({ id: 'x', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 2 } }))
	const p = createProvider({ kind: 'anthropic', apiKey: KEY, defaultModel: 'm' }, { fetch: f.fetch })
	const got: Usage[] = []
	await p.complete({ ...msg, onUsage: (u) => got.push(u) })
	expect(got).toEqual([{ inputTokens: 7, outputTokens: 2, reported: true }])
})

test('onUsage: one signal cancelling two parallel streams reports each call\'s own usage', async () => {
	const ctrl = new AbortController()
	const p = createProvider({ kind: 'anthropic', apiKey: KEY, defaultModel: 'm' }, {
		fetch: fakeFetch((c) => anthropicStream(c.body.max_tokens, true)(c), (c) => anthropicStream(c.body.max_tokens, true)(c)).fetch,
	})
	const a: Usage[] = []
	const b: Usage[] = []
	const run = (n: number, sink: Usage[]) => (async () => {
		for await (const ev of p.stream({ ...msg, maxTokens: n, signal: ctrl.signal, onUsage: (u) => sink.push(u) })) if (ev.type === 'text') await Bun.sleep(5)
	})().catch(() => {})
	const both = Promise.all([run(100, a), run(200, b)])
	await Bun.sleep(20)
	ctrl.abort() // default DOMException reason, shared by both calls
	await both
	expect(a).toEqual([{ inputTokens: 100, outputTokens: 1, reported: true }])
	expect(b).toEqual([{ inputTokens: 200, outputTokens: 1, reported: true }])
})

test('onUsage: a stream failing mid-way reports its partial usage once, and the AiError keeps it too', async () => {
	const p = createProvider({ kind: 'anthropic', apiKey: KEY, defaultModel: 'm' }, { fetch: fakeFetch(anthropicStream(9)).fetch })
	const seen: Usage[] = []
	const e = await (async () => { for await (const _ of p.stream({ ...msg, onUsage: (u) => seen.push(u) })) { /* ends without message_stop */ } })().catch((e) => e)
	expect(e).toBeInstanceOf(AiError)
	expect(e.usage).toEqual({ inputTokens: 9, outputTokens: 1, reported: true })
	expect(seen).toEqual([{ inputTokens: 9, outputTokens: 1, reported: true }])
})

test('onUsage: a throwing callback never breaks the call', async () => {
	const mock = createProvider({ kind: 'mock' })
	const r = await mock.complete({ ...msg, onUsage: () => { throw new Error('bookkeeping bug') } })
	expect(r.text.length).toBeGreaterThan(0)
})

test('JSON size cap: the body stream is cancelled before the error (no socket left open)', async () => {
	let cancelled = false
	const big = new ReadableStream({
		pull(s) { s.enqueue(new Uint8Array(64 * 1024)) },
		cancel() { cancelled = true },
	})
	const e = await readCapped(new Response(big), 256 * 1024).catch((e) => e)
	expect(e).toBeInstanceOf(RangeError)
	expect(cancelled).toBe(true)
})

test('anthropic: a turn whose blocks are all empty text is left out, not sent as content: []', () => {
	const body = anthropicBody({ messages: [
		{ role: 'user', content: 'q' },
		{ role: 'assistant', content: [{ type: 'text', text: '' }] },
		{ role: 'user', content: 'again' },
	] }, 'm', false)
	expect(body.messages).toEqual([{ role: 'user', content: 'q' }, { role: 'user', content: 'again' }])
})
