// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Talking to your own agent (V4-39), without React: merging what polling
// brings back, and saying honestly where an unanswered message is. The DOM is
// here only for localStorage, which is where the panel remembers who you chose.
import '../testing/dom'
import { expect, test } from 'vitest'
import { type ChatMessage, lastId, merge, readWho, saveWho, waitingLine, WHO_KEY } from './chatModel'

const msg = (id: number, from: 'you' | 'agent', text = 't', taken = false): ChatMessage => ({ id, from, text, at: 1795600000 + id, taken })
const mail = { name: 'Claude Mail', paused: false }

test('polling never shows a message twice, and a row can change', () => {
	const have = [msg(1, 'you'), msg(2, 'agent')]
	expect(merge(have, []).map((m) => m.id)).toEqual([1, 2])
	expect(merge(have, [msg(3, 'agent')]).map((m) => m.id)).toEqual([1, 2, 3])
	// The same id twice is one row, and the newer copy wins: that is how
	// "not picked up" becomes "picked up" without a reload.
	const again = merge(have, [msg(1, 'you', 't', true)])
	expect([again.length, again[0].taken]).toEqual([2, true])
	// Out of order in, in order out.
	expect(merge([msg(5, 'you')], [msg(2, 'agent')]).map((m) => m.id)).toEqual([2, 5])
})

test('the next poll asks only for what is new', () => {
	expect(lastId([])).toBe(0)
	expect(lastId([msg(3, 'you'), msg(7, 'agent'), msg(5, 'you')])).toBe(7)
})

test('the line under the thread says where the message actually is', () => {
	expect(waitingLine([], mail)).toBeNull()
	// Its own answer is the end of the exchange: nothing to wait for.
	expect(waitingLine([msg(1, 'you', 'x', true), msg(2, 'agent')], mail)).toBeNull()
	expect(waitingLine([msg(1, 'you')], mail)).toBe('Waiting for Claude Mail to pick this up. It checks in regularly.')
	expect(waitingLine([msg(1, 'you', 'x', true)], mail)).toBe('Claude Mail has your message and is working on it. Its answer appears here.')
	// A paused agent will not read anything: say so instead of "waiting".
	expect(waitingLine([msg(1, 'you')], { name: 'Claude Mail', paused: true }))
		.toBe('Claude Mail is paused, so it will not read this until you resume it (Settings > Agents).')
})

test('the panel remembers who you were talking to, and falls back to the assistant', () => {
	localStorage.removeItem(WHO_KEY)
	expect(readWho()).toBe('assistant')
	saveWho('claude-mail')
	expect([localStorage.getItem(WHO_KEY), readWho()]).toEqual(['claude-mail', 'claude-mail'])
})
