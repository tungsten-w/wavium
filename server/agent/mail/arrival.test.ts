// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { presetAccess, setAccess } from '../access'
import { type Db, getMeta, migrate, wrap } from '../db'
import type { Notifier } from '../events'
import { isLive, MailArrivals, STUCK_AFTER } from './arrival'
import { addMail, classify, queue, seedMail } from './fixture'
import { md5 } from './keys'

let db: Db
let notes: Array<{ title: string, message: string }>
let arrivals: MailArrivals
const T0 = 1_800_000_000

const notifier: Notifier = { notify: async (title, message) => { notes.push({ title, message }) } }
const queued = () => db.q<{ type: string, grantor_uid: string, wake_hint: number, dedupe_key: string, data: string }>(`SELECT * FROM oc_atrium_agent_event_queue ORDER BY id`)

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	await seedMail(db)
	notes = []
	arrivals = new MailArrivals(db, { notifier, statusUrl: 'https://nc/apps/mail/status' })
	await arrivals.init(T0)
	await setAccess(db, 'agent-nova', 'ann', 'mail', presetAccess('mail', { mail: ['read', 'write', 'send', 'delete'] }).mail)
})

/** A new mail synced into ann's INBOX, queued at T0+10, then classified. */
async function arrive(id: number, mid: string, subject: string, category: string | null, f: { priority?: number, sentAt?: number } = {}) {
	await addMail(db, id, 10, mid, subject, f.sentAt ?? T0)
	await db.q(`INSERT INTO oc_mail_recipients (message_id, type, label, email) VALUES ($1, 0, 'Jane', 'jane@y.test'), ($1, 2, 'Cc', 'cc@y.test')`, [id])
	await queue(db, 1, mid, { priority: f.priority ?? 1, sentAt: f.sentAt ?? T0, enqueuedAt: T0 + 10 })
	if (category) await classify(db, 1, mid, category, { urgency: 'today', at: T0 + 12 })
}

test('history is not replayed on first start', async () => {
	expect(await arrivals.emitNew()).toBe(0)
	expect(await getMeta(db, 'mail_triage_seen')).toBe('2')
	await arrivals.init(T0 + 999) // idempotent
	expect(await getMeta(db, 'mail_live_since')).toBe(String(T0))
})

test('classified live mail -> mail.received with the ADR payload and curated wake hint', async () => {
	await arrive(100, '<n1@x>', 'Lunch tomorrow?', 'personal')
	await arrive(101, '<n2@x>', 'SALE', 'ads')
	expect(await arrivals.emitNew()).toBe(2)
	const q = await queued()
	expect(q.map((e) => [e.type, e.grantor_uid, e.wake_hint, e.dedupe_key])).toEqual([
		['mail.received', 'ann', 1, `mail:1:${md5('<n1@x>')}`],
		['mail.received', 'ann', 0, `mail:1:${md5('<n2@x>')}`],
	])
	const data = JSON.parse(q[0].data)
	expect(data).toMatchObject({
		message_key: `1:${md5('<n1@x>')}`,
		thread_key: `1:t:${md5('<n1@x>')}`,
		account: { id: 1, email: 'ann@x.test' },
		folder: { id: 10, role: 'inbox', name: 'INBOX' },
		from: { name: 'Jane', address: 'jane@y.test' },
		cc: [{ name: 'Cc', address: 'cc@y.test' }],
		subject: 'Lunch tomorrow?',
		snippet: 'preview Lunch tomorrow?',
		has_attachments: false,
	})
	expect(data.classification).toMatchObject({ schema: 'mail-v2', category: 'personal', urgency: 'today' })
	// Nothing new: nothing emitted; reclassifying the same mail does not repeat it.
	expect(await arrivals.emitNew()).toBe(0)
	await classify(db, 1, '<n1@x>', 'work')
	await arrivals.emitNew()
	expect((await queued()).length).toBe(2)
})

test('wake hint follows the Curated setting', async () => {
	await db.q(`INSERT INTO oc_preferences VALUES ('ann', 'mail', 'curated-hides', '["personal"]')`)
	await arrive(100, '<n1@x>', 'Hi', 'personal')
	await arrive(101, '<n2@x>', 'Ad', 'ads')
	await arrivals.emitNew()
	expect((await queued()).map((e) => e.wake_hint)).toEqual([0, 1])
})

test('unclassified mail is never emitted; it goes out once classified', async () => {
	await arrive(100, '<n1@x>', 'Wait', null)
	expect(await arrivals.emitNew()).toBe(0)
	await classify(db, 1, '<n1@x>', 'work')
	expect(await arrivals.emitNew()).toBe(1)
})

test('backlog, old reclassified mail and owners without agents are skipped', async () => {
	await arrive(100, '<old@x>', 'Backlog', 'work', { priority: 0 })
	await arrive(101, '<re@x>', 'Old reclassified', 'work', { priority: 2, sentAt: T0 - 30 * 86400 })
	await arrive(102, '<re2@x>', 'Recent reclassified', 'work', { priority: 2, sentAt: T0 - 86400 })
	await addMail(db, 103, 20, '<bob@x>', 'Bob new', T0)
	await queue(db, 2, '<bob@x>', { enqueuedAt: T0 + 10 })
	await classify(db, 2, '<bob@x>', 'work')
	expect(await arrivals.emitNew()).toBe(1)
	expect(JSON.parse((await queued())[0].data).subject).toBe('Recent reclassified')
	expect(isLive({ enqueued_at: T0 - 1, priority: 1 }, T0)).toBe(false)
})

test('stuck live mail alerts once, then reports recovery', async () => {
	await db.q(`INSERT INTO oc_appconfig VALUES ('mail', 'triage_state', '{"state":"budget_exhausted","lastError":"tollgate: budget exhausted (402)"}')`)
	await arrive(100, '<n1@x>', 'Stuck', null)
	await arrivals.checkStuck(T0 + 60)
	expect(notes).toEqual([]) // not old enough yet
	await arrivals.checkStuck(T0 + 10 + STUCK_AFTER + 1)
	await arrivals.checkStuck(T0 + 10 + STUCK_AFTER + 120)
	expect(notes.length).toBe(1)
	expect(notes[0].title).toBe('1 new mail not classified')
	expect(notes[0].message).toContain('budget is exhausted')
	await db.q(`UPDATE oc_mail_triage_queue SET status = 'done'`)
	await arrivals.checkStuck(T0 + 2000)
	expect(notes.map((n) => n.title)).toEqual(['1 new mail not classified', 'Mail classification caught up'])
})
