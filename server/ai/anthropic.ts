// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Anthropic Messages API (POST /v1/messages), plain JSON and SSE.
import { baseProvider, modelIds, type Resolved, withUsage } from './common'
import { AiError, providerError } from './errors'
import { type HttpCtx, isPlainObject, join, json, parseArgs, send } from './http'
import { readSse } from './sse'
import type { AiMessage, AiProvider, AiRequest, AiResult, AiStreamEvent, ContentBlock, StopReason, ToolCall, ToolChoice, Usage } from './types'

export const ANTHROPIC_VERSION = '2023-06-01'
export const DEFAULT_MAX_TOKENS = 4096

function wireBlock(b: ContentBlock) {
	switch (b.type) {
		case 'text': return { type: 'text', text: b.text }
		// Malformed JSON from a model is kept as a string in ToolCall.input; the API wants an object.
		case 'tool_call': return { type: 'tool_use', id: b.id, name: b.name, input: isPlainObject(b.input) ? b.input : {} }
		case 'tool_result': return { type: 'tool_result', tool_use_id: b.toolCallId, content: b.content, ...(b.isError ? { is_error: true } : {}) }
	}
}

function wireMessage(m: AiMessage) {
	if (typeof m.content === 'string') return { role: m.role, content: m.content }
	// The API rejects empty text blocks, and wants tool results before any text in a user turn.
	const blocks = m.content.filter((b) => b.type !== 'text' || b.text !== '')
	const ordered = [...blocks.filter((b) => b.type === 'tool_result'), ...blocks.filter((b) => b.type !== 'tool_result')]
	return { role: m.role, content: ordered.map(wireBlock) }
}

function toolChoice(c: ToolChoice | undefined) {
	if (c === undefined) return undefined
	if (typeof c === 'object') return { type: 'tool', name: c.name }
	return { type: c === 'required' ? 'any' : c }
}

export function anthropicBody(req: AiRequest, model: string, stream: boolean) {
	const tools = req.tools?.length ? req.tools : undefined
	const choice = tools ? toolChoice(req.toolChoice) : undefined
	return {
		model,
		max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
		...(req.system ? { system: req.system } : {}),
		// A turn whose blocks were all empty text would be content: [] (400): leave it out.
		messages: req.messages.map(wireMessage).filter((m) => typeof m.content === 'string' || m.content.length > 0),
		...(tools ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
		...(choice ? { tool_choice: choice } : {}),
		...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
		...(req.stop?.length ? { stop_sequences: req.stop } : {}),
		...(stream ? { stream: true } : {}),
	}
}

const STOP: Record<string, StopReason> = {
	end_turn: 'end', max_tokens: 'max_tokens', model_context_window_exceeded: 'max_tokens',
	tool_use: 'tool_use', stop_sequence: 'stop', pause_turn: 'stop', refusal: 'error',
}
// Unknown reasons are 'stop', not 'end': the caller should not take them for a normal finish.
const stopReason = (s: string | null | undefined): StopReason => (s ? STOP[s] ?? 'stop' : 'end')

function usageOf(u: any, into: Usage = { inputTokens: 0, outputTokens: 0, reported: false }): Usage {
	if (!u || typeof u !== 'object') return into
	const read = u.cache_read_input_tokens ?? into.cacheReadTokens ?? 0
	const write = u.cache_creation_input_tokens ?? into.cacheWriteTokens ?? 0
	// input_tokens excludes cached tokens, which are billed input too: the total counts them.
	const base = u.input_tokens ?? (into.inputTokens - (into.cacheReadTokens ?? 0) - (into.cacheWriteTokens ?? 0))
	return {
		inputTokens: base + read + write,
		outputTokens: u.output_tokens ?? into.outputTokens,
		...(read ? { cacheReadTokens: read } : {}),
		...(write ? { cacheWriteTokens: write } : {}),
		reported: true,
	}
}

export function anthropicProvider(r: Resolved): AiProvider {
	const ctx: HttpCtx = r.http
	const headers = (): Record<string, string> => ({
		'content-type': 'application/json',
		'anthropic-version': ANTHROPIC_VERSION,
		...r.headers,
		...(r.apiKey ? { 'x-api-key': r.apiKey } : {}),
	})
	const post = (req: AiRequest, stream: boolean) => ({ method: 'POST', headers: headers(), body: JSON.stringify(anthropicBody(req, r.model(req), stream)) })

	async function complete(req: AiRequest): Promise<AiResult> {
		const j = await json(ctx, join(r.baseUrl, '/v1/messages'), post(req, false), req.signal)
		if (j?.type === 'error') throw providerError(ctx.provider, undefined, j, ctx.redact)
		let text = ''
		const toolCalls: ToolCall[] = []
		for (const b of Array.isArray(j?.content) ? j.content : []) {
			if (b.type === 'text') text += b.text
			else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: b.input ?? {} })
		}
		return {
			text,
			toolCalls,
			stopReason: stopReason(j.stop_reason),
			providerStopReason: j.stop_reason ?? undefined,
			usage: usageOf(j.usage),
			model: j.model ?? r.model(req),
			raw: j,
		}
	}

	async function* stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
		const s = await send(ctx, join(r.baseUrl, '/v1/messages'), post(req, true), req.signal)
		let text = ''
		const toolCalls: ToolCall[] = []
		let usage: Usage = { inputTokens: 0, outputTokens: 0, reported: false }
		let model = r.model(req)
		let rawStop: string | undefined
		let stopped = false
		let last: unknown
		// Per content block index: tool_use blocks collect their JSON input in pieces.
		const blocks = new Map<number, { id: string, name: string, json: string }>()
		try {
			for await (const ev of readSse(s.res.body!, s.sse)) {
				if (ev.data === '' || ev.event === 'ping') continue
				const d = JSON.parse(ev.data)
				last = d
				switch (d.type) {
					case 'message_start':
						model = d.message?.model ?? model
						usage = usageOf(d.message?.usage, usage)
						break
					case 'content_block_start':
						if (d.content_block?.type === 'tool_use') blocks.set(d.index, { id: d.content_block.id, name: d.content_block.name, json: '' })
						else if (d.content_block?.type === 'text' && d.content_block.text) {
							text += d.content_block.text
							yield { type: 'text', text: d.content_block.text }
						}
						break
					case 'content_block_delta':
						if (d.delta?.type === 'text_delta' && d.delta.text) {
							text += d.delta.text
							yield { type: 'text', text: d.delta.text }
						} else if (d.delta?.type === 'input_json_delta') {
							const b = blocks.get(d.index)
							if (b) b.json += d.delta.partial_json ?? ''
						}
						break
					case 'content_block_stop': {
						const b = blocks.get(d.index)
						if (b) {
							blocks.delete(d.index)
							const call = { id: b.id, name: b.name, input: parseArgs(b.json) }
							toolCalls.push(call)
							yield { type: 'tool_call', call }
						}
						break
					}
					case 'message_delta':
						if (d.delta?.stop_reason) rawStop = d.delta.stop_reason
						usage = usageOf(d.usage, usage)
						break
					case 'message_stop':
						stopped = true
						break
					case 'error':
						// Mid-stream errors (overloaded_error, ...) come as an event, not a status.
						throw providerError(ctx.provider, undefined, d, ctx.redact)
				}
			}
			// A cut connection can look like a clean end of body: only message_stop says it is complete.
			if (!stopped || blocks.size) throw new AiError('unavailable', `${ctx.provider}: stream ended before message_stop`, ctx.provider)
		} catch (e) {
			throw withUsage(e instanceof SyntaxError ? s.fail(new AiError('unavailable', `${ctx.provider}: bad stream event`, ctx.provider)) : s.fail(e), usage, req.onUsage)
		} finally {
			s.close()
		}
		yield { type: 'done', result: { text, toolCalls, stopReason: stopReason(rawStop), providerStopReason: rawStop, usage, model, raw: last } }
	}

	async function listModels(): Promise<string[]> {
		return modelIds(ctx.provider, await json(ctx, join(r.baseUrl, '/v1/models?limit=1000'), { method: 'GET', headers: headers() }))
	}

	return baseProvider(r, { complete, stream, listModels })
}
