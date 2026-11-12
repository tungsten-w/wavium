// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CalDAV for the Calendar UI. Events in a range come from one calendar-query per
// calendar with <expand>, so the server resolves recurrence and every instance
// arrives with UTC times. Editing works on the stored object (master + overrides).
import { DAV_ROOT, dav, request, escapeText, getProp, parseComponent, serializeComponent, unescapeText, uuid, type VComponent, type VProp } from '@atrium/sdk'
import { ensureTimezone, icsUtc, localZone, parseIcsTime, timeProp, type IcsTime } from '@atrium/sdk'

export interface Cal {
	url: string
	id: string
	name: string
	color: string
	readOnly: boolean
	shared: boolean
	/** Subscribed iCal URL: read-only, events come from the Calendar app route, not CalDAV. */
	sub?: boolean
	ctag: string
}

export interface Instance {
	key: string
	cal: Cal
	url: string
	etag: string | null
	uid: string
	title: string
	start: Date
	end: Date
	allDay: boolean
	location: string
	description: string
	/** Original start of this occurrence (UTC ICS value) when the event repeats. */
	recurrenceId: string | null
	color: string
}

export const homeUrl = (user: string) => `${DAV_ROOT}/calendars/${encodeURIComponent(user)}/`
const CALDAV = 'urn:ietf:params:xml:ns:caldav'
const CS = 'http://calendarserver.org/ns/'

export async function listCalendars(user: string): Promise<Cal[]> {
	const rs = await dav.propfind(homeUrl(user), ['d:displayname', 'd:resourcetype', 'x1:calendar-color', 'cs:getctag', 'oc:read-only', 'oc:owner-principal', 'cal:supported-calendar-component-set', 'x1:calendar-order'], 1)
	return rs
		.filter((r) => r.elements['d:resourcetype']?.getElementsByTagNameNS(CALDAV, 'calendar').length || r.elements['d:resourcetype']?.getElementsByTagNameNS(CS, 'subscribed').length)
		.filter((r) => {
			const set = r.elements['cal:supported-calendar-component-set']
			return !set || Array.from(set.getElementsByTagNameNS(CALDAV, 'comp')).some((c) => c.getAttribute('name') === 'VEVENT')
		})
		.map((r) => {
			const id = r.href.replace(/\/$/, '').split('/').pop() ?? ''
			return {
				url: r.href.endsWith('/') ? r.href : r.href + '/',
				id,
				name: r.props['d:displayname'] || id,
				color: (r.props['x1:calendar-color'] || '#0082c9').slice(0, 7),
				readOnly: !!r.elements['d:resourcetype']?.getElementsByTagNameNS(CS, 'subscribed').length || r.props['oc:read-only'] === 'true' || r.props['oc:read-only'] === '1' || id === 'contact_birthdays',
				shared: !!r.props['oc:owner-principal'] && !r.props['oc:owner-principal'].endsWith(`/${user}`),
				ctag: r.props['cs:getctag'] ?? '',
				sub: !!r.elements['d:resourcetype']?.getElementsByTagNameNS(CS, 'subscribed').length,
				order: Number(r.props['x1:calendar-order'] ?? 0),
			}
		})
		.sort((a, b) => Number(a.shared) - Number(b.shared) || a.order - b.order || a.name.localeCompare(b.name))
		.map(({ order: _o, ...c }) => c)
}

export async function listInstances(cal: Cal, from: Date, to: Date): Promise<Instance[]> {
	const s = icsUtc(from)
	const e = icsUtc(to)
	if (cal.sub) return listSubscribed(cal, from, to)
	const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><d:getetag/><c:calendar-data><c:expand start="${s}" end="${e}"/></c:calendar-data></d:prop>`
		+ `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${s}" end="${e}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`
	const rs = await dav.report(cal.url, body, 1)
	const out: Instance[] = []
	for (const r of rs) {
		const data = r.props['cal:calendar-data']
		if (!data) continue
		const root = parseComponent(data)
		for (const ev of root.children.filter((c) => c.name === 'VEVENT')) {
			const st = parseIcsTime(getProp(ev, 'DTSTART'))
			if (!st) continue
			const en = parseIcsTime(getProp(ev, 'DTEND')) ?? endFromDuration(st, getProp(ev, 'DURATION')?.value)
			const rid = getProp(ev, 'RECURRENCE-ID')?.value ?? null
			const uid = getProp(ev, 'UID')?.value ?? r.href
			out.push({
				key: `${r.href}#${rid ?? ''}`, cal, url: r.href, etag: r.props['d:getetag'] ?? null, uid,
				title: unescapeText(getProp(ev, 'SUMMARY')?.value ?? '') || 'Untitled event',
				start: st.date, end: en.date, allDay: st.allDay,
				location: unescapeText(getProp(ev, 'LOCATION')?.value ?? ''),
				description: unescapeText(getProp(ev, 'DESCRIPTION')?.value ?? ''),
				recurrenceId: rid, color: cal.color,
			})
		}
	}
	return out
}

function endFromDuration(st: IcsTime, dur?: string): IcsTime {
	const m = dur && /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(dur)
	if (!m) return { date: st.allDay ? new Date(st.date.getFullYear(), st.date.getMonth(), st.date.getDate() + 1) : st.date, allDay: st.allDay }
	const days = Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)
	const ms = ((Number(m[4] ?? 0) * 60 + Number(m[5] ?? 0)) * 60 + Number(m[6] ?? 0)) * 1000
	const d = new Date(st.date.getFullYear(), st.date.getMonth(), st.date.getDate() + days, st.date.getHours(), st.date.getMinutes(), st.date.getSeconds())
	return { date: new Date(d.getTime() + ms), allDay: st.allDay }
}

// ---- Editing ---------------------------------------------------------------

export type Repeat = 'none' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY' | 'custom'
export type Reminder = 'none' | '0' | '-PT10M' | '-PT15M' | '-PT30M' | '-PT1H' | '-P1D' | 'custom'
export const REMINDERS: { id: Reminder, label: string }[] = [
	{ id: 'none', label: 'No reminder' }, { id: '0', label: 'At the start' }, { id: '-PT10M', label: '10 minutes before' },
	{ id: '-PT15M', label: '15 minutes before' }, { id: '-PT30M', label: '30 minutes before' }, { id: '-PT1H', label: '1 hour before' }, { id: '-P1D', label: '1 day before' },
]

export interface EventForm {
	title: string
	allDay: boolean
	start: Date
	/** Exclusive for timed events; for all-day events the last day (inclusive) in the form. */
	end: Date
	location: string
	description: string
	repeat: Repeat
	reminder: Reminder
}

export interface StoredObject { url: string, etag: string | null, root: VComponent, cal: Cal }

export async function loadObject(inst: Instance): Promise<StoredObject> {
	const { text, etag } = await dav.get(inst.url)
	return { url: inst.url, etag: etag ?? inst.etag, root: parseComponent(text), cal: inst.cal }
}

export const masterOf = (root: VComponent) => root.children.find((c) => c.name === 'VEVENT' && !getProp(c, 'RECURRENCE-ID'))
export const overrideOf = (root: VComponent, rid: string) => root.children.find((c) => c.name === 'VEVENT' && sameInstant(getProp(c, 'RECURRENCE-ID'), rid))
function sameInstant(p: VProp | undefined, utcValue: string): boolean {
	if (!p) return false
	const a = parseIcsTime(p)
	const b = parseIcsTime({ name: 'X', params: {}, value: utcValue })
	return !!a && !!b && a.date.getTime() === b.date.getTime()
}

export function formFrom(ev: VComponent | undefined, inst: Instance | null, defaults: Partial<EventForm> = {}): EventForm {
	const rrule = ev ? getProp(ev, 'RRULE')?.value : undefined
	const freq = rrule ? /FREQ=(\w+)/.exec(rrule)?.[1] : undefined
	const simple = rrule && /^FREQ=\w+(;INTERVAL=1)?(;WKST=\w+)?$/.test(rrule)
	const alarms = ev?.children.filter((c) => c.name === 'VALARM') ?? []
	const trig = alarms.length === 1 ? getProp(alarms[0], 'TRIGGER') : undefined
	const trigVal = trig && !trig.params.VALUE && trig.params.RELATED !== 'END' ? trig.value.replace(/^PT0S$|^-PT0M$|^PT0M$|^-PT0S$/, '0') : undefined
	const reminder: Reminder = alarms.length === 0 ? 'none' : REMINDERS.some((r) => r.id === trigVal) ? trigVal as Reminder : 'custom'
	const allDay = inst?.allDay ?? defaults.allDay ?? false
	const start = inst?.start ?? defaults.start ?? new Date()
	let end = inst?.end ?? defaults.end ?? new Date(start.getTime() + 3600000)
	if (allDay) end = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1)
	return {
		title: ev ? unescapeText(getProp(ev, 'SUMMARY')?.value ?? '') : defaults.title ?? '',
		allDay, start, end,
		location: ev ? unescapeText(getProp(ev, 'LOCATION')?.value ?? '') : '',
		description: ev ? unescapeText(getProp(ev, 'DESCRIPTION')?.value ?? '') : '',
		repeat: !rrule ? 'none' : simple && freq ? freq as Repeat : 'custom',
		reminder: ev ? reminder : defaults.reminder ?? 'none',
	}
}

const EDITED = new Set(['SUMMARY', 'LOCATION', 'DESCRIPTION', 'DTSTART', 'DTEND', 'DURATION', 'DTSTAMP', 'LAST-MODIFIED', 'SEQUENCE'])

/** Write the form into a VEVENT (in place). Times: all-day -> DATE, else local zone. */
function applyForm(ev: VComponent, f: EventForm, opts: { start: IcsTime, end: IcsTime, repeat: boolean }) {
	const tz = localZone()
	const seq = Number(getProp(ev, 'SEQUENCE')?.value ?? 0)
	ev.props = ev.props.filter((p) => !EDITED.has(p.name))
	const now = icsUtc(new Date())
	ev.props.push(
		{ name: 'DTSTAMP', params: {}, value: now },
		{ name: 'LAST-MODIFIED', params: {}, value: now },
		{ name: 'SEQUENCE', params: {}, value: String(seq + 1) },
		{ name: 'SUMMARY', params: {}, value: escapeText(f.title.trim() || 'Untitled event') },
		timeProp('DTSTART', opts.start, tz),
		timeProp('DTEND', opts.end, tz),
	)
	if (f.location.trim()) ev.props.push({ name: 'LOCATION', params: {}, value: escapeText(f.location.trim()) })
	if (f.description.trim()) ev.props.push({ name: 'DESCRIPTION', params: {}, value: escapeText(f.description) })
	if (opts.repeat && f.repeat !== 'custom') {
		ev.props = ev.props.filter((p) => p.name !== 'RRULE' && (f.repeat !== 'none' || (p.name !== 'EXDATE' && p.name !== 'RDATE')))
		if (f.repeat !== 'none') ev.props.push({ name: 'RRULE', params: {}, value: `FREQ=${f.repeat}` })
	}
	if (f.reminder !== 'custom') {
		ev.children = ev.children.filter((c) => c.name !== 'VALARM')
		if (f.reminder !== 'none') {
			ev.children.push({ name: 'VALARM', children: [], props: [
				{ name: 'ACTION', params: {}, value: 'DISPLAY' },
				{ name: 'DESCRIPTION', params: {}, value: escapeText(f.title.trim() || 'Reminder') },
				{ name: 'TRIGGER', params: {}, value: f.reminder === '0' ? '-PT0M' : f.reminder },
			] })
		}
	}
}

/** Form times -> ICS times (all-day end is exclusive in ICS). */
function formTimes(f: EventForm): { start: IcsTime, end: IcsTime } {
	if (f.allDay) {
		const s = new Date(f.start.getFullYear(), f.start.getMonth(), f.start.getDate())
		const e = new Date(f.end.getFullYear(), f.end.getMonth(), Math.max(f.end.getDate(), 0) + 1)
		return { start: { date: s, allDay: true }, end: { date: e > s ? e : new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1), allDay: true } }
	}
	const end = f.end > f.start ? f.end : new Date(f.start.getTime() + 3600000)
	return { start: { date: f.start, allDay: false }, end: { date: end, allDay: false } }
}

async function put(cal: Cal, url: string | null, root: VComponent, etag: string | null): Promise<void> {
	const text = serializeComponent(root) + '\r\n'
	await dav.put(url ?? `${cal.url}${uuid()}.ics`, text, 'text/calendar; charset=utf-8', url ? { etag } : { create: true })
}

export async function createEvent(cal: Cal, f: EventForm): Promise<void> {
	const ev: VComponent = { name: 'VEVENT', props: [{ name: 'UID', params: {}, value: uuid() }, { name: 'CREATED', params: {}, value: icsUtc(new Date()) }], children: [] }
	applyForm(ev, f, { ...formTimes(f), repeat: true })
	const root: VComponent = { name: 'VCALENDAR', children: [ev], props: [
		{ name: 'VERSION', params: {}, value: '2.0' }, { name: 'PRODID', params: {}, value: '-//Atrium//Calendar//EN' }, { name: 'CALSCALE', params: {}, value: 'GREGORIAN' },
	] }
	ensureTimezone(root)
	await put(cal, null, root, null)
}

/**
 * Save an edited event. scope "all" edits the series (moving it by as much as this
 * occurrence moved), "this" writes an override for one occurrence.
 */
export async function updateEvent(obj: StoredObject, inst: Instance, f: EventForm, scope: 'all' | 'this', target: Cal): Promise<void> {
	const root = obj.root
	const master = masterOf(root)
	const t = formTimes(f)
	if (scope === 'this' && inst.recurrenceId) {
		let ov = overrideOf(root, inst.recurrenceId)
		if (!ov) {
			const src = master ?? root.children.find((c) => c.name === 'VEVENT')!
			ov = { name: 'VEVENT', children: src.children.map((c) => ({ ...c, props: [...c.props] })), props: src.props.filter((p) => !['RRULE', 'RDATE', 'EXDATE'].includes(p.name)) }
			ov.props.push({ name: 'RECURRENCE-ID', params: inst.allDay ? { VALUE: 'DATE' } : {}, value: inst.allDay ? inst.recurrenceId.slice(0, 8) : inst.recurrenceId })
			root.children.push(ov)
		}
		applyForm(ov, f, { ...t, repeat: false })
	} else {
		const ev = master ?? root.children.find((c) => c.name === 'VEVENT')!
		let { start, end } = t
		if (inst.recurrenceId && master) {
			// Shift the series by the change made to this occurrence.
			const ms = parseIcsTime(getProp(master, 'DTSTART'))!
			const delta = t.start.date.getTime() - inst.start.getTime()
			const len = t.end.date.getTime() - t.start.date.getTime()
			const s = f.allDay ? new Date(ms.date.getFullYear(), ms.date.getMonth(), ms.date.getDate() + Math.round(delta / 86400000)) : new Date(ms.date.getTime() + delta)
			start = { date: s, allDay: f.allDay }
			end = { date: f.allDay ? new Date(s.getFullYear(), s.getMonth(), s.getDate() + Math.round(len / 86400000)) : new Date(s.getTime() + len), allDay: f.allDay }
		}
		const before = parseIcsTime(getProp(ev, 'DTSTART'))
		applyForm(ev, f, { start, end, repeat: true })
		if (master && before) shiftExceptions(root, master, before, start)
	}
	ensureTimezone(root)
	if (target.url !== obj.cal.url) {
		await put(target, null, root, null)
		await dav.delete(obj.url, obj.etag)
	} else {
		await put(obj.cal, obj.url, root, obj.etag)
	}
}

/** Delete one occurrence (EXDATE + drop its override) or the whole event. */
export async function deleteEvent(obj: StoredObject, inst: Instance, scope: 'all' | 'this'): Promise<void> {
	const master = masterOf(obj.root)
	if (scope === 'this' && inst.recurrenceId && master) {
		obj.root.children = obj.root.children.filter((c) => !(c.name === 'VEVENT' && sameInstant(getProp(c, 'RECURRENCE-ID'), inst.recurrenceId!)))
		master.props.push(inst.allDay ? { name: 'EXDATE', params: { VALUE: 'DATE' }, value: inst.recurrenceId.slice(0, 8) } : { name: 'EXDATE', params: {}, value: inst.recurrenceId })
		await put(obj.cal, obj.url, obj.root, obj.etag)
	} else {
		await dav.delete(obj.url, obj.etag)
	}
}

// ---- Calendars -------------------------------------------------------------

export async function createCalendar(user: string, name: string, color: string, fixedId?: string): Promise<void> {
	const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'calendar'
	const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
	const body = `<?xml version="1.0"?><d:mkcol xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:x1="http://apple.com/ns/ical/"><d:set><d:prop>`
		+ `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${esc(name)}</d:displayname><x1:calendar-color>${esc(color)}</x1:calendar-color>`
		+ `<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></d:mkcol>`
	await dav.mkcol(`${homeUrl(user)}${fixedId ?? `${slug}-${Date.now().toString(36)}`}/`, body)
}
export const updateCalendar = (c: Cal, name: string, color: string) => dav.proppatch(c.url, { 'd:displayname': name, 'x1:calendar-color': color })
export const deleteCalendar = (c: Cal) => dav.delete(c.url)
export const exportUrl = (c: Cal) => `${c.url}?export`

/**
 * The series start moved: move EXDATEs and the RECURRENCE-IDs of overrides with it,
 * or deleted occurrences come back and edited ones show twice.
 */
function shiftExceptions(root: VComponent, master: VComponent, before: IcsTime, after: IcsTime) {
	const shift = (t: IcsTime): IcsTime => after.allDay
		? { date: new Date(t.date.getFullYear(), t.date.getMonth(), t.date.getDate() + Math.round((startDay(after.date) - startDay(before.date)) / 86400000)), allDay: true }
		: { date: new Date(t.date.getTime() + (after.date.getTime() - before.date.getTime())), allDay: false }
	if (after.date.getTime() === before.date.getTime() && after.allDay === before.allDay) return
	const write = (t: IcsTime): { params: Record<string, string>, value: string } => (t.allDay ? { params: { VALUE: 'DATE' }, value: `${t.date.getFullYear()}${String(t.date.getMonth() + 1).padStart(2, '0')}${String(t.date.getDate()).padStart(2, '0')}` } : { params: {}, value: icsUtc(t.date) })
	master.props = master.props.flatMap((p) => {
		if (p.name !== 'EXDATE') return [p]
		return p.value.split(',').map((v) => parseIcsTime({ ...p, value: v })).filter((t): t is IcsTime => !!t).map((t) => ({ name: 'EXDATE', ...write(shift({ ...t, allDay: after.allDay })) }))
	})
	for (const ov of root.children) {
		const rid = ov.name === 'VEVENT' ? getProp(ov, 'RECURRENCE-ID') : undefined
		const t = parseIcsTime(rid)
		if (!rid || !t) continue
		Object.assign(rid, write(shift({ ...t, allDay: after.allDay })))
	}
}
const startDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

async function listSubscribed(cal: Cal, from: Date, to: Date): Promise<Instance[]> {
	const rs = await request<{ href: string, etag: string, data: string }[]>(`/index.php/apps/calendar/subscription/${encodeURIComponent(cal.id)}/events?from=${Math.floor(from.getTime() / 1000)}&to=${Math.floor(to.getTime() / 1000)}`)
	const out: Instance[] = []
	for (const r of rs) {
		const root = parseComponent(r.data)
		for (const ev of root.children.filter((c) => c.name === 'VEVENT')) {
			const st = parseIcsTime(getProp(ev, 'DTSTART'))
			if (!st) continue
			const en = parseIcsTime(getProp(ev, 'DTEND')) ?? endFromDuration(st, getProp(ev, 'DURATION')?.value)
			const rid = getProp(ev, 'RECURRENCE-ID')?.value ?? null
			out.push({
				key: `${cal.id}/${r.href}#${rid ?? ''}`, cal, url: cal.url + r.href, etag: r.etag || null, uid: getProp(ev, 'UID')?.value ?? r.href,
				title: unescapeText(getProp(ev, 'SUMMARY')?.value ?? '') || 'Untitled event',
				start: st.date, end: en.date, allDay: st.allDay,
				location: unescapeText(getProp(ev, 'LOCATION')?.value ?? ''),
				description: unescapeText(getProp(ev, 'DESCRIPTION')?.value ?? ''),
				recurrenceId: rid, color: cal.color,
			})
		}
	}
	return out
}
