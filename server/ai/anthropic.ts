// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Anthropic Messages API (POST /v1/messages), plain JSON and SSE.
import { AiError } from './errors'
import { type HttpCtx, join, json, parseArgs, send } from './http'
import { readSse } from './sse'
import type { AiMessage, AiProvider, AiRequest, AiResult, AiStreamEvent, StopReason, ToolCall, Usage } from './types'
import { baseProvider, type Resolved } from './common'

export const ANTHROPIC_VERSION = '2023-06-01'
export const DEFAULT_MAX_TOKENS = 4096

function wireMessage(m: AiMessage) {
	if (typeof m.content === 'string') return { role: m.role, content: m.content }
	return {
		role: m.role,
		content: m.content.map((b) => {
			switch (b.type) {
				case 'text': return { type: 'text', text: b.text }
				case 'tool_call': return { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} }
				case 'tool_result': return { type: 'tool_result', tool_use_id: b.toolCallId, content: b.content, ...(b.isError ? { is_error: true } : {}) }
			}
		}),
	}
}

export function anthropicBody(req: AiRequest, model: string, stream: boolean) {
	return {
		model,
		max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
		...(req.system ? { system: req.system } : {}),
		messages: req.messages.map(wireMessage),
		...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
		...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
		...(req.stop?.length ? { stop_sequences: req.stop } : {}),
		...(stream ? { stream: true } : {}),
	}
}

const STOP: Record<string, StopReason> = { end_turn: 'end', max_tokens: 'max_tokens', tool_use: 'tool_use', stop_sequence: 'stop', refusal: 'error' }
const stopReason = (s: string | null | undefined): StopReason => STOP[s ?? ''] ?? 'end'

// Cached prompt tokens are billed input too: budgets must count them.
const inputTokens = (u: any): number => (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0)

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
		let text = ''
		const toolCalls: ToolCall[] = []
		for (const b of j.content ?? []) {
			if (b.type === 'text') text += b.text
			else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: b.input ?? {} })
		}
		return {
			text,
			toolCalls,
			stopReason: stopReason(j.stop_reason),
			usage: { inputTokens: inputTokens(j.usage), outputTokens: j.usage?.output_tokens ?? 0 },
			model: j.model ?? r.model(req),
			raw: j,
		}
	}

	async function* stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
		const s = await send(ctx, join(r.baseUrl, '/v1/messages'), post(req, true), req.signal)
		let text = ''
		const toolCalls: ToolCall[] = []
		const usage: Usage = { inputTokens: 0, outputTokens: 0 }
		let model = r.model(req)
		let stop: StopReason = 'end'
		let last: unknown
		// Per content block index: tool_use blocks collect their JSON input in pieces.
		const blocks = new Map<number, { id: string, name: string, json: string }>()
		try {
			for await (const ev of readSse(s.res.body!, s.touch)) {
				if (ev.data === '' || ev.event === 'ping') continue
				const d = JSON.parse(ev.data)
				last = d
				switch (d.type) {
					case 'message_start':
						model = d.message?.model ?? model
						usage.inputTokens = inputTokens(d.message?.usage)
						usage.outputTokens = d.message?.usage?.output_tokens ?? 0
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
						if (d.delta?.stop_reason) stop = stopReason(d.delta.stop_reason)
						if (d.usage?.output_tokens !== undefined) usage.outputTokens = d.usage.output_tokens
						if (d.usage?.input_tokens !== undefined) usage.inputTokens = inputTokens(d.usage)
						break
					case 'error': {
						// Mid-stream errors (overloaded_error, ...) come as an event, not a status.
						const t = String(d.error?.type ?? '')
						const code = t === 'rate_limit_error' ? 'rate_limit' : t === 'authentication_error' || t === 'permission_error' ? 'auth' : t === 'invalid_request_error' ? 'invalid' : 'unavailable'
						throw new AiError(code, `anthropic: ${ctx.redact(String(d.error?.message ?? t ?? 'stream error'))}`, ctx.provider)
					}
				}
			}
		} catch (e) {
			throw e instanceof SyntaxError ? s.fail(new AiError('unavailable', `${ctx.provider}: bad stream event`, ctx.provider)) : s.fail(e)
		} finally {
			s.close()
		}
		yield { type: 'done', result: { text, toolCalls, stopReason: stop, usage, model, raw: last } }
	}

	async function listModels(): Promise<string[]> {
		const j = await json(ctx, join(r.baseUrl, '/v1/models?limit=1000'), { method: 'GET', headers: headers() })
		return (j.data ?? []).map((m: any) => String(m.id))
	}

	return baseProvider(r, { complete, stream, listModels })
}
