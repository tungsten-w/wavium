// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import type { Message } from './api'
import { groupMessages, linkParts, qrPath, smsSegments } from './util'

const m = (id: string, at: number, from_me: boolean, extra: Partial<Message> = {}): Message => ({
	id, conversation_id: 'c', at, from_me, sender_name: '', sender_number: from_me ? '' : '+33', text: id, status: 'received', media: [], one_time_code: false, ...extra,
})

describe('messages util', () => {
	it('draws a QR code for the pairing data', () => {
		const q = qrPath('https://support.google.com/messages/?p=web_computer#?c=ABC')
		expect(q.size).toBeGreaterThanOrEqual(21)
		expect(q.d).toMatch(/^M\d+ \d+h1v1h-1z/)
		expect(qrPath('other').d).not.toBe(q.d)
	})

	it('groups by day and makes runs of one sender within 5 minutes', () => {
		const now = new Date(2026, 10, 17, 12, 0)
		const t = now.getTime()
		const g = groupMessages([m('a', t - 86_400_000, false), m('b', t - 600_000, false), m('c', t - 540_000, false), m('d', t - 500_000, true), m('e', t - 10_000, false)], now)
		expect(g.map((x) => x.label)).toEqual(['Yesterday', 'Today'])
		const today = g[1].bubbles.map((b) => `${b.m.id}${b.first ? 'F' : ''}${b.last ? 'L' : ''}`)
		expect(today).toEqual(['bF', 'cL', 'dFL', 'eFL'])
	})

	it('links URLs without HTML', () => {
		expect(linkParts('Suivi : https://colis.example/7Y4. Merci')).toEqual([{ text: 'Suivi : ' }, { text: 'https://colis.example/7Y4', href: 'https://colis.example/7Y4' }, { text: '. Merci' }])
		expect(linkParts('<b>javascript:alert(1)</b>')).toEqual([{ text: '<b>javascript:alert(1)</b>' }])
	})

	it('counts SMS segments (GSM 160/153, unicode 70/67)', () => {
		expect(smsSegments('')).toEqual({ segments: 0, left: 160 })
		expect(smsSegments('a'.repeat(160))).toEqual({ segments: 1, left: 0 })
		expect(smsSegments('a'.repeat(161)).segments).toBe(2)
		expect(smsSegments('😀'.repeat(70)).segments).toBe(1)
		expect(smsSegments('😀'.repeat(71)).segments).toBe(2)
	})
})
