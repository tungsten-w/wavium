// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Daily digest (P5-1): assembly, time zones, the morning run, settings, the AI
// summary (mock provider only, rule A2). Sources are fakes; the store is sqlite.
import { beforeEach, describe, expect, test } from 'bun:test'
import type { AiProvider } from '../ai'
import { type Db, wrap } from '../db'
import { buildDigest, type DigestSources, headline, localDay, localMidnight, type MailRow, pickMail, validTimezone } from './build'
import { aiSummary, DigestService, DigestStore } from './index'

/** A tiny scripted provider (the agent layer reaches server/ai only through agent/ai.ts). */
function fakeAi() {
	const queue: Array<string | Error> = []
	const requests: Array<{ system?: string, messages: Array<{ content: unknown }> }> = []
	const p = {
		id: 'fake', kind: 'mock',
		requests,
		enqueue: (x: string | Error) => { queue.push(x) },
		reset: () => { queue.length = 0; requests.length = 0 },
		async complete(req: any) {
			requests.push(req)
			const next = queue.shift() ?? 'ok'
			if (next instanceof Error) throw next
			return { text: next, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1, reported: true }, model: 'fake' }
		},
	}
	return p as typeof p & AiProvider
}

const mail = (key: string, c: MailRow['classification'], extra: Partial<MailRow> = {}): MailRow => ({
	message_key: key, date: '2026-11-13T06:00:00Z', from: { name: 'Ann', address: 'ann@x.test' }, subject: `Subject ${key}`,
	flags: { seen: false, answered: false }, classification: c, ...extra,
})

function sources(over: Partial<DigestSources> = {}): DigestSources & { calls: Record<string, unknown[]> } {
	const calls: Record<string, unknown[]> = {}
	const rec = (k: string, v: unknown) => { (calls[k] ??= []).push(v) }
	return {
		calls,
		mail: async (uid, since) => { rec('mail', [uid, since]); return [mail('a', { needs_reply: 0.9, urgency: 'today' }), mail('b', { needs_action: 0.8, urgency: 'this_week', has_deadline: 0.9 })] },
		events: async (uid, from, to) => {
			rec('events', [uid, from.toISOString(), to.toISOString()])
			return [
				{ event_id: 'c/2', title: 'Dentist', start: '2026-11-13T15:00:00Z', end: '2026-11-13T16:00:00Z', all_day: false, location: 'Lyon' },
				{ event_id: 'c/1', title: 'Standup', start: '2026-11-13T08:30:00Z', end: '2026-11-13T08:45:00Z', all_day: false },
				{ event_id: 'c/3', title: 'Holiday', start: '2026-11-13', end: '2026-11-14', all_day: true },
				{ event_id: 'c/4', title: 'Cancelled', start: '2026-11-13T10:00:00Z', end: null, all_day: false, status: 'cancelled' },
			]
		},
		tasks: async (uid, before) => { rec('tasks', [uid, before.toISOString()]); return [{ task_id: 't/1', title: 'Pay rent', due: '2026-11-12', done: false }, { task_id: 't/2', title: 'Call bank', due: '2026-11-13T17:00:00Z', done: false }] },
		todo: async () => [
			{ item_id: 1, title: 'Groceries', kind: 'item', done: false, parent_id: null },
			{ item_id: 2, title: 'Milk', kind: 'item', done: false, parent_id: 1 },
			{ item_id: 3, title: 'Done thing', kind: 'item', done: true, parent_id: null },
			{ item_id: 4, title: 'Dentist', kind: 'event', done: false, parent_id: null },
			{ item_id: 5, title: '---', kind: 'item', done: false, parent_id: null },
			{ item_id: 6, title: '<br>', kind: 'item', done: false, parent_id: null },
		],
		mailLink: async (_uid, key) => (key === 'a' ? '/apps/mail/box/1/thread/7' : Promise.reject(new Error('gone'))),
		...over,
	}
}

// 2026-11-13 08:00 in Paris (UTC+1).
const NOW = new Date('2026-11-13T07:00:00Z')

describe('time zones', () => {
	test('local day and midnight, with DST', () => {
		expect(localDay(new Date('2026-11-12T23:30:00Z'), 'Europe/Paris')).toBe('2026-11-13')
		expect(localDay(new Date('2026-11-12T23:30:00Z'), 'America/New_York')).toBe('2026-11-12')
		expect(localMidnight('2026-11-13', 'Europe/Paris').toISOString()).toBe('2026-11-12T23:00:00.000Z')
		expect(localMidnight('2026-07-01', 'Europe/Paris').toISOString()).toBe('2026-06-30T22:00:00.000Z')
		// The DST day in Paris is 23 hours long.
		expect(localMidnight('2026-03-30', 'Europe/Paris').getTime() - localMidnight('2026-03-29', 'Europe/Paris').getTime()).toBe(23 * 3600_000)
		expect(validTimezone('Not/AZone')).toBe(validTimezone(null))
		expect(validTimezone('Asia/Tokyo')).toBe('Asia/Tokyo')
	})
})

describe('build', () => {
	test('everything for today, in order, with counts and a headline', async () => {
		const src = sources()
		const d = await buildDigest(src, 'alice', { now: NOW, timezone: 'Europe/Paris' })
		expect(d.day).toBe('2026-11-13')
		// Today = local midnight to local midnight; mail from the last 7 days.
		expect(src.calls.events[0]).toEqual(['alice', '2026-11-12T23:00:00.000Z', '2026-11-13T23:00:00.000Z'])
		expect(src.calls.tasks[0]).toEqual(['alice', '2026-11-13T23:00:00.000Z'])
		expect(src.calls.mail[0]).toEqual(['alice', NOW.getTime() / 1000 - 7 * 86400])
		expect(d.events.map((e) => e.title)).toEqual(['Holiday', 'Standup', 'Dentist'])
		expect(d.tasks).toEqual([{ task_id: 't/1', title: 'Pay rent', due: '2026-11-12', overdue: true }, { task_id: 't/2', title: 'Call bank', due: '2026-11-13T17:00:00Z', overdue: false }])
		expect(d.todo).toEqual([{ item_id: 1, title: 'Groceries', kind: 'item' }])
		expect(d.mail.map((m) => [m.message_key, m.reason, m.link])).toEqual([['a', 'reply', '/apps/mail/box/1/thread/7'], ['b', 'action', null]])
		expect(d.counts).toEqual({ reply: 1, action: 1, events: 3, tasks: 2, overdue: 1, todo: 1 })
		expect(d.headline).toBe('1 mail needs a reply, 1 needs an action · 3 events, the first at 09:30 · 2 tasks due (1 overdue) · 1 thing on today\'s list')
		expect(d.errors).toEqual({})
	})

	test('a failing source is left out and named; the rest is built', async () => {
		const d = await buildDigest(sources({ events: async () => { throw new Error('calendar app disabled') } }), 'alice', { now: NOW, timezone: 'Europe/Paris' })
		expect(d.errors).toEqual({ calendar: 'calendar app disabled' })
		expect(d.events).toEqual([])
		expect(d.counts.reply).toBe(1)
	})

	test('nothing to do', async () => {
		const none = async () => []
		const d = await buildDigest({ mail: none, events: none, tasks: none, todo: none }, 'alice', { now: NOW, timezone: 'UTC' })
		expect(d.headline).toBe('Nothing needs you today.')
	})

	test('mail: answered mail needs no reply, duplicates once, most urgent first, capped', () => {
		const rows = [
			mail('old', { needs_reply: 0.9, urgency: 'whenever' }),
			mail('answered', { needs_reply: 0.9, urgency: 'now' }, { flags: { seen: true, answered: true } }),
			mail('answered-but-action', { needs_reply: 0.9, needs_action: 0.7 }, { flags: { seen: true, answered: true } }),
			mail('now', { needs_reply: 0.6, urgency: 'now' }),
			mail('now', { needs_reply: 0.6, urgency: 'now' }),
			mail('low', { needs_reply: 0.4, needs_action: 0.4 }),
			mail('unclassified', null),
			mail('phishing', { needs_reply: 0.9, needs_action: 0.9, urgency: 'now', suspicious: 0.8 }),
		]
		expect(pickMail(rows).map((m) => [m.message_key, m.reason])).toEqual([['now', 'reply'], ['old', 'reply'], ['answered-but-action', 'action']])
		expect(pickMail(Array.from({ length: 40 }, (_, i) => mail(`m${i}`, { needs_reply: 1 })))).toHaveLength(15)
	})

	test('headline grammar', () => {
		const h = (c: Partial<Record<string, number>>) => headline({ counts: { reply: 0, action: 0, events: 0, tasks: 0, overdue: 0, todo: 0, ...c }, events: [], timezone: 'UTC' })
		expect(h({ reply: 2 })).toBe('2 mails need a reply')
		expect(h({ action: 1 })).toBe('1 mail needs an action')
		expect(h({ events: 1, tasks: 1 })).toBe('1 event · 1 task due')
	})
})

describe('service', () => {
	let db: Db
	let clock: { t: Date }
	let notes: Array<{ title: string, message: string, click: string }>
	let svc: DigestService
	let store: DigestStore
	const mock = fakeAi()
	let aiFor: string[]

	beforeEach(async () => {
		db = wrap(new Bun.SQL('sqlite://:memory:'), 'sqlite', 'oc_')
		store = new DigestStore(db)
		clock = { t: NOW }
		notes = []
		aiFor = []
		mock.reset()
		svc = new DigestService({
			store,
			sources: sources(),
			ai: { forTask: async (uid, task) => { aiFor.push(`${uid}:${task}`); return mock } },
			notify: async (title, message, click) => { notes.push({ title, message, click }) },
			timezone: async () => 'Europe/Paris',
			lang: async () => 'fr',
			dashboardUrl: 'http://atrium.test/apps/dashboard/',
			now: () => clock.t,
		})
	})

	test('settings: defaults, validation, turned on after the time = tomorrow', async () => {
		expect(await svc.getSettings('alice')).toEqual({ enabled: false, time: '07:30', notify: false, ai: false })
		await expect(svc.putSettings('alice', { time: '7:30' })).rejects.toMatchObject({ code: 'invalid_input' })
		await expect(svc.putSettings('alice', { enabled: 'yes' })).rejects.toMatchObject({ code: 'invalid_input' })
		// 08:00 in Paris, time 07:30: today's slot has passed.
		expect(await svc.putSettings('alice', { enabled: true, notify: true })).toEqual({ enabled: true, time: '07:30', notify: true, ai: false })
		expect(await svc.tick()).toEqual([])
		clock.t = new Date('2026-11-14T06:29:00Z') // 07:29 next day
		expect(await svc.tick()).toEqual([])
		clock.t = new Date('2026-11-14T06:30:00Z') // 07:30
		expect(await svc.tick()).toEqual(['alice'])
	})

	test('morning run: once per day, kept, notified with a link; off = nothing', async () => {
		clock.t = new Date('2026-11-13T05:00:00Z') // set up at 06:00
		await svc.putSettings('bob', { enabled: true, time: '09:00' })
		await svc.putSettings('carol', { enabled: false, time: '06:00' })
		await svc.putSettings('alice', { enabled: true, time: '08:00', notify: true })
		clock.t = NOW
		expect(await svc.tick()).toEqual(['alice'])
		expect(await svc.tick()).toEqual([])
		expect(notes).toHaveLength(1)
		expect(notes[0].title).toStartWith('Today: 1 mail needs a reply')
		expect(notes[0].message).toContain('- Reply to Ann: Subject a (today)')
		expect(notes[0].message).toContain('- 09:30 Standup')
		expect(notes[0].click).toBe('http://atrium.test/apps/dashboard/')
		expect((await store.kept('alice', '2026-11-13'))?.counts.events).toBe(3)
		expect(aiFor).toEqual([]) // AI off by default
		clock.t = new Date('2026-11-13T08:00:00Z') // 09:00: bob's turn, no notify
		expect(await svc.tick()).toEqual(['bob'])
		expect(notes).toHaveLength(1)
	})

	test('AI summary when on: task summary, user language, kept and shown all day', async () => {
		clock.t = new Date('2026-11-13T05:00:00Z')
		await svc.putSettings('alice', { enabled: true, time: '08:00', ai: true })
		clock.t = NOW
		mock.enqueue('  Réponds à Ann aujourd’hui ;\n le reste peut attendre.  ')
		await svc.tick()
		expect(aiFor).toEqual(['alice:summary'])
		expect(mock.requests[0].system).toContain('in French')
		expect(String(mock.requests[0].messages[0].content)).toContain('<digest>')
		const later = await svc.today('alice')
		expect(later.ai_summary).toBe('Réponds à Ann aujourd’hui ; le reste peut attendre.')
		expect(later.ai_summary_at).toBe(NOW.toISOString())
		expect(aiFor).toEqual(['alice:summary']) // GET never calls the AI
	})

	test('AI failure or no AI never breaks the digest', async () => {
		mock.enqueue(new Error('budget exhausted'))
		const d = await svc.build('alice', true)
		expect(d.ai_summary).toBeNull()
		expect(d.counts.reply).toBe(1)
		expect(await aiSummary(null, d, 'en')).toBeNull()
	})

	test('refresh keeps today\'s digest', async () => {
		const d = await svc.refresh('alice')
		expect((await store.kept('alice', d.day))?.headline).toBe(d.headline)
	})
})
