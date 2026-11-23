// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { buildFlow, groupOf, type FlowRow } from './flow'

const hides = ['ads', 'newsletter', 'social']
// The example from the feedback: 100 mails, 3 important, 60 spam.
const rows: FlowRow[] = [
	{ accountId: 1, category: 'work', important: true, count: 2 },
	{ accountId: 1, category: 'personal', important: true, count: 1 },
	{ accountId: 1, category: 'spam', important: false, count: 58 },
	{ accountId: 1, category: 'spam', important: true, count: 2 },
	{ accountId: 1, category: 'newsletter', important: false, count: 20 },
	{ accountId: 1, category: 'orders', important: false, count: 17 },
	{ accountId: 2, category: 'work', important: false, count: 40 },
]

describe('mail flow', () => {
	it('puts spam before important, and Curated hides into their own group', () => {
		expect(groupOf({ category: 'spam', important: true }, hides)).toBe('spam')
		expect(groupOf({ category: 'work', important: true }, hides)).toBe('important')
		expect(groupOf({ category: 'newsletter', important: false }, hides)).toBe('hidden')
		expect(groupOf({ category: 'orders', important: false }, hides)).toBe('everyday')
	})

	it('splits one address into groups and categories that add up', () => {
		const m = buildFlow(rows, { accountId: 1, pending: 0, hides, source: 'a@example.org' })
		expect(m.total).toBe(100)
		const mid = Object.fromEntries(m.nodes.filter((n) => n.column === 1).map((n) => [n.group, n.count]))
		expect(mid).toEqual({ important: 3, everyday: 17, hidden: 20, spam: 60 })
		const leaves = m.nodes.filter((n) => n.column === 2)
		expect(leaves.reduce((n, l) => n + l.count, 0)).toBe(100)
		// Every node gets a link in, and the middle links leave the source stacked.
		expect(m.links).toHaveLength(m.nodes.length - 1)
		expect(m.nodes.every((n) => n.h >= 4 && n.y >= 0 && n.y + n.h <= m.height + 0.001)).toBe(true)
	})

	it('adds the not-sorted-yet branch and can show every address', () => {
		const m = buildFlow(rows, { accountId: null, pending: 5, hides, source: 'All addresses' })
		expect(m.total).toBe(145)
		expect(m.nodes.find((n) => n.group === 'pending')?.count).toBe(5)
		expect(m.nodes.find((n) => n.id === 'g:everyday')?.count).toBe(57)
	})

	it('folds small categories into Other after four', () => {
		const many: FlowRow[] = ['work', 'etudes', 'admin', 'orders', 'security', 'personal'].map((c, i) => ({ accountId: 1, category: c, important: false, count: 10 - i }))
		const m = buildFlow(many, { accountId: 1, pending: 0, hides, source: 'x' })
		const leaves = m.nodes.filter((n) => n.column === 2).map((n) => n.label)
		expect(leaves).toEqual(['Work', 'Studies', 'Admin', 'Orders', 'Other'])
	})

	it('is empty without mail', () => {
		expect(buildFlow([], { accountId: 1, pending: 0, hides, source: 'x' }).nodes).toEqual([])
	})
})
