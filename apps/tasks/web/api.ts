// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tasks (VTODO) over CalDAV: task lists are calendars that support VTODO.
import { nextDue, repeatOf, type Repeat } from './recur'
import { DAV_ROOT, dav, escapeText, getProp, icsUtc, parseComponent, parseIcsTime, serializeComponent, timeProp, unescapeText, uuid, localZone, ensureTimezone, type IcsTime, type VComponent, type VProp } from '@atrium/sdk'

export interface TaskList { url: string, id: string, name: string, color: string, readOnly: boolean, shared: boolean, ctag: string }

export interface Task {
	url: string
	etag: string | null
	list: TaskList
	root: VComponent
	uid: string
	title: string
	notes: string
	due: IcsTime | null
	start: IcsTime | null
	done: boolean
	completedAt: Date | null
	/** 0 none, 1-4 high, 5 medium, 6-9 low (RFC 5545). */
	priority: number
	tags: string[]
	parent: string | null
	created: Date | null
	sortOrder: number | null
	/** RRULE as a simple frequency (P4-3), "custom" when it is more. */
	repeat: Repeat
}

const CALDAV = 'urn:ietf:params:xml:ns:caldav'
export const homeUrl = (user: string) => `${DAV_ROOT}/calendars/${encodeURIComponent(user)}/`

export async function listLists(user: string): Promise<TaskList[]> {
	const rs = await dav.propfind(homeUrl(user), ['d:displayname', 'd:resourcetype', 'x1:calendar-color', 'cs:getctag', 'oc:read-only', 'oc:owner-principal', 'cal:supported-calendar-component-set', 'x1:calendar-order'], 1)
	return rs
		.filter((r) => r.elements['d:resourcetype']?.getElementsByTagNameNS(CALDAV, 'calendar').length)
		.filter((r) => {
			const set = r.elements['cal:supported-calendar-component-set']
			return set && Array.from(set.getElementsByTagNameNS(CALDAV, 'comp')).some((c) => c.getAttribute('name') === 'VTODO')
		})
		.map((r) => {
			const id = r.href.replace(/\/$/, '').split('/').pop() ?? ''
			return {
				url: r.href.endsWith('/') ? r.href : r.href + '/', id,
				name: r.props['d:displayname'] || id,
				color: (r.props['x1:calendar-color'] || '#0082c9').slice(0, 7),
				readOnly: r.props['oc:read-only'] === 'true' || r.props['oc:read-only'] === '1',
				shared: !!r.props['oc:owner-principal'] && !r.props['oc:owner-principal'].endsWith(`/${user}`),
				ctag: r.props['cs:getctag'] ?? '',
				order: Number(r.props['x1:calendar-order'] ?? 0),
			}
		})
		.sort((a, b) => Number(a.shared) - Number(b.shared) || a.order - b.order || a.name.localeCompare(b.name))
		.map(({ order: _o, ...l }) => l)
}

const vtodoOf = (root: VComponent) => root.children.find((c) => c.name === 'VTODO' && !getProp(c, 'RECURRENCE-ID')) ?? root.children.find((c) => c.name === 'VTODO')

function splitList(v: string): string[] {
	const out: string[] = []
	let cur = ''
	for (let i = 0; i < v.length; i++) {
		if (v[i] === '\\' && i + 1 < v.length) { cur += v[i] + v[i + 1]; i++; continue }
		if (v[i] === ',') { out.push(unescapeText(cur).trim()); cur = '' } else cur += v[i]
	}
	out.push(unescapeText(cur).trim())
	return out.filter(Boolean)
}

export function toTask(list: TaskList, url: string, etag: string | null, text: string): Task | null {
	try {
		const root = parseComponent(text)
		const t = vtodoOf(root)
		if (!t) return null
		const status = getProp(t, 'STATUS')?.value?.toUpperCase()
		const rel = t.props.find((p) => p.name === 'RELATED-TO' && (!p.params.RELTYPE || p.params.RELTYPE.toUpperCase() === 'PARENT'))
		return {
			url, etag, list, root,
			uid: getProp(t, 'UID')?.value ?? url,
			title: unescapeText(getProp(t, 'SUMMARY')?.value ?? ''),
			notes: unescapeText(getProp(t, 'DESCRIPTION')?.value ?? ''),
			due: parseIcsTime(getProp(t, 'DUE')),
			start: parseIcsTime(getProp(t, 'DTSTART')),
			done: status === 'COMPLETED' || !!getProp(t, 'COMPLETED'),
			completedAt: parseIcsTime(getProp(t, 'COMPLETED'))?.date ?? null,
			priority: Number(getProp(t, 'PRIORITY')?.value ?? 0) || 0,
			tags: t.props.filter((p) => p.name === 'CATEGORIES').flatMap((p) => splitList(p.value)),
			parent: rel?.value ?? null,
			created: parseIcsTime(getProp(t, 'CREATED'))?.date ?? null,
			sortOrder: getProp(t, 'X-APPLE-SORT-ORDER') ? Number(getProp(t, 'X-APPLE-SORT-ORDER')!.value) : null,
			repeat: repeatOf(getProp(t, 'RRULE')?.value),
		}
	} catch {
		return null
	}
}

export async function listTasks(list: TaskList): Promise<Task[]> {
	const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><d:getetag/><c:calendar-data/></d:prop>`
		+ `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>`
	const rs = await dav.report(list.url, body, 1)
	return rs.filter((r) => r.props['cal:calendar-data']).map((r) => toTask(list, r.href, r.props['d:getetag'] ?? null, r.props['cal:calendar-data'])).filter((t): t is Task => !!t)
}

async function write(list: TaskList, url: string | null, root: VComponent, etag: string | null): Promise<Task> {
	const t = vtodoOf(root)
	if (t?.props.some((p) => p.params.TZID)) ensureTimezone(root)
	const text = serializeComponent(root) + '\r\n'
	const target = url ?? `${list.url}${uuid()}.ics`
	const newTag = await dav.put(target, text, 'text/calendar; charset=utf-8', url ? { etag } : { create: true })
	if (newTag) return toTask(list, target, newTag, text)!
	const got = await dav.get(target)
	return toTask(list, target, got.etag, got.text)!
}

const touch = (t: VComponent) => {
	const now = icsUtc(new Date())
	t.props = t.props.filter((p) => p.name !== 'LAST-MODIFIED' && p.name !== 'DTSTAMP')
	t.props.push({ name: 'DTSTAMP', params: {}, value: now }, { name: 'LAST-MODIFIED', params: {}, value: now })
}
function set(t: VComponent, name: string, prop: Omit<VProp, 'name'> | null) {
	t.props = t.props.filter((p) => p.name !== name)
	if (prop) t.props.push({ name, ...prop })
}

export interface Patch {
	title?: string
	notes?: string
	due?: IcsTime | null
	start?: IcsTime | null
	done?: boolean
	priority?: number
	tags?: string[]
	parent?: string | null
	/** Simple repeat (custom RRULEs are kept unless replaced). */
	repeat?: Exclude<Repeat, 'custom'>
	/** Manual order (X-APPLE-SORT-ORDER); null clears it. */
	sortOrder?: number | null
}

/** Apply a patch to a copy of the task's object and save it (If-Match). */
export async function updateTask(task: Task, patch: Patch): Promise<Task> {
	const root: VComponent = structuredClone(task.root)
	const t = vtodoOf(root)!
	const tz = localZone()
	if (patch.title !== undefined) set(t, 'SUMMARY', { params: {}, value: escapeText(patch.title.trim() || 'Untitled task') })
	if (patch.notes !== undefined) set(t, 'DESCRIPTION', patch.notes.trim() ? { params: {}, value: escapeText(patch.notes) } : null)
	if (patch.due !== undefined) set(t, 'DUE', patch.due ? timeProp('DUE', patch.due, tz) : null)
	if (patch.start !== undefined) set(t, 'DTSTART', patch.start ? timeProp('DTSTART', patch.start, tz) : null)
	if (patch.priority !== undefined) set(t, 'PRIORITY', patch.priority ? { params: {}, value: String(patch.priority) } : null)
	if (patch.tags !== undefined) set(t, 'CATEGORIES', patch.tags.length ? { params: {}, value: patch.tags.map(escapeText).join(',') } : null)
	if (patch.parent !== undefined) {
		t.props = t.props.filter((p) => !(p.name === 'RELATED-TO' && (!p.params.RELTYPE || p.params.RELTYPE.toUpperCase() === 'PARENT')))
		if (patch.parent) t.props.push({ name: 'RELATED-TO', params: {}, value: patch.parent })
	}
	if (patch.repeat !== undefined) set(t, 'RRULE', patch.repeat === 'none' ? null : { params: {}, value: `FREQ=${patch.repeat}` })
	if (patch.sortOrder !== undefined) set(t, 'X-APPLE-SORT-ORDER', patch.sortOrder === null ? null : { params: {}, value: String(Math.round(patch.sortOrder)) })
	// Ticking a repeating task with a date moves it to its next occurrence instead of closing it.
	const repeat = repeatOf(getProp(t, 'RRULE')?.value)
	const anchor = parseIcsTime(getProp(t, 'DUE')) ?? parseIcsTime(getProp(t, 'DTSTART'))
	if (patch.done === true && repeat !== 'none' && repeat !== 'custom' && anchor) {
		const next = nextDue(anchor.date, repeat)
		// Whole days (not milliseconds), so a daylight-saving change keeps the time of day.
		const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
		const days = Math.round((day(next) - day(anchor.date)) / 86400000)
		for (const name of ['DUE', 'DTSTART']) {
			const cur = parseIcsTime(getProp(t, name))
			if (!cur) continue
			const d = cur.date
			set(t, name, timeProp(name, { date: new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes(), d.getSeconds()), allDay: cur.allDay }, tz))
		}
		set(t, 'STATUS', { params: {}, value: 'NEEDS-ACTION' })
		set(t, 'COMPLETED', null)
		set(t, 'PERCENT-COMPLETE', null)
	} else if (patch.done !== undefined) {
		set(t, 'STATUS', { params: {}, value: patch.done ? 'COMPLETED' : 'NEEDS-ACTION' })
		set(t, 'COMPLETED', patch.done ? { params: {}, value: icsUtc(new Date()) } : null)
		set(t, 'PERCENT-COMPLETE', patch.done ? { params: {}, value: '100' } : null)
	}
	touch(t)
	return write(task.list, task.url, root, task.etag)
}

export async function createTask(list: TaskList, title: string, extra: Patch = {}): Promise<Task> {
	const now = icsUtc(new Date())
	const t: VComponent = { name: 'VTODO', children: [], props: [
		{ name: 'UID', params: {}, value: uuid() }, { name: 'CREATED', params: {}, value: now },
		{ name: 'SUMMARY', params: {}, value: escapeText(title.trim()) }, { name: 'STATUS', params: {}, value: 'NEEDS-ACTION' },
	] }
	const tz = localZone()
	if (extra.due) t.props.push(timeProp('DUE', extra.due, tz))
	if (extra.priority) t.props.push({ name: 'PRIORITY', params: {}, value: String(extra.priority) })
	if (extra.parent) t.props.push({ name: 'RELATED-TO', params: {}, value: extra.parent })
	touch(t)
	const root: VComponent = { name: 'VCALENDAR', children: [t], props: [{ name: 'VERSION', params: {}, value: '2.0' }, { name: 'PRODID', params: {}, value: '-//Atrium//Tasks//EN' }] }
	return write(list, null, root, null)
}

export const deleteTask = (t: Task) => dav.delete(t.url, t.etag)
/** Re-create a deleted task (undo). */
export const restoreTask = (t: Task) => write(t.list, null, t.root, null)

export async function moveTask(t: Task, to: TaskList): Promise<Task> {
	await dav.move(t.url, to.url + t.url.split('/').pop())
	const got = await dav.get(to.url + t.url.split('/').pop())
	return toTask(to, to.url + t.url.split('/').pop(), got.etag, got.text)!
}

export async function createList(user: string, name: string, color: string, fixedId?: string): Promise<void> {
	const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tasks'
	const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
	const body = `<?xml version="1.0"?><d:mkcol xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:x1="http://apple.com/ns/ical/"><d:set><d:prop>`
		+ `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${esc(name)}</d:displayname><x1:calendar-color>${esc(color)}</x1:calendar-color>`
		+ `<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></d:mkcol>`
	await dav.mkcol(`${homeUrl(user)}${fixedId ?? `${slug}-${Date.now().toString(36)}`}/`, body)
}
export const updateList = (l: TaskList, name: string, color: string) => dav.proppatch(l.url, { 'd:displayname': name, 'x1:calendar-color': color })
export const deleteList = (l: TaskList) => dav.delete(l.url)
