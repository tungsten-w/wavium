// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Logic of the assistant panel (P5-6), without React: reading the event
// stream of POST /agent/v1/assistant/chat, folding its events into the
// conversation, and turning the conversation back into chat messages.

export type ChatEvent =
	| { type: 'text', text: string }
	| { type: 'tool', id: string, name: string, input: unknown }
	| { type: 'tool_result', id: string, name: string, ok: boolean, preview: string }
	| { type: 'approval', id: string, name: string, request_id: string, summary: string }
	| { type: 'done', steps: number, stopped?: string }
	| { type: 'error', code: string, message: string }

export type Step =
	| { kind: 'tool', id: string, name: string, ok: boolean | null }
	| { kind: 'approval', id: string, request_id: string, summary: string, decision: 'pending' | 'approved' | 'rejected' | 'failed' }

export type Turn =
	| { role: 'user', text: string }
	| { role: 'assistant', text: string, steps: Step[], done: boolean, error: string | null, note: string | null, textAt?: number }

/** Splits a text/event-stream buffer into `data:` events; returns what is left for the next chunk. */
export function parseSse(buffer: string): { events: ChatEvent[], rest: string } {
	const events: ChatEvent[] = []
	const parts = buffer.split('\n\n')
	const rest = parts.pop() ?? ''
	for (const part of parts) {
		const data = part.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')
		if (!data) continue
		try { events.push(JSON.parse(data) as ChatEvent) } catch { /* not ours */ }
	}
	return { events, rest }
}

/** Folds one event into the assistant turn being written. */
export function applyEvent(turn: Extract<Turn, { role: 'assistant' }>, e: ChatEvent): Extract<Turn, { role: 'assistant' }> {
	switch (e.type) {
		// Text after a tool step starts a new paragraph (it is the model's next turn).
		case 'text': {
			const sep = turn.text && (turn.textAt ?? 0) < turn.steps.length ? '\n\n' : ''
			return { ...turn, text: turn.text + sep + e.text, textAt: turn.steps.length }
		}
		case 'tool': return { ...turn, steps: [...turn.steps, { kind: 'tool', id: e.id, name: e.name, ok: null }] }
		case 'tool_result': return { ...turn, steps: turn.steps.map((s) => (s.kind === 'tool' && s.id === e.id ? { ...s, ok: e.ok } : s)) }
		case 'approval': return { ...turn, steps: [...turn.steps, { kind: 'approval', id: e.id, request_id: e.request_id, summary: e.summary, decision: 'pending' }] }
		case 'done': return { ...turn, done: true, note: e.stopped ?? null }
		case 'error': return { ...turn, done: true, error: e.message }
	}
}

/**
 * The conversation as chat messages: text only, empty turns dropped, turns
 * of the same role joined (providers want user and assistant to alternate).
 */
export function toMessages(turns: Turn[]): Array<{ role: 'user' | 'assistant', content: string }> {
	const out: Array<{ role: 'user' | 'assistant', content: string }> = []
	for (const t of turns) {
		const text = t.text.trim()
		if (!text) continue
		const last = out[out.length - 1]
		if (last && last.role === t.role) last.content += '\n\n' + text
		else out.push({ role: t.role, content: text })
	}
	while (out.length && out[0].role === 'assistant') out.shift()
	return out.slice(-40)
}

export const toolLabel = (name: string): string => name.replace(/_/g, ' ')
