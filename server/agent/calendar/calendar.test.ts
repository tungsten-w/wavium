// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Calendar + Tasks agent tools (P3-2): input helpers, the tools through the
// real call path (grants, approvals voided on change) with a fake PHP bridge,
// and the event feed on sqlite copies of the CalDAV tables. The PHP side is
// tests/lib/Agent/AtriumAgentCalendarTest.php (real CalDAV backend).
import { beforeEach, expect, test } from 'bun:test'
import { normalizeModes, setAccess } from '../access'
import { Approvals } from '../approvals'
import { type Db, getMeta, migrate, wrap } from '../db'
import { callTool, Registry, type ToolCtx } from '../tools'
import { type CalendarBridge, calendarTools, pick, range } from './index'
import { CalendarFeed, CURSOR, icalDate, icalProp, SOON_SEC, type Upcoming } from './feed'

let db: Db

beforeEach(async () => {
	db = wrap(new Bun.SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
})

test('range: defaults, order and the 366-day cap', () => {
	const now = new Date('2026-11-13T10:00:00Z')
	expect(range({}, now)).toEqual({ from: '2026-11-13T10:00:00.000Z', to: '2026-11-20T10:00:00.000Z' })
	expect(range({ from: '2026-12-01T00:00:00+01:00' }, now)).toEqual({ from: '2026-11-30T23:00:00.000Z', to: '2026-12-07T23:00:00.000Z' })
	expect(() => range({ from: '2026-12-01', to: '2026-11-01' }, now)).toThrow('to must be after from')
	expect(() => range({ from: '2026-01-01', to: '2027-06-01' }, now)).toThrow('366 days')
	expect(() => range({ from: 'tomorrow' }, now)).toThrow('not an ISO date')
})

test('pick keeps sent fields only, nulls included', () => {
	expect(pick({ title: 'a', location: null, other: 1 }, ['title', 'location', 'description'])).toEqual({ title: 'a', location: null })
})

test('icalProp: unfolds, unescapes, ignores parameters', () => {
	const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY;LANGUAGE=fr:Payer les imp\r\n ôts\\, vite\r\nDUE;VALUE=DATE:20261130\r\nSTATUS:COMPLETED\r\nEND:VTODO\r\nEND:VCALENDAR\r\n'
	expect(icalProp(ics, 'SUMMARY')).toBe('Payer les impôts, vite')
	expect(icalProp(ics, 'DUE')).toBe('20261130')
	expect(icalProp(ics, 'LOCATION')).toBeNull()
	expect(icalDate(ics, 'DUE')).toEqual({ value: '2026-11-30' })
	expect(icalDate('DTSTART:20261120T090000Z', 'DTSTART')).toEqual({ value: '2026-11-20T09:00:00Z' })
	expect(icalDate('DTSTART;TZID=Europe/Paris:20261120T090000', 'DTSTART')).toEqual({ value: '2026-11-20T09:00:00', tz: 'Europe/Paris' })
	expect(icalDate('X:1', 'DTSTART')).toBeNull()
})

// ------------------------------------------------------------- tools

function fakeCalendar() {
	const calls: Array<{ op: string, uid: string, args: Record<string, unknown> }> = []
	let etag = '"e1"'
	const bridge: CalendarBridge = {
		async call<T>(op: string, uid: string, args: Record<string, unknown> = {}) {
			calls.push({ op, uid, args })
			const out: Record<string, unknown> = op === 'event' ? { event_id: args.event_id, title: 'Dentist', start: '2026-11-20T09:00:00Z', etag, recurring: false }
				: op === 'task' ? { task_id: args.task_id, title: 'Taxes', etag }
				: op === 'etag' ? { etag }
				: op === 'task_update' ? { task_id: args.task_id, done: (args.fields as { done?: boolean }).done ?? false, completed_at: null }
				: { ok: true, title: 'Dentist' }
			return out as T
		},
	}
	return { bridge, calls, touch: () => { etag = '"e2"' } }
}

function setup() {
	const cal = fakeCalendar()
	const approvals = new Approvals(db, null, 'https://x/settings/agents')
	const registry = new Registry()
	registry.add(...calendarTools(cal.bridge))
	const base = { db, php: null as never, agent: { uid: 'bot', displayName: 'Bot', owner: 'alice' }, baseUrl: 'https://x', approvals }
	approvals.registry = registry
	approvals.ctxFor = async (_agent, grantor) => ({ ...base, grantor, access: {} } as ToolCtx)
	return { ...cal, approvals, registry, base }
}

const grant = (area: string, modes: Record<string, string>) => setAccess(db, 'bot', 'alice', area, normalizeModes(modes as never, ['read', 'write', 'delete', 'share']))

test('calendar and tasks are separate grants', async () => {
	const { registry, base, calls } = setup()
	await expect(callTool(registry, base, 'calendar_list', {})).rejects.toMatchObject({ code: 'forbidden' })
	await grant('calendar', { read: 'allowed' })
	await callTool(registry, base, 'calendar_list', {})
	await expect(callTool(registry, base, 'task_list', {})).rejects.toMatchObject({ code: 'forbidden' })
	await expect(callTool(registry, base, 'calendar_event_create', { title: 'x', start: '2026-11-20T09:00:00Z' })).rejects.toMatchObject({ code: 'forbidden' })
	await grant('tasks', { read: 'allowed', write: 'allowed' })
	await callTool(registry, base, 'task_list', { status: 'all' })
	await expect(callTool(registry, base, 'task_list', { status: 'later' })).rejects.toMatchObject({ code: 'invalid_input' })
	expect(calls.map((c) => [c.op, c.uid])).toEqual([['calendars', 'alice'], ['tasks', 'alice']])
	expect(calls[1].args).toMatchObject({ status: 'all', limit: 100 })
})

test('writes send only the fields given; list gets a default range', async () => {
	const { registry, base, calls } = setup()
	await grant('calendar', { read: 'allowed', write: 'allowed' })
	await grant('tasks', { read: 'allowed', write: 'allowed' })
	await callTool(registry, base, 'calendar_event_list', { from: '2026-11-13T00:00:00Z' })
	await callTool(registry, base, 'calendar_event_create', { title: 'Lunch', start: '2026-11-20T12:00:00+01:00', location: 'Chez Paul' })
	await callTool(registry, base, 'calendar_event_update', { event_id: '3/a.ics', location: null, etag: '"e1"' })
	await callTool(registry, base, 'task_complete', { task_id: '4/t.ics' })
	await callTool(registry, base, 'task_create', { title: 'Sub', parent_id: '4/t.ics', due: '2026-11-30' })
	expect(calls.map((c) => [c.op, c.args])).toEqual([
		['events', { from: '2026-11-13T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z', calendar_id: undefined, query: undefined, limit: 100 }],
		['event_create', { calendar_id: undefined, fields: { title: 'Lunch', start: '2026-11-20T12:00:00+01:00', location: 'Chez Paul' } }],
		['event_update', { event_id: '3/a.ics', etag: '"e1"', fields: { location: null } }],
		['task_update', { task_id: '4/t.ics', fields: { done: true } }],
		['task_create', { calendar_id: undefined, parent_id: '4/t.ics', fields: { title: 'Sub', due: '2026-11-30' } }],
	])
	await expect(callTool(registry, base, 'calendar_event_create', { title: 'No start' })).rejects.toMatchObject({ code: 'invalid_input' })
})

test('delete: approval by default, executed with the etag read at request time, void if the event changed', async () => {
	const { registry, base, calls, approvals, touch } = setup()
	await grant('calendar', { read: 'allowed', write: 'allowed' })
	const p = await callTool(registry, base, 'calendar_event_delete', { event_id: '3/a.ics' }) as { status: string, request_id: string }
	expect(p.status).toBe('pending_approval')
	expect((await approvals.get(p.request_id))!.summary).toBe('Delete the event "Dentist" on 2026-11-20 09:00')
	expect(calls.some((c) => c.op === 'event_delete')).toBe(false)
	const done = await approvals.approve('alice', p.request_id, null)
	expect(done.status).toBe('executed')
	expect(calls.at(-1)).toMatchObject({ op: 'event_delete', args: { event_id: '3/a.ics', etag: '"e1"' } })

	const p2 = await callTool(registry, base, 'calendar_event_delete', { event_id: '3/a.ics' }) as { request_id: string }
	touch() // someone edited the event after the request
	expect((await approvals.approve('alice', p2.request_id, null)).status).toBe('void')
	expect(calls.filter((c) => c.op === 'event_delete').length).toBe(1)

	await grant('tasks', { read: 'allowed', write: 'allowed', delete: 'allowed' })
	expect(await callTool(registry, base, 'task_delete', { task_id: '4/t.ics' })).toMatchObject({ task_id: '4/t.ics', deleted: true, in_trash: true })
})

// ------------------------------------------------------------- feed

async function davTables() {
	await db.q('CREATE TABLE oc_calendars (id INTEGER PRIMARY KEY, principaluri TEXT, displayname TEXT)')
	await db.q('CREATE TABLE oc_calendarchanges (id INTEGER PRIMARY KEY AUTOINCREMENT, uri TEXT, synctoken INTEGER, calendarid INTEGER, operation INTEGER, calendartype INTEGER DEFAULT 0)')
	await db.q('CREATE TABLE oc_calendarobjects (id INTEGER PRIMARY KEY AUTOINCREMENT, calendarid INTEGER, uri TEXT, calendartype INTEGER DEFAULT 0, componenttype TEXT, calendardata BLOB)')
	await db.q('CREATE TABLE oc_dav_shares (id INTEGER PRIMARY KEY AUTOINCREMENT, principaluri TEXT, type TEXT, access INTEGER, resourceid INTEGER)')
	await db.q("INSERT INTO oc_calendars VALUES (1, 'principals/users/alice', 'Home'), (2, 'principals/users/bob', 'Family'), (3, 'principals/system/system', 'Sys')")
	await db.q("INSERT INTO oc_dav_shares (principaluri, type, access, resourceid) VALUES ('principals/users/alice', 'calendar', 2, 2), ('principals/groups/staff', 'calendar', 2, 2)")
}

const ics = (comp: string, props: string) => `BEGIN:VCALENDAR\r\nBEGIN:${comp}\r\nUID:x\r\n${props}END:${comp}\r\nEND:VCALENDAR\r\n`
const change = (cal: number, uri: string, op: number, type = 0) => db.q('INSERT INTO oc_calendarchanges (uri, synctoken, calendarid, operation, calendartype) VALUES ($1, 1, $2, $3, $4)', [uri, cal, op, type])
const object = (cal: number, uri: string, comp: string, props: string) => db.q('INSERT INTO oc_calendarobjects (calendarid, uri, componenttype, calendardata) VALUES ($1, $2, $3, $4)', [cal, uri, comp, ics(comp, props)])
const queued = async () => (await db.q<{ type: string, area: string, grantor_uid: string, wake_hint: number, data: string }>('SELECT * FROM oc_atrium_agent_event_queue ORDER BY id'))
	.map((r) => ({ type: r.type, area: r.area, grantor: r.grantor_uid, wake: Number(r.wake_hint), data: JSON.parse(r.data) }))

test('feed: history is skipped, then every change becomes one event per owner and sharee', async () => {
	await davTables()
	await object(1, 'old.ics', 'VEVENT', 'SUMMARY:Old\r\n')
	await change(1, 'old.ics', 1)
	const feed = new CalendarFeed(db, null)
	await feed.init()
	expect(await feed.tick()).toBe(0) // the old change is history

	await object(1, 'a.ics', 'VEVENT', 'SUMMARY:Dentist\r\nDTSTART:20261120T090000Z\r\n')
	await change(1, 'a.ics', 1)
	await change(1, 'a.ics', 2)
	await object(2, 't.ics', 'VTODO', 'SUMMARY:Pay rent\r\nSTATUS:COMPLETED\r\nCOMPLETED:20261113T100000Z\r\n')
	await change(2, 't.ics', 2) // completed, in bob's calendar shared with alice
	await change(2, 't.ics', 2) // edited again while done: no second task.completed
	await object(1, 'b-deleted.ics', 'VEVENT', 'SUMMARY:Gym\r\n') // trashed copy
	await change(1, 'b.ics', 3)
	await change(1, '', 2) // calendar-level change: ignored
	await change(1, 'gone.ics', 3) // hard delete, nothing left: ignored
	await change(3, 's.ics', 1) // not a user's calendar
	await change(1, 'sub.ics', 1, 1) // subscription cache
	expect(await feed.tick()).toBe(8) // the subscription row is not read
	const q = await queued()
	expect(q.map((e) => [e.type, e.area, e.grantor])).toEqual([
		['calendar.event.created', 'calendar', 'alice'],
		['calendar.event.updated', 'calendar', 'alice'],
		['task.completed', 'tasks', 'bob'],
		['task.completed', 'tasks', 'alice'],
		['calendar.event.deleted', 'calendar', 'alice'],
	])
	expect(q[0].data).toEqual({ calendar_id: '1', calendar_name: 'Home', title: 'Dentist', event_id: '1/a.ics', start: '2026-11-20T09:00:00Z', recurring: false })
	expect(q[3].data).toMatchObject({ task_id: '2/t.ics', title: 'Pay rent', done: true, shared_by: 'bob' })
	expect(q[4].data).toMatchObject({ event_id: '1/b.ics', title: 'Gym', in_trash: true })
	expect(q.every((e) => e.wake === 0)).toBe(true)
	expect(Number(await getMeta(db, CURSOR))).toBe(9)
	expect(await feed.tick()).toBe(0)
})

test('reminders: events starting and timed tasks due within 15 min, once, only for grantors with read access', async () => {
	await grant('calendar', { read: 'allowed' })
	await grant('tasks', { read: 'allowed' })
	await setAccess(db, 'bot2', 'carol', 'calendar', normalizeModes({ read: 'off' } as never, ['read', 'write']))
	const now = Date.parse('2026-11-13T10:00:00Z') / 1000
	const at = (min: number) => new Date((now + min * 60) * 1000).toISOString().replace('.000', '')
	const asked: string[] = []
	const upcoming: Upcoming = {
		events: async (uid) => {
			asked.push(uid)
			return [
				{ event_id: '1/a.ics', title: 'Call', start: at(10), end: at(40), all_day: false, location: null, calendar_id: '1', occurrence: null },
				{ event_id: '1/b.ics', title: 'Started', start: at(-5), end: at(30), all_day: false, location: null, calendar_id: '1', occurrence: null },
				{ event_id: '1/c.ics', title: 'Holiday', start: '2026-11-13', end: '2026-11-14', all_day: true, location: null, calendar_id: '1', occurrence: null },
				{ event_id: '1/d.ics', title: 'Later', start: at(16), end: at(30), all_day: false, location: null, calendar_id: '1', occurrence: null },
			]
		},
		tasks: async () => [
			{ task_id: '4/t.ics', title: 'Send report', due: at(5), calendar_id: '4' },
			{ task_id: '4/u.ics', title: 'Some day', due: '2026-11-13', calendar_id: '4' },
		],
	}
	const feed = new CalendarFeed(db, upcoming, () => now)
	expect(await feed.remind()).toBe(2)
	expect(asked).toEqual(['alice'])
	expect(await feed.remind()).toBe(2) // asked again, but the queue keeps one row per occurrence
	const q = await queued()
	expect(q.map((e) => [e.type, e.area, e.grantor, e.wake])).toEqual([['calendar.event.starting', 'calendar', 'alice', 1], ['task.due', 'tasks', 'alice', 1]])
	expect(q[0].data).toMatchObject({ title: 'Call', in_minutes: 10 })
	expect(SOON_SEC).toBe(900)
})
