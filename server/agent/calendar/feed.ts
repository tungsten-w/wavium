// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// calendar.* and task.* events (PLAN P3-2, ADR 0006).
//
// 1. Changes: CalDAV writes every add / change / delete of an object into
//    `calendarchanges` (it is what DAV sync uses), whoever made it: web UI,
//    phone, Thunderbird or an agent. This watcher reads new rows in order and
//    queues calendar.event.created / updated / deleted and task.created /
//    updated / completed / deleted for the calendar's owner and for every
//    user it is shared with (their agents see shared calendars too).
// 2. Reminders: every minute, for the users that granted an agent calendar
//    (tasks) read access, events starting within the next 15 minutes give
//    calendar.event.starting, timed tasks due within 15 minutes task.due.
//    These are wake hints: an agent with wakes on gets a doorbell.
//
// History is not replayed: the first start only records where the log is.
import { getMeta, num, setMeta, type Db } from '../db'
import { enqueue, type NewEvent } from '../events'
import { nowSec } from '../util'

export const SOON_SEC = 15 * 60
export const CURSOR = 'calendar_changes_seen'
const BATCH = 500

/** What the reminder pass needs from PHP (one call per user). */
export interface Upcoming {
	events(uid: string, from: Date, to: Date): Promise<Array<{ event_id: string, title: string, start: string | null, end: string | null, all_day: boolean, location: string | null, calendar_id: string, occurrence: string | null }>>
	tasks(uid: string, dueBefore: Date): Promise<Array<{ task_id: string, title: string, due: string | null, calendar_id: string }>>
}

interface ChangeRow {
	id: unknown
	uri: string
	operation: unknown
	calendarid: unknown
	principaluri: string
	calname: string | null
}

interface ObjectRow { uri: string, componenttype: string | null, calendardata: unknown }

const userOf = (principal: string): string | null => {
	const m = /^principals\/users\/(.+)$/.exec(principal)
	return m ? m[1] : null
}

const text = (v: unknown): string => (v instanceof Uint8Array ? new TextDecoder().decode(v) : typeof v === 'string' ? v : v == null ? '' : String(v))

/** First value of an iCalendar property in the first VEVENT/VTODO (unfolded, unescaped). */
export function icalProp(data: string, prop: string): string | null {
	const unfolded = data.replace(/\r?\n[ \t]/g, '')
	const m = new RegExp(`^${prop}(?:;[^:\\r\\n]*)?:(.*)$`, 'm').exec(unfolded)
	if (!m) return null
	return m[1].replace(/\r$/, '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim()
}

/**
 * A DATE / DATE-TIME property as the tools show it: "2026-11-25" (all-day),
 * "2026-11-25T10:00:00Z" (UTC), or local time plus its zone for TZID values.
 */
export function icalDate(data: string, prop: string): { value: string, tz?: string } | null {
	const unfolded = data.replace(/\r?\n[ \t]/g, '')
	const m = new RegExp(`^${prop}((?:;[^:\\r\\n]*)?):(.*)$`, 'm').exec(unfolded)
	if (!m) return null
	const v = m[2].replace(/\r$/, '').trim()
	const tz = /;TZID=([^;:]+)/i.exec(m[1])?.[1]?.replace(/^"|"$/g, '')
	const d = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(v)
	if (!d) return { value: v }
	if (!d[4]) return { value: `${d[1]}-${d[2]}-${d[3]}` }
	const value = `${d[1]}-${d[2]}-${d[3]}T${d[4]}:${d[5]}:${d[6]}${d[7] ? 'Z' : ''}`
	return tz && !d[7] ? { value, tz } : { value }
}

const dateFields = (data: string, prop: string, key: string): Record<string, string | null> => {
	const d = icalDate(data, prop)
	return { [key]: d?.value ?? null, ...(d?.tz ? { [`${key}_tz`]: d.tz } : {}) }
}

/** The object's id the tools use ("<calendar id>/<uri>"); a trashed copy keeps its original uri. */
const trashUri = (uri: string) => uri.replace(/\.ics$/, '-deleted.ics')

export class CalendarFeed {
	private timer: ReturnType<typeof setInterval> | null = null
	private remindTimer: ReturnType<typeof setInterval> | null = null
	private busy = false
	private reminding = false

	constructor(private db: Db, private upcoming: Upcoming | null, private now: () => number = nowSec) {}

	async init(): Promise<void> {
		if (await getMeta(this.db, CURSOR) !== null) return
		const max = num((await this.db.q<{ m: unknown }>(`SELECT MAX(id) AS m FROM ${this.db.t('calendarchanges')}`))[0]?.m)
		await setMeta(this.db, CURSOR, String(max))
	}

	start(everyMs = 5000): void {
		const run = () => { void this.tick().catch((e) => console.error(`agent calendar feed: ${(e as Error).message}`)) }
		void this.init().then(run).catch((e) => console.error(`agent calendar feed init: ${(e as Error).message}`))
		this.timer = setInterval(run, everyMs)
		if (this.upcoming) {
			this.remindTimer = setInterval(() => { void this.remind().catch((e) => console.error(`agent calendar reminders: ${(e as Error).message}`)) }, 60_000)
		}
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer)
		if (this.remindTimer) clearInterval(this.remindTimer)
	}

	/** Users a calendar is shared with (user shares only; group shares are not expanded). */
	private async sharees(calendarId: number): Promise<string[]> {
		const rows = await this.db.q<{ principaluri: string }>(
			`SELECT principaluri FROM ${this.db.t('dav_shares')} WHERE type = 'calendar' AND resourceid = $1`, [calendarId])
		return rows.map((r) => userOf(r.principaluri)).filter((u): u is string => !!u)
	}

	/** Moves the cursor over new change rows and queues their events. Returns how many rows were read. */
	async tick(): Promise<number> {
		if (this.busy) return 0
		this.busy = true
		try {
			const seen = num(await getMeta(this.db, CURSOR))
			const rows = await this.db.q<ChangeRow>(`SELECT c.id, c.uri, c.operation, c.calendarid, cal.principaluri, cal.displayname AS calname
				FROM ${this.db.t('calendarchanges')} c JOIN ${this.db.t('calendars')} cal ON cal.id = c.calendarid
				WHERE c.id > $1 AND c.calendartype = 0 ORDER BY c.id LIMIT ${BATCH}`, [seen])
			let last = seen
			const shareCache = new Map<number, string[]>()
			for (const r of rows) {
				last = num(r.id)
				const owner = userOf(r.principaluri)
				if (!owner || !r.uri) continue // calendar-level change, or not a user's calendar
				const cal = num(r.calendarid)
				const op = num(r.operation)
				const [obj] = await this.db.q<ObjectRow>(`SELECT uri, componenttype, calendardata FROM ${this.db.t('calendarobjects')}
					WHERE calendarid = $1 AND calendartype = 0 AND (uri = $2 OR uri = $3)`, [cal, r.uri, trashUri(r.uri)])
				const comp = obj?.componenttype ?? null
				const data = obj ? text(obj.calendardata) : ''
				const isTask = comp === 'VTODO'
				if (comp !== 'VEVENT' && comp !== 'VTODO') continue // hard-deleted (no row left) or a VJOURNAL
				const title = icalProp(data, 'SUMMARY') ?? ''
				const id = `${cal}/${r.uri}`
				let type: string
				const payload: Record<string, unknown> = { calendar_id: String(cal), calendar_name: r.calname, title }
				if (isTask) {
					payload.task_id = id
					const done = (icalProp(data, 'STATUS') ?? '').toUpperCase() === 'COMPLETED'
					type = op === 1 ? 'task.created' : op === 3 ? 'task.deleted' : done ? 'task.completed' : 'task.updated'
					if (op !== 3) Object.assign(payload, dateFields(data, 'DUE', 'due'))
					payload.done = done
				} else {
					payload.event_id = id
					type = op === 1 ? 'calendar.event.created' : op === 3 ? 'calendar.event.deleted' : 'calendar.event.updated'
					if (op !== 3) {
						Object.assign(payload, dateFields(data, 'DTSTART', 'start'))
						payload.recurring = icalProp(data, 'RRULE') !== null
					}
				}
				if (op === 3) payload.in_trash = obj.uri !== r.uri
				if (!shareCache.has(cal)) shareCache.set(cal, await this.sharees(cal))
				for (const grantor of [owner, ...shareCache.get(cal)!.filter((u) => u !== owner)]) {
					const e: NewEvent = {
						app: 'calendar',
						area: isTask ? 'tasks' : 'calendar',
						type,
						grantor,
						wakeHint: false,
						data: grantor === owner ? payload : { ...payload, shared_by: owner },
						// A completion seen twice (an edit of a done task) is still one event.
						dedupeKey: type === 'task.completed' ? `task-completed:${grantor}:${id}:${icalProp(data, 'COMPLETED') ?? last}` : `calchg:${grantor}:${last}`,
					}
					await enqueue(this.db, e)
				}
			}
			if (last !== seen) await setMeta(this.db, CURSOR, String(last))
			return rows.length
		} finally {
			this.busy = false
		}
	}

	/** Users with an agent that has read access on an area (and is not paused: checked at delivery). */
	private async grantors(area: string): Promise<string[]> {
		const rows = await this.db.q<{ grantor_uid: string, modes: string }>(`SELECT DISTINCT grantor_uid, modes FROM ${this.db.t('atrium_agent_access')} WHERE area = $1`, [area])
		const out = new Set<string>()
		for (const r of rows) {
			try {
				const m = JSON.parse(r.modes) as Record<string, string>
				if (m.read && m.read !== 'off') out.add(r.grantor_uid)
			} catch { /* a broken row grants nothing */ }
		}
		return [...out]
	}

	/** One reminder pass: events starting and timed tasks due within SOON_SEC. */
	async remind(): Promise<number> {
		if (!this.upcoming || this.reminding) return 0
		this.reminding = true
		let queued = 0
		try {
			const now = this.now()
			const from = new Date(now * 1000)
			const to = new Date((now + SOON_SEC) * 1000)
			for (const uid of await this.grantors('calendar')) {
				let events: Awaited<ReturnType<Upcoming['events']>>
				try {
					events = await this.upcoming.events(uid, from, to)
				} catch (e) {
					console.error(`agent calendar reminders (${uid}): ${(e as Error).message}`)
					continue
				}
				for (const ev of events) {
					if (ev.all_day || !ev.start) continue
					const start = Date.parse(ev.start) / 1000
					if (!(start > now && start <= now + SOON_SEC)) continue // already started, or later
					await enqueue(this.db, {
						app: 'calendar', area: 'calendar', type: 'calendar.event.starting', grantor: uid, wakeHint: true,
						data: { event_id: ev.event_id, calendar_id: ev.calendar_id, title: ev.title, start: ev.start, end: ev.end, location: ev.location, occurrence: ev.occurrence, in_minutes: Math.round((start - now) / 60) },
						dedupeKey: `cal-start:${uid}:${ev.event_id}:${ev.start}`,
					})
					queued++
				}
			}
			for (const uid of await this.grantors('tasks')) {
				let tasks: Awaited<ReturnType<Upcoming['tasks']>>
				try {
					tasks = await this.upcoming.tasks(uid, to)
				} catch (e) {
					console.error(`agent task reminders (${uid}): ${(e as Error).message}`)
					continue
				}
				for (const t of tasks) {
					if (!t.due || !t.due.includes('T')) continue // date-only due: no time to remind at
					const due = Date.parse(t.due) / 1000
					if (!(due > now && due <= now + SOON_SEC)) continue
					await enqueue(this.db, {
						app: 'calendar', area: 'tasks', type: 'task.due', grantor: uid, wakeHint: true,
						data: { task_id: t.task_id, calendar_id: t.calendar_id, title: t.title, due: t.due, in_minutes: Math.round((due - now) / 60) },
						dedupeKey: `task-due:${uid}:${t.task_id}:${t.due}`,
					})
					queued++
				}
			}
			return queued
		} finally {
			this.reminding = false
		}
	}
}
