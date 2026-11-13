// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Filing rules (P5-3): the engine, the runner on new mail, preview / apply, and
// the AI proposal (fake AI). Sqlite mail fixture; the Mail bridge is a fake
// that records moves and flags (it has no delete).
import { SQL } from 'bun'
import { beforeEach, describe as group, expect, test } from 'bun:test'
import type { AiProvider } from '../ai'
import { type Db, migrate, wrap } from '../db'
import { addMail, classify, seedMail } from '../mail/fixture'
import { describe, domainOf, firstMatch, matches, type Rule, validateRule } from './engine'
import { applyNow, preview, propose, RuleRunner, RuleStore, type RulesDeps } from './index'

let db: Db
let moves: Array<[string, number, number]>
let flags: Array<[string, number, Record<string, boolean>]>
let deps: RulesDeps
let aiReply: unknown

function fakeAi() {
	const requests: any[] = []
	return {
		id: 'fake', kind: 'mock', requests,
		async complete(req: any) {
			requests.push(req)
			if (aiReply instanceof Error) throw aiReply
			return { text: '', toolCalls: [{ id: 'c1', name: 'make_rule', input: aiReply }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1, reported: true }, model: 'm' }
		},
	} as unknown as AiProvider & { requests: any[] }
}

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	await seedMail(db)
	// Account 1 (ann) gets an "Admin" folder; mail 4 <c@x> (shop@y.test, ads) is in INBOX 10.
	await db.q(`INSERT INTO oc_mail_mailboxes (id, account_id, name, special_use) VALUES (13, 1, 'Admin', '[]')`)
	moves = []
	flags = []
	aiReply = {}
	deps = {
		db, store: new RuleStore(db),
		bridge: { move: async (u, id, dest) => { moves.push([u, id, dest]) }, flags: async (u, id, f) => { flags.push([u, id, f as Record<string, boolean>]) } },
		ai: async () => fakeAi(),
	}
})

const rule = (over: Partial<Rule> = {}): Rule => ({ id: 1, name: 'r', account: 1, when: { from_domain: 'y.test' }, then: { move_to: 13 }, enabled: true, ...over })

group('engine', () => {
	test('conditions: domain (with subdomains), address, category, subject; account must match', () => {
		const m = { account: 1, from: 'Bills@Mail.EDF.fr', subject: 'Votre FACTURE', category: 'admin' }
		expect(domainOf(m.from)).toBe('mail.edf.fr')
		expect(matches(rule({ when: { from_domain: 'edf.fr' } }), m)).toBe(true)
		expect(matches(rule({ when: { from_domain: '@mail.edf.fr' } }), m)).toBe(true)
		expect(matches(rule({ when: { from_domain: 'notedf.fr' } }), { ...m, from: 'x@notedf.fr' })).toBe(true)
		expect(matches(rule({ when: { from_domain: 'edf.fr' } }), { ...m, from: 'x@notedf.fr' })).toBe(false)
		expect(matches(rule({ when: { from: 'bills@mail.edf.fr' } }), m)).toBe(true)
		expect(matches(rule({ when: { category: 'admin', subject_contains: 'facture' } }), m)).toBe(true)
		expect(matches(rule({ when: { category: 'orders' } }), m)).toBe(false)
		expect(matches(rule({ account: 2, when: { category: 'admin' } }), m)).toBe(false)
	})

	test('first enabled rule wins, by id', () => {
		const m = { account: 1, from: 'a@y.test', subject: '', category: null }
		expect(firstMatch([rule({ id: 3 }), rule({ id: 2, enabled: false }), rule({ id: 5 })], m)?.id).toBe(3)
		expect(firstMatch([rule({ when: { from: 'b@y.test' } })], m)).toBeNull()
	})

	test('validation', () => {
		const f = new Set([13])
		expect(validateRule({ when: { from_domain: 'edf.fr', from: '' }, then: { move_to: '13', mark_read: true, star: false } }, f))
			.toEqual({ when: { from_domain: 'edf.fr' }, then: { move_to: 13, mark_read: true } })
		for (const bad of [
			{ when: {}, then: { move_to: 13 } },
			{ when: { from_domain: 'edf' }, then: { move_to: 13 } },
			{ when: { from: 'nope' }, then: { move_to: 13 } },
			{ when: { category: 'bills' }, then: { move_to: 13 } },
			{ when: { category: 'admin' }, then: {} },
			{ when: { category: 'admin' }, then: { move_to: 99 } },
			{ when: [], then: { move_to: 13 } },
		]) expect(() => validateRule(bad, f)).toThrow()
		expect(describe({ when: { from_domain: 'edf.fr', category: 'admin' }, then: { move_to: 13, mark_read: true } }, () => 'Admin')).toBe('from edf.fr, category admin → move to Admin, mark read')
	})
})

group('runner (new mail, no AI)', () => {
	test('history is not replayed; new mail is filed once, by its owner\'s rules only', async () => {
		const store = deps.store
		await store.create('ann', { name: 'Shop', account: 1, when: { from_domain: 'y.test', category: 'orders' }, then: { move_to: 13, mark_read: true } })
		await store.create('bob', { name: 'Bob all', account: 2, when: { category: 'orders' }, then: { star: true } })
		const runner = new RuleRunner(deps)
		await runner.init()
		expect(await runner.tick()).toBe(0) // mails classified before the first start stay put

		await addMail(db, 7, 10, '<n@x>', 'Your order shipped', 6000)
		await db.q(`INSERT INTO oc_mail_recipients (message_id, type, label, email) VALUES (7, 0, 'Shop', 'news@shop.y.test')`)
		await classify(db, 1, '<n@x>', 'orders')
		await addMail(db, 8, 11, '<m@x>', 'Not in inbox', 6100)
		await db.q(`INSERT INTO oc_mail_recipients (message_id, type, label, email) VALUES (8, 0, 'Shop', 'news@y.test')`)
		await classify(db, 1, '<m@x>', 'orders')
		expect(await runner.tick()).toBe(1)
		expect(moves).toEqual([['ann', 7, 13]])
		expect(flags).toEqual([['ann', 7, { seen: true }]])
		// Classified again (reclassify): not filed twice.
		await classify(db, 1, '<n@x>', 'orders')
		expect(await runner.tick()).toBe(0)
		expect(moves).toHaveLength(1)
		expect(await store.log('ann')).toMatchObject([{ subject: 'Your order shipped' }])
	})

	test('disabled rules do nothing', async () => {
		const id = await deps.store.create('ann', { name: 'x', account: 1, when: { category: 'orders' }, then: { move_to: 13 } })
		await deps.store.update('ann', { ...(await deps.store.get('ann', id)), enabled: false })
		const runner = new RuleRunner(deps)
		await runner.init()
		await addMail(db, 7, 10, '<n@x>', 'Order', 6000)
		await classify(db, 1, '<n@x>', 'orders')
		expect(await runner.tick()).toBe(0)
		expect(moves).toEqual([])
	})
})

group('preview, apply, propose', () => {
	test('preview counts inbox matches; apply files them once', async () => {
		const p = await preview(db, 'ann', 1, { from_domain: 'y.test' })
		expect(p.count).toBe(2) // <a@x> from zed@y.test and <c@x> from shop@y.test, both in INBOX
		expect(p.sample.map((s) => s.subject).sort()).toEqual(['Hello', 'Invoice'])
		const id = await deps.store.create('ann', { name: 'Shop', account: 1, when: { from: 'shop@y.test' }, then: { move_to: 13 } })
		expect(await applyNow(deps, 'ann', await deps.store.get('ann', id))).toBe(1)
		expect(moves).toEqual([['ann', 4, 13]])
		expect(await applyNow(deps, 'ann', await deps.store.get('ann', id))).toBe(0)
		// Another user cannot preview ann's account.
		await expect(preview(db, 'bob', 1, { from_domain: 'y.test' })).rejects.toMatchObject({ code: 'not_found' })
	})

	test('the AI proposes, the rule is checked and not saved', async () => {
		aiReply = { name: 'Factures', category: 'ads', from_domain: 'y.test', move_to: 13, mark_read: true }
		const r = await propose(deps, 'ann', { text: 'les pubs de y.test dans Admin, marquées lues' })
		expect(r.rule).toMatchObject({ name: 'Factures', account: 1, when: { category: 'ads', from_domain: 'y.test' }, then: { move_to: 13, mark_read: true } })
		expect(r.description).toBe('from y.test, category ads → move to Admin, mark read')
		expect(r.preview).toMatchObject({ count: 1, sample: [{ subject: 'Invoice' }] })
		expect(await deps.store.list('ann')).toEqual([])
		expect(moves).toEqual([])
	})

	test('a proposal with a folder that does not exist, no AI, or a bad request is refused', async () => {
		aiReply = { name: 'x', category: 'admin', move_to: 12 } // 12 = Trash: not offered
		await expect(propose(deps, 'ann', { text: 'into the bin' })).rejects.toMatchObject({ code: 'invalid_input' })
		await expect(propose({ ...deps, ai: async () => null }, 'ann', { text: 'x' })).rejects.toMatchObject({ code: 'unavailable' })
		await expect(propose(deps, 'ann', { text: '' })).rejects.toMatchObject({ code: 'invalid_input' })
		aiReply = new Error('budget')
		await expect(propose(deps, 'ann', { text: 'x' })).rejects.toMatchObject({ code: 'unavailable' })
	})
})
