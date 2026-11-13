// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OpenAI Chat Completions, also used as is by Mistral, Ollama (/v1) and any
// OpenAI-compatible endpoint (OpenRouter, LiteLLM, vLLM...). The few
// differences between them are switched on the kind.
import { AiError } from './errors'
import { type HttpCtx, join, json, parseArgs, send } from './http'
import { readSse } from './sse'
import { baseProvider, type Resolved } from './common'
import type { AiMessage, AiProvider, AiRequest, AiResult, AiStreamEvent, ProviderKind, StopReason, ToolCall, Usage } from './types'

/** Neutral messages -> chat messages. Tool results become their own `tool` messages. */
export function chatMessages(req: AiRequest): unknown[] {
	const out: unknown[] = req.system ? [{ role: 'system', content: req.system }] : []
	const push = (m: AiMessage) => {
		if (typeof m.content === 'string') {
			out.push({ role: m.role, content: m.content })
			return
		}
		const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
		if (m.role === 'assistant') {
			const calls = m.content.flatMap((b) => (b.type === 'tool_call' ? [b] : []))
			out.push({
				role: 'assistant',
				content: text || (calls.length ? null : ''),
				...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}),
			})
			return
		}
		// The API wants tool messages right after the assistant turn that asked for them.
		for (const b of m.content) {
			if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolCallId, content: b.isError ? `Error: ${b.content}` : b.content })
		}
		if (text) out.push({ role: 'user', content: text })
	}
	req.messages.forEach(push)
	return out
}

export function chatBody(kind: ProviderKind, req: AiRequest, model: string, stream: boolean) {
	return {
		model,
		messages: chatMessages(req),
		...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
		// OpenAI's newer models refuse max_tokens; the others only know max_tokens.
		...(req.maxTokens !== undefined ? { [kind === 'openai' ? 'max_completion_tokens' : 'max_tokens']: req.maxTokens } : {}),
		...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
		...(req.stop?.length ? { stop: req.stop } : {}),
		// Mistral sends usage in the last chunk anyway and rejects unknown fields.
		...(stream ? { stream: true, ...(kind === 'mistral' ? {} : { stream_options: { include_usage: true } }) } : {}),
	}
}

const STOP: Record<string, StopReason> = { stop: 'end', length: 'max_tokens', model_length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'error', error: 'error' }
const stopReason = (s: string | null | undefined): StopReason => STOP[s ?? ''] ?? 'end'
const usageOf = (u: any): Usage => ({ inputTokens: u?.prompt_tokens ?? 0, outputTokens: u?.completion_tokens ?? 0 })

// Some local servers omit tool call ids; a stable fallback keeps the round trip working.
const callId = (id: unknown, i: number): string => (typeof id === 'string' && id ? id : `call_${i}`)

/** Message content may be a string or (some compatible servers) a list of parts. */
function contentText(c: unknown): string {
	if (typeof c === 'string') return c
	if (Array.isArray(c)) return c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
	return ''
}

export function openaiProvider(r: Resolved): AiProvider {
	const ctx: HttpCtx = r.http
	const headers = (): Record<string, string> => ({
		'content-type': 'application/json',
		...r.headers,
		...(r.apiKey ? { authorization: `Bearer ${r.apiKey}` } : {}),
	})
	const post = (req: AiRequest, stream: boolean) => ({ method: 'POST', headers: headers(), body: JSON.stringify(chatBody(r.kind, req, r.model(req), stream)) })

	async function complete(req: AiRequest): Promise<AiResult> {
		const j = await json(ctx, join(r.baseUrl, '/chat/completions'), post(req, false), req.signal)
		const choice = j.choices?.[0]
		if (!choice) throw new AiError('unavailable', `${ctx.provider}: answer has no choices`, ctx.provider)
		const msg = choice.message ?? {}
		const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => ({ id: callId(c.id, i), name: c.function?.name ?? '', input: parseArgs(c.function?.arguments) }))
		let stop = stopReason(choice.finish_reason)
		// Ollama reports "stop" even when it called a tool.
		if (toolCalls.length && stop === 'end') stop = 'tool_use'
		return { text: contentText(msg.content), toolCalls, stopReason: stop, usage: usageOf(j.usage), model: j.model ?? r.model(req), raw: j }
	}

	async function* stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
		const s = await send(ctx, join(r.baseUrl, '/chat/completions'), post(req, true), req.signal)
		let text = ''
		let usage: Usage = { inputTokens: 0, outputTokens: 0 }
		let model = r.model(req)
		let finish: string | null = null
		let last: unknown
		// Tool calls arrive in pieces keyed by index; they are complete only at the end.
		const calls = new Map<number, { id?: string, name: string, args: string }>()
		try {
			for await (const ev of readSse(s.res.body!, s.touch)) {
				if (ev.data === '[DONE]') break
				if (ev.data === '') continue
				const d = JSON.parse(ev.data)
				last = d
				if (d.error) throw new AiError('unavailable', `${ctx.provider}: ${ctx.redact(String(d.error.message ?? 'stream error'))}`, ctx.provider)
				if (d.model) model = d.model
				if (d.usage) usage = usageOf(d.usage)
				for (const choice of d.choices ?? []) {
					const delta = choice.delta ?? {}
					const t = contentText(delta.content)
					if (t) {
						text += t
						yield { type: 'text', text: t }
					}
					for (const [pos, tc] of (delta.tool_calls ?? []).entries()) {
						const i = typeof tc.index === 'number' ? tc.index : calls.size + pos
						const c = calls.get(i) ?? { name: '', args: '' }
						if (tc.id) c.id = tc.id
						if (tc.function?.name) c.name += tc.function.name
						if (tc.function?.arguments) c.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments)
						calls.set(i, c)
					}
					if (choice.finish_reason) finish = choice.finish_reason
				}
			}
		} catch (e) {
			throw e instanceof SyntaxError ? s.fail(new AiError('unavailable', `${ctx.provider}: bad stream event`, ctx.provider)) : s.fail(e)
		} finally {
			s.close()
		}
		const toolCalls: ToolCall[] = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({ id: callId(c.id, i), name: c.name, input: parseArgs(c.args) }))
		for (const call of toolCalls) yield { type: 'tool_call', call }
		let stop = stopReason(finish)
		if (toolCalls.length && stop === 'end') stop = 'tool_use'
		yield { type: 'done', result: { text, toolCalls, stopReason: stop, usage, model, raw: last } }
	}

	async function listModels(): Promise<string[]> {
		const j = await json(ctx, join(r.baseUrl, '/models'), { method: 'GET', headers: headers() })
		return (j.data ?? []).map((m: any) => String(m.id))
	}

	return baseProvider(r, { complete, stream, listModels })
}
