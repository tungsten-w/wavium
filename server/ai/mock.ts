// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mock provider for tests and the dev stack (rule A2: no real key anywhere).
// Deterministic, no network. Script it with queued replies or errors; it
// records every request. With nothing queued it answers "mock: <last user text>",
// or, when the request forces a tool ({name}), calls that tool with a sample
// input built from its schema (first enum value, 0.5, ...), like a real model must.
import { testConnection, trackUsage } from './common'
import { demoAnswer } from './demo'
import { AiError, type AiErrorCode } from './errors'
import type { AiProvider, AiRequest, AiResult, AiStreamEvent, StopReason, ToolCall, Usage } from './types'

export interface MockReply {
	text?: string
	toolCalls?: Array<{ id?: string, name: string, input?: unknown }>
	stopReason?: StopReason
	usage?: Partial<Usage>
	model?: string
}

export interface MockError { error: { code: AiErrorCode, message?: string, status?: number, retryAfter?: number } }

export type MockScript = MockReply | MockError | ((req: AiRequest) => MockReply | MockError)

export interface MockProvider extends AiProvider {
	/** Every request received, in order (signal left out). */
	readonly requests: AiRequest[]
	/** Queues replies used one per call, before the default echo. */
	enqueue(...replies: MockScript[]): void
	/** Makes the next call fail with this code. */
	failNext(code: AiErrorCode, opts?: { message?: string, status?: number, retryAfter?: number }): void
	reset(): void
}

export interface MockOptions {
	id?: string
	defaultModel?: string
	models?: string[]
}

const DEFAULT_STATUS: Record<AiErrorCode, number> = { auth: 401, budget: 402, rate_limit: 429, invalid: 400, unavailable: 503 }

/** Last user text, for the echo reply. */
function lastUserText(req: AiRequest): string {
	for (let i = req.messages.length - 1; i >= 0; i--) {
		const m = req.messages[i]
		if (m.role !== 'user') continue
		if (typeof m.content === 'string') return m.content
		const t = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : b.type === 'tool_result' ? [b.content] : [])).join(' ')
		if (t) return t
	}
	return ''
}

/** A value that fits a JSON schema: first enum value, 0.5 within bounds, required properties filled. */
export function sampleOf(schema: any): unknown {
	if (!schema || typeof schema !== 'object') return null
	if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
	switch (schema.type) {
	case 'object': {
		const out: Record<string, unknown> = {}
		const props = schema.properties ?? {}
		for (const k of Array.isArray(schema.required) ? schema.required : Object.keys(props)) out[k] = sampleOf(props[k])
		return out
	}
	case 'array': return []
	case 'number': return Math.min(Math.max(0.5, schema.minimum ?? -Infinity), schema.maximum ?? Infinity)
	case 'integer': return Math.max(0, schema.minimum ?? 0)
	case 'boolean': return false
	case 'string': return 'mock'
	default: return null
	}
}

function defaultReply(req: AiRequest, model?: string): MockReply {
	// Model "demo" (demo stack only): keyword answers that look like a model's, see demo.ts.
	if (model === 'demo') {
		const d = demoAnswer(req)
		if (d) return d
	}
	const forced = req.toolChoice && typeof req.toolChoice === 'object' ? req.tools?.find((t) => t.name === (req.toolChoice as { name: string }).name) : undefined
	if (forced) return { toolCalls: [{ name: forced.name, input: sampleOf(forced.inputSchema) }] }
	// Dev stack: "mock-tool: <name> {json}" as the last user message calls that tool (if offered),
	// so a tool loop (the assistant, P5-6) can be tried end to end without a real model.
	const last = req.messages[req.messages.length - 1]
	const m = last?.role === 'user' && typeof last.content === 'string' ? /^mock-tool:\s*([\w.-]+)\s*(\{.*\})?\s*$/s.exec(last.content) : null
	if (m && req.tools?.some((t) => t.name === m[1])) {
		let input: unknown = {}
		try { input = m[2] ? JSON.parse(m[2]) : {} } catch { /* empty input */ }
		return { text: `mock: calling ${m[1]}`, toolCalls: [{ name: m[1], input }] }
	}
	return { text: `mock: ${lastUserText(req)}` }
}

// About 4 characters per token: rough but deterministic, enough to test budgets.
const tokens = (s: string): number => Math.ceil(s.length / 4)

function requestChars(req: AiRequest): number {
	return (req.system ?? '').length + JSON.stringify(req.messages).length + (req.tools ? JSON.stringify(req.tools).length : 0)
}

/** Splits text into word-sized chunks (with their trailing spaces) for streaming. */
export const chunks = (text: string): string[] => text.match(/\S+\s*|\s+/g) ?? []

export function createMockProvider(opts: MockOptions = {}): MockProvider {
	const queue: MockScript[] = []
	const requests: AiRequest[] = []
	const id = opts.id ?? 'mock'
	let calls = 0

	function run(req: AiRequest): AiResult {
		if (req.signal?.aborted) throw req.signal.reason ?? new DOMException('Aborted', 'AbortError')
		// Signal and callbacks are not data (and cannot be cloned).
		const { signal: _signal, onUsage: _onUsage, ...copy } = req
		requests.push(structuredClone(copy))
		calls++
		const next = queue.shift()
		const script = typeof next === 'function' ? next(req) : next ?? defaultReply(req, req.model ?? opts.defaultModel)
		if ('error' in script) {
			const e = script.error
			const status = e.status ?? DEFAULT_STATUS[e.code]
			throw new AiError(e.code, `${id}: HTTP ${status}: ${e.message ?? 'simulated ' + e.code}`, id, status, e.retryAfter)
		}
		const toolCalls: ToolCall[] = (script.toolCalls ?? []).map((c, i) => ({ id: c.id ?? `mock_call_${calls}_${i}`, name: c.name, input: c.input ?? {} }))
		const text = script.text ?? ''
		const maxed = req.maxTokens !== undefined && tokens(text) > req.maxTokens
		return {
			text,
			toolCalls,
			stopReason: script.stopReason ?? (toolCalls.length ? 'tool_use' : maxed ? 'max_tokens' : 'end'),
			usage: { inputTokens: script.usage?.inputTokens ?? Math.ceil(requestChars(req) / 4), outputTokens: script.usage?.outputTokens ?? tokens(text), reported: true },
			model: script.model ?? req.model ?? opts.defaultModel ?? 'mock-1',
		}
	}

	async function* stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
		const result = run(req)
		for (const t of chunks(result.text)) {
			if (req.signal?.aborted) throw req.signal.reason
			yield { type: 'text', text: t }
		}
		for (const call of result.toolCalls) yield { type: 'tool_call', call }
		yield { type: 'done', result }
	}

	const listModels = async () => opts.models ?? [opts.defaultModel ?? 'mock-1']

	return {
		id,
		kind: 'mock',
		requests,
		...trackUsage({ complete: async (req) => run(req), stream, listModels }),
		listModels,
		testConnection: () => testConnection(listModels),
		enqueue: (...r) => { queue.push(...r) },
		failNext: (code, o = {}) => { queue.push({ error: { code, ...o } }) },
		reset: () => { queue.length = 0; requests.length = 0; calls = 0 },
	}
}
