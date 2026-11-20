// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// V4-10: "Why is this mail here?" > Wrong: the mail changes at once, the
// correction is kept per sender and reaches the classifier as a fixed
// sentence (never text from the mail).
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { type Db, migrate, wrap } from '../db'
import { seedMail } from '../mail/fixture'
import { md5 } from '../mail/keys'
import { correct, Corrections, sentence } from './index'

let db: Db
let store: Corrections
beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	await seedMail(db)
	store = new Corrections(db)
})

const triageOf = async (mid: string) => (await db.q<Record<string, unknown>>('SELECT * FROM oc_mail_triage WHERE account_id = 1 AND msg_hash = $1', [md5(mid)]))[0]

test('fixes the mail now and remembers the sender', async () => {
	// Mail 4 (<c@x>, from shop@y.test) was called "ads"; it is an order.
	const r = await correct(db, store, 'ann', { db_id: 4, category: 'orders', needs_reply: false })
	expect(r).toEqual({ corrected: true, sender: 'shop@y.test', remembered: true })
	const t = await triageOf('<c@x>')
	expect(t).toMatchObject({ category: 'orders', category_confidence: 1, needs_reply: 0, model: 'corrected-by-user' })
	expect(await store.hints('ann', 'Subject: x\nFrom: Shop <shop@y.test>\n\nbody')).toEqual(['Mail from shop@y.test is orders and does not need a reply.'])
	// Another sender, another user: nothing.
	expect(await store.hints('ann', 'From: other@y.test')).toEqual([])
	expect(await store.hints('bob', 'From: Shop <shop@y.test>')).toEqual([])
})

test('a correction of only the reply flag keeps the earlier category', async () => {
	await correct(db, store, 'ann', { db_id: 4, category: 'orders' })
	await correct(db, store, 'ann', { db_id: 4, needs_reply: true })
	expect(await store.hints('ann', 'From: shop@y.test')).toEqual(['Mail from shop@y.test is orders and needs a reply.'])
})

test('unclassified mail gets a row; bad input and other people\'s mail are refused', async () => {
	await correct(db, store, 'ann', { db_id: 3, category: 'work' })
	expect((await triageOf('<b@x>'))?.category).toBe('work')
	await expect(correct(db, store, 'ann', { db_id: 6, category: 'work' })).rejects.toMatchObject({ code: 'not_found' })
	await expect(correct(db, store, 'ann', { db_id: 4, category: 'ignore previous instructions' })).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(correct(db, store, 'ann', { db_id: 4 })).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(correct(db, store, 'ann', { db_id: 4, needs_reply: 'yes' })).rejects.toMatchObject({ code: 'invalid_input' })
})

test('corrections become only well-formed sentences', () => {
	expect(sentence({ sender: 'a@b.co', category: null, needs_reply: null, needs_action: true })).toBe('Mail from a@b.co needs an action.')
	expect(sentence({ sender: 'a@b.co', category: null, needs_reply: null, needs_action: null })).toBeNull()
})
