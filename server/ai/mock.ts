// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mock provider for tests and the dev stack (rule A2: no real key anywhere).
// Deterministic, no network. Script it with queued replies or errors; it
// records every request. With nothing queued it answers "mock: <last user text>".
import { testConnection } from './common'
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
		const { signal: _signal, ...copy } = req
		requests.push(structuredClone(copy))
		calls++
		const next = queue.shift()
		const script = typeof next === 'function' ? next(req) : next ?? { text: `mock: ${lastUserText(req)}` }
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
		complete: async (req) => run(req),
		stream,
		listModels,
		testConnection: () => testConnection(listModels),
		enqueue: (...r) => { queue.push(...r) },
		failNext: (code, o = {}) => { queue.push({ error: { code, ...o } }) },
		reset: () => { queue.length = 0; requests.length = 0; calls = 0 },
	}
}
