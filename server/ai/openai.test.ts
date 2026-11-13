// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import { createProvider, type AiMessage, type ProviderConfig, type ToolDef } from './index'
import { collect, fakeFetch, jsonRes, sse, sseRes } from './testkit'

const KEY = 'sk-test-not-a-real-key'
const tools: ToolDef[] = [{ name: 'search_mail', description: 'Search mail', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }]

const provider = (config: Partial<ProviderConfig>, ...canned: Parameters<typeof fakeFetch>) => {
	const f = fakeFetch(...canned)
	return { p: createProvider({ kind: 'openai', apiKey: KEY, defaultModel: 'gpt-4.1-mini', ...config } as ProviderConfig, { fetch: f.fetch }), calls: f.calls }
}

const completion = (message: unknown, finish = 'stop', usage = { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }) =>
	jsonRes({ id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-4.1-mini-2025-04-14', choices: [{ index: 0, message, finish_reason: finish }], usage })

test('openai: complete with text, wire format of the request', async () => {
	const { p, calls } = provider({}, completion({ role: 'assistant', content: 'Hello Alice' }))
	const r = await p.complete({ system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 50, temperature: 0, stop: ['END'] })
	expect(r).toMatchObject({ text: 'Hello Alice', toolCalls: [], stopReason: 'end', usage: { inputTokens: 9, outputTokens: 4 }, model: 'gpt-4.1-mini-2025-04-14' })
	const c = calls[0]
	expect(c.url).toBe('https://api.openai.com/v1/chat/completions')
	expect(c.headers.authorization).toBe(`Bearer ${KEY}`)
	expect(c.body).toEqual({ model: 'gpt-4.1-mini', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }], max_completion_tokens: 50, temperature: 0, stop: ['END'] })
})

test('openai: tool calls in, tool results back as tool messages', async () => {
	const { p, calls } = provider({},
		completion({ role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'search_mail', arguments: '{"q":"invoice"}' } }] }, 'tool_calls'),
		completion({ role: 'assistant', content: 'Found 2.' }),
	)
	const messages: AiMessage[] = [{ role: 'user', content: 'Any invoices?' }]
	const r1 = await p.complete({ messages, tools })
	expect(r1).toMatchObject({ text: '', stopReason: 'tool_use', toolCalls: [{ id: 'call_abc', name: 'search_mail', input: { q: 'invoice' } }] })
	expect(calls[0].body.tools).toEqual([{ type: 'function', function: { name: 'search_mail', description: 'Search mail', parameters: tools[0].inputSchema } }])

	messages.push(
		{ role: 'assistant', content: r1.toolCalls.map((c) => ({ type: 'tool_call' as const, ...c })) },
		{ role: 'user', content: [{ type: 'tool_result', toolCallId: 'call_abc', content: '2 mails' }, { type: 'tool_result', toolCallId: 'call_def', content: 'boom', isError: true }, { type: 'text', text: 'Thanks' }] },
	)
	await p.complete({ messages, tools })
	expect(calls[1].body.messages.slice(1)).toEqual([
		{ role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'search_mail', arguments: '{"q":"invoice"}' } }] },
		{ role: 'tool', tool_call_id: 'call_abc', content: '2 mails' },
		{ role: 'tool', tool_call_id: 'call_def', content: 'Error: boom' },
		{ role: 'user', content: 'Thanks' },
	])
})

test('openai: streaming text + tool call pieces + usage chunk, [DONE]', async () => {
	const chunk = (delta: unknown, finish: string | null = null) => [null, { id: 'c', object: 'chat.completion.chunk', model: 'gpt-4.1', choices: [{ index: 0, delta, finish_reason: finish }] }] as [null, unknown]
	const body = sse([
		chunk({ role: 'assistant', content: '' }),
		chunk({ content: 'Bon' }),
		chunk({ content: 'jour €' }),
		chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search_mail', arguments: '' } }] }),
		chunk({ tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }),
		chunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
		chunk({}, 'tool_calls'),
		[null, { id: 'c', object: 'chat.completion.chunk', model: 'gpt-4.1', choices: [], usage: { prompt_tokens: 30, completion_tokens: 12 } }],
		[null, '[DONE]'],
	])
	const { p, calls } = provider({}, sseRes(body, 3))
	const evs = await collect(p.stream({ messages: [{ role: 'user', content: 'go' }], tools }))
	expect(calls[0].body).toMatchObject({ stream: true, stream_options: { include_usage: true } })
	expect(evs.filter((e) => e.type === 'text').map((e) => (e as any).text).join('')).toBe('Bonjour €')
	const call = { id: 'call_1', name: 'search_mail', input: { q: 'x' } }
	expect(evs.filter((e) => e.type === 'tool_call')).toEqual([{ type: 'tool_call', call }])
	expect(evs.at(-1)).toMatchObject({ type: 'done', result: { text: 'Bonjour €', toolCalls: [call], stopReason: 'tool_use', usage: { inputTokens: 30, outputTokens: 12 }, model: 'gpt-4.1' } })
})

test('mistral: own base URL, max_tokens, no stream_options', async () => {
	const { p, calls } = provider({ kind: 'mistral', defaultModel: 'mistral-small-latest' },
		completion({ role: 'assistant', content: 'ok' }),
		sseRes(sse([[null, { model: 'mistral-small-latest', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }], [null, '[DONE]']])),
	)
	await p.complete({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 })
	expect(calls[0].url).toBe('https://api.mistral.ai/v1/chat/completions')
	expect(calls[0].body.max_tokens).toBe(10)
	expect(calls[0].body.max_completion_tokens).toBeUndefined()
	const evs = await collect(p.stream({ messages: [{ role: 'user', content: 'x' }] }))
	expect(calls[1].body.stream_options).toBeUndefined()
	expect(evs.at(-1)).toMatchObject({ type: 'done', result: { text: 'ok', usage: { inputTokens: 3, outputTokens: 1 } } })
})

test('ollama: no key needed, default base URL, tool call without id and finish "stop"', async () => {
	const { p, calls } = provider({ kind: 'ollama', apiKey: undefined, defaultModel: 'llama3.2' },
		completion({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_mail', arguments: '{"q":"a"}' } }] }, 'stop'),
	)
	const r = await p.complete({ messages: [{ role: 'user', content: 'x' }], tools })
	expect(calls[0].url).toBe('http://ollama:11434/v1/chat/completions')
	expect(calls[0].headers.authorization).toBeUndefined()
	expect(r.stopReason).toBe('tool_use')
	expect(r.toolCalls).toEqual([{ id: 'call_0', name: 'search_mail', input: { q: 'a' } }])
})

test('openai-compatible: custom base URL and headers, broken tool JSON kept raw', async () => {
	const { p, calls } = provider({ kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1/', headers: { 'X-Title': 'Atrium' } },
		completion({ role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'search_mail', arguments: '{"q": "unterminated' } }] }, 'tool_calls'),
		jsonRes({ object: 'list', data: [{ id: 'anthropic/claude-sonnet-4.5' }, { id: 'openai/gpt-4.1' }] }),
	)
	const r = await p.complete({ messages: [{ role: 'user', content: 'x' }], tools })
	expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions')
	expect(calls[0].headers['x-title']).toBe('Atrium')
	expect(r.toolCalls[0].input).toBe('{"q": "unterminated')
	expect(await p.listModels()).toEqual(['anthropic/claude-sonnet-4.5', 'openai/gpt-4.1'])
	expect(calls[1].url).toBe('https://openrouter.ai/api/v1/models')
})
