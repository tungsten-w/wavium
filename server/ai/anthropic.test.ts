// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import { createProvider, type AiMessage, type AiStreamEvent, type ToolDef } from './index'
import { collect, fakeFetch, jsonRes, sse, sseRes } from './testkit'

const KEY = 'sk-ant-test-not-a-real-key'
const tools: ToolDef[] = [{ name: 'search_mail', description: 'Search mail', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }]

const provider = (...canned: Parameters<typeof fakeFetch>) => {
	const f = fakeFetch(...canned)
	return { p: createProvider({ kind: 'anthropic', apiKey: KEY, defaultModel: 'claude-sonnet-4-5' }, { fetch: f.fetch }), calls: f.calls }
}

test('anthropic: complete with text, wire format of the request', async () => {
	const { p, calls } = provider(jsonRes({
		id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929',
		content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'Alice' }],
		stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 5 },
	}))
	const r = await p.complete({ system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 100, temperature: 0.2, stop: ['END'] })
	expect(r).toMatchObject({ text: 'Hello Alice', toolCalls: [], stopReason: 'end', usage: { inputTokens: 17, outputTokens: 3 }, model: 'claude-sonnet-4-5-20250929' })
	const c = calls[0]
	expect(c.url).toBe('https://api.anthropic.com/v1/messages')
	expect(c.method).toBe('POST')
	expect(c.headers['x-api-key']).toBe(KEY)
	expect(c.headers['anthropic-version']).toBe('2023-06-01')
	expect(c.headers.authorization).toBeUndefined()
	expect(c.body).toEqual({ model: 'claude-sonnet-4-5', max_tokens: 100, system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }], temperature: 0.2, stop_sequences: ['END'] })
})

test('anthropic: tool calls in, tool results back in the right blocks', async () => {
	const { p, calls } = provider(
		jsonRes({ model: 'm', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'toolu_01', name: 'search_mail', input: { q: 'invoice' } }], stop_reason: 'tool_use', usage: { input_tokens: 50, output_tokens: 20 } }),
		jsonRes({ model: 'm', content: [{ type: 'text', text: 'Found 2.' }], stop_reason: 'end_turn', usage: { input_tokens: 80, output_tokens: 4 } }),
	)
	const messages: AiMessage[] = [{ role: 'user', content: 'Any invoices?' }]
	const r1 = await p.complete({ messages, tools })
	expect(r1.stopReason).toBe('tool_use')
	expect(r1.toolCalls).toEqual([{ id: 'toolu_01', name: 'search_mail', input: { q: 'invoice' } }])
	expect(calls[0].body.tools).toEqual([{ name: 'search_mail', description: 'Search mail', input_schema: tools[0].inputSchema }])
	expect(calls[0].body.max_tokens).toBe(4096)

	messages.push(
		{ role: 'assistant', content: [{ type: 'text', text: r1.text }, ...r1.toolCalls.map((c) => ({ type: 'tool_call' as const, ...c }))] },
		{ role: 'user', content: [{ type: 'tool_result', toolCallId: 'toolu_01', content: '2 mails' }, { type: 'tool_result', toolCallId: 'toolu_02', content: 'boom', isError: true }] },
	)
	const r2 = await p.complete({ messages, tools })
	expect(r2.text).toBe('Found 2.')
	expect(calls[1].body.messages.slice(1)).toEqual([
		{ role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'toolu_01', name: 'search_mail', input: { q: 'invoice' } }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '2 mails' }, { type: 'tool_result', tool_use_id: 'toolu_02', content: 'boom', is_error: true }] },
	])
})

test('anthropic: streaming text + tool call + usage, split into small chunks', async () => {
	const body = sse([
		['message_start', { type: 'message_start', message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 25, output_tokens: 1 } } }],
		['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
		['ping', { type: 'ping' }],
		['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bonjour ' } }],
		['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'é€!' } }],
		['content_block_stop', { type: 'content_block_stop', index: 0 }],
		['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'search_mail', input: {} } }],
		['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q": "inv' } }],
		['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'oice"}' } }],
		['content_block_stop', { type: 'content_block_stop', index: 1 }],
		['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }],
		['message_stop', { type: 'message_stop' }],
	], '\r\n')
	const { p, calls } = provider(sseRes(body, 5))
	const evs = await collect(p.stream({ messages: [{ role: 'user', content: 'go' }], tools }))
	expect(calls[0].body.stream).toBe(true)
	expect(evs.filter((e) => e.type === 'text').map((e) => (e as any).text).join('')).toBe('Bonjour é€!')
	const call = { id: 'toolu_9', name: 'search_mail', input: { q: 'invoice' } }
	expect(evs.filter((e) => e.type === 'tool_call')).toEqual([{ type: 'tool_call', call }])
	const done = evs.at(-1) as Extract<AiStreamEvent, { type: 'done' }>
	expect(done.type).toBe('done')
	expect(done.result).toMatchObject({ text: 'Bonjour é€!', toolCalls: [call], stopReason: 'tool_use', usage: { inputTokens: 25, outputTokens: 42 }, model: 'claude-x' })
})

test('anthropic: error event in the middle of a stream', async () => {
	const body = sse([
		['message_start', { type: 'message_start', message: { model: 'm', usage: { input_tokens: 1 } } }],
		['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
	])
	const { p } = provider(sseRes(body))
	const err = await collect(p.stream({ messages: [{ role: 'user', content: 'go' }] })).catch((e) => e)
	expect(err).toMatchObject({ name: 'AiError', code: 'unavailable', provider: 'anthropic' })
})

test('anthropic: low credit balance (400) is a budget error, not invalid', async () => {
	const { p } = provider(jsonRes({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 400))
	const err = await p.complete({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e)
	expect(err).toMatchObject({ code: 'budget', status: 400 })
})

test('anthropic: listModels / testConnection', async () => {
	const { p, calls } = provider(
		jsonRes({ data: [{ id: 'claude-opus-4-1', type: 'model' }, { id: 'claude-haiku-4-5', type: 'model' }] }),
		jsonRes({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401),
	)
	expect(await p.testConnection()).toEqual({ ok: true, models: ['claude-opus-4-1', 'claude-haiku-4-5'] })
	expect(calls[0].url).toStartWith('https://api.anthropic.com/v1/models')
	expect(calls[0].method).toBe('GET')
	const bad = await p.testConnection()
	expect(bad.ok).toBe(false)
	expect(bad.error?.code).toBe('auth')
})

// --- after review (round 2) ---

const start = ['message_start', { type: 'message_start', message: { model: 'm', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } } }] as [string, unknown]
const textBlock = (t: string): Array<[string, unknown]> => [
	['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
	['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }],
	['content_block_stop', { type: 'content_block_stop', index: 0 }],
]

test('anthropic: a stream cut before message_stop is unavailable, with the usage known so far', async () => {
	const { p } = provider(sseRes(sse([start, ...textBlock('half'), ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }]])))
	const e = await collect(p.stream({ messages: [{ role: 'user', content: 'go' }] })).catch((e) => e)
	expect(e).toMatchObject({ code: 'unavailable', message: expect.stringContaining('message_stop') })
	expect(e.usage).toEqual({ inputTokens: 16, outputTokens: 7, cacheReadTokens: 4, cacheWriteTokens: 2, reported: true })
})

test('anthropic: an unterminated tool_use block is an error, not dropped silently', async () => {
	const { p } = provider(sseRes(sse([
		start,
		['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'f', input: {} } }],
		['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } }],
		['message_stop', { type: 'message_stop' }],
	])))
	expect(await collect(p.stream({ messages: [{ role: 'user', content: 'go' }] })).catch((e) => e)).toMatchObject({ code: 'unavailable' })
})

test('anthropic: credit balance error event mid-stream is budget, like the HTTP one', async () => {
	const { p } = provider(sseRes(sse([start, ['error', { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }]])))
	const e = await collect(p.stream({ messages: [{ role: 'user', content: 'go' }] })).catch((e) => e)
	expect(e).toMatchObject({ code: 'budget', status: undefined })
	expect(e.usage.inputTokens).toBe(16)
})

test('anthropic: tool_result blocks first, empty text dropped, malformed tool input sent as {}', async () => {
	const { p, calls } = provider(jsonRes({ model: 'm', content: [], stop_reason: 'end_turn', usage: {} }))
	await p.complete({ messages: [
		{ role: 'user', content: 'go' },
		{ role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'tool_call', id: 't1', name: 'f', input: '{"broken' }] },
		{ role: 'user', content: [{ type: 'text', text: 'and also' }, { type: 'tool_result', toolCallId: 't1', content: 'r' }] },
	] })
	expect(calls[0].body.messages.slice(1)).toEqual([
		{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }, { type: 'text', text: 'and also' }] },
	])
})

test('anthropic: toolChoice mapping, omitted without tools', async () => {
	const ok = () => jsonRes({ model: 'm', content: [], stop_reason: 'end_turn', usage: {} })
	const { p, calls } = provider(ok(), ok(), ok(), ok(), ok())
	for (const toolChoice of ['auto', 'none', 'required', { name: 'search_mail' }] as const) await p.complete({ messages: [{ role: 'user', content: 'x' }], tools, toolChoice })
	await p.complete({ messages: [{ role: 'user', content: 'x' }], toolChoice: 'required' })
	expect(calls.map((c) => c.body.tool_choice)).toEqual([{ type: 'auto' }, { type: 'none' }, { type: 'any' }, { type: 'tool', name: 'search_mail' }, undefined])
})

test('anthropic: stop reasons (context window, pause_turn, unknown) and cache usage', async () => {
	const res = (stop_reason: string) => jsonRes({ model: 'm', content: [], stop_reason, usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 100 } })
	const { p } = provider(res('model_context_window_exceeded'), res('pause_turn'), res('something_new'), res('refusal'))
	const got = []
	for (let i = 0; i < 4; i++) got.push(await p.complete({ messages: [{ role: 'user', content: 'x' }] }))
	expect(got.map((r) => r.stopReason)).toEqual(['max_tokens', 'stop', 'stop', 'error'])
	expect(got[2].providerStopReason).toBe('something_new')
	expect(got[0].usage).toEqual({ inputTokens: 103, outputTokens: 1, cacheReadTokens: 100, reported: true })
})

test('anthropic: listModels on an unexpected shape is unavailable, not a TypeError', async () => {
	const { p } = provider(jsonRes({ models: 'nope' }))
	expect(await p.listModels().catch((e) => e)).toMatchObject({ name: 'AiError', code: 'unavailable' })
})
