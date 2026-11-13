// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'vitest'
import { applyEvent, parseSse, toMessages, type Turn } from './assistantModel'

test('parseSse: events split across chunks, pings and junk ignored', () => {
	const a = parseSse('data: {"type":"text","text":"Hel"}\n\n: ping\n\ndata: {"type":"te')
	expect(a.events).toEqual([{ type: 'text', text: 'Hel' }])
	const b = parseSse(a.rest + 'xt","text":"lo"}\n\ndata: not json\n\n')
	expect(b.events).toEqual([{ type: 'text', text: 'lo' }])
	expect(b.rest).toBe('')
})

test('applyEvent: text, tool lines with results, approvals, done and errors', () => {
	let t: Extract<Turn, { role: 'assistant' }> = { role: 'assistant', text: '', steps: [], done: false, error: null, note: null }
	t = applyEvent(t, { type: 'text', text: 'Hi ' })
	t = applyEvent(t, { type: 'tool', id: 'c1', name: 'notes_note_list', input: {} })
	t = applyEvent(t, { type: 'tool', id: 'c2', name: 'files_delete', input: {} })
	t = applyEvent(t, { type: 'tool_result', id: 'c1', name: 'notes_note_list', ok: true, preview: '' })
	t = applyEvent(t, { type: 'approval', id: 'c2', name: 'files_delete', request_id: 'apr_1', summary: 'Delete /x' })
	t = applyEvent(t, { type: 'text', text: 'there' })
	expect(t.text).toBe('Hi \n\nthere')
	expect(applyEvent(t, { type: 'text', text: '!' }).text).toBe('Hi \n\nthere!')
	expect(t.steps).toEqual([
		{ kind: 'tool', id: 'c1', name: 'notes_note_list', ok: true },
		{ kind: 'tool', id: 'c2', name: 'files_delete', ok: null },
		{ kind: 'approval', id: 'c2', request_id: 'apr_1', summary: 'Delete /x', decision: 'pending' },
	])
	expect(applyEvent(t, { type: 'done', steps: 8, stopped: 'Stopped after 8 steps.' })).toMatchObject({ done: true, note: 'Stopped after 8 steps.' })
	expect(applyEvent(t, { type: 'error', code: 'budget', message: 'Budget used up' })).toMatchObject({ done: true, error: 'Budget used up' })
})

test('toMessages: text only, empty turns dropped, same roles joined, starts with the user', () => {
	const turns: Turn[] = [
		{ role: 'assistant', text: 'Hello!', steps: [], done: true, error: null, note: null },
		{ role: 'user', text: 'Find my notes' },
		{ role: 'assistant', text: '', steps: [], done: true, error: 'failed', note: null },
		{ role: 'user', text: 'about Paris' },
		{ role: 'assistant', text: 'Found one.', steps: [], done: true, error: null, note: null },
		{ role: 'user', text: ' thanks ' },
	]
	expect(toMessages(turns)).toEqual([
		{ role: 'user', content: 'Find my notes\n\nabout Paris' },
		{ role: 'assistant', content: 'Found one.' },
		{ role: 'user', content: 'thanks' },
	])
})
