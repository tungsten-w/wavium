// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Calendar gaps (P4-2), kept apart from the CalDAV basics in api.ts:
// - classic event URLs (/apps/calendar/edit/<base64 DAV path>[/<recurrence>],
//   and the /<view>/<date>/edit/<mode>/<base64>/<recurrence> form) still open
//   the event: global search results and old bookmarks land on it;
// - attendees (ATTENDEE / ORGANIZER): Nextcloud's CalDAV scheduling sends the
//   invitations and updates by mail when the organizer saves;
// - your answer to an invitation (PARTSTAT on your own ATTENDEE);
// - subscriptions to an iCal URL (a cs:subscribed collection, refreshed by
//   Nextcloud's webcal job);
// - appointment pages (booking): the Calendar app's appointment_configs API;
//   the public booking page itself stays the Calendar app's page.
import { dav, getProp, parseComponent, parseIcsTime, request, serializeComponent, unescapeText, type VComponent, type VProp } from '@atrium/sdk'
import { homeUrl, masterOf, type Cal, type Instance, type StoredObject } from './api'

// ---- Classic event URLs ----------------------------------------------------

export interface EditLink { url: string, recurrence: string | null }

/** Path segments after /apps/calendar → the DAV object to open, or null. */
export function parseEditPath(seg: string[]): EditLink | null {
	let b64: string | undefined
	let rid: string | undefined
	if (seg[0] === 'edit') { b64 = seg[1]; rid = seg[2] }
	else if (seg[2] === 'edit') { b64 = seg[4]; rid = seg[5] }
	if (!b64) return null
	let url: string
	try { url = atob(decodeURIComponent(b64).replace(/-/g, '+').replace(/_/g, '/')) } catch { return null }
	if (!/^\/remote\.php\/dav\/calendars\/[^/]+\/[^/]+\/[^/]+\.ics$/.test(url) || url.includes('..')) return null
	return { url, recurrence: rid && rid !== 'next' ? rid : null }
}

/** Opens a stored event as an Instance: the series (or a single event), or one occurrence (Unix seconds). */
export async function instanceAt(link: EditLink, cals: Cal[]): Promise<Instance | null> {
	const cal = cals.find((c) => link.url.startsWith(new URL(c.url, location.origin).pathname))
	if (!cal) return null
	const { text, etag } = await dav.get(link.url)
	const root = parseComponent(text)
	const ev = masterOf(root) ?? root.children.find((c) => c.name === 'VEVENT')
	if (!ev) return null
	const st = parseIcsTime(getProp(ev, 'DTSTART'))
	if (!st) return null
	const en = parseIcsTime(getProp(ev, 'DTEND'))
	const length = en ? en.date.getTime() - st.date.getTime() : st.allDay ? 86400000 : 3600000
	const repeats = !!getProp(ev, 'RRULE')
	const at = link.recurrence && /^\d+$/.test(link.recurrence) && repeats ? new Date(Number(link.recurrence) * 1000) : null
	const start = at ?? st.date
	return {
		key: `${link.url}#${at ? icsUtcSec(at) : ''}`, cal, url: link.url, etag: etag ?? null, uid: getProp(ev, 'UID')?.value ?? link.url,
		title: unescapeText(getProp(ev, 'SUMMARY')?.value ?? '') || 'Untitled event',
		start, end: new Date(start.getTime() + length), allDay: st.allDay,
		location: unescapeText(getProp(ev, 'LOCATION')?.value ?? ''), description: unescapeText(getProp(ev, 'DESCRIPTION')?.value ?? ''),
		recurrenceId: at ? icsUtcSec(at) : null, color: cal.color,
	}
}
const icsUtcSec = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

// ---- Attendees -------------------------------------------------------------

export type PartStat = 'NEEDS-ACTION' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' | 'DELEGATED'
export interface Attendee { email: string, name: string, partstat: PartStat, role: 'REQ-PARTICIPANT' | 'OPT-PARTICIPANT' | 'CHAIR' | 'NON-PARTICIPANT' }
export interface People { organizer: { email: string, name: string } | null, attendees: Attendee[] }

export const PARTSTAT_LABEL: Record<PartStat, string> = { 'NEEDS-ACTION': 'No answer yet', ACCEPTED: 'Accepted', DECLINED: 'Declined', TENTATIVE: 'Maybe', DELEGATED: 'Delegated' }
const mailOf = (v: string) => v.replace(/^mailto:/i, '').trim()
export const validEmail = (s: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s.trim())

export function peopleOf(ev: VComponent | undefined): People {
	if (!ev) return { organizer: null, attendees: [] }
	const org = getProp(ev, 'ORGANIZER')
	return {
		organizer: org ? { email: mailOf(org.value), name: org.params.CN ?? '' } : null,
		attendees: ev.props.filter((p) => p.name === 'ATTENDEE').map((p) => ({
			email: mailOf(p.value), name: p.params.CN ?? '',
			partstat: (p.params.PARTSTAT ?? 'NEEDS-ACTION').toUpperCase() as PartStat,
			role: (p.params.ROLE ?? 'REQ-PARTICIPANT').toUpperCase() as Attendee['role'],
		})),
	}
}

/**
 * Write the guest list. With guests and no organizer, the user becomes the
 * organizer (the server then sends the invitations). Without guests, both go.
 */
export function applyPeople(ev: VComponent, people: People, me: { email: string | null, name: string }): void {
	ev.props = ev.props.filter((p) => p.name !== 'ATTENDEE' && p.name !== 'ORGANIZER')
	if (people.attendees.length === 0) return
	const organizer = people.organizer ?? (me.email ? { email: me.email, name: me.name } : null)
	if (organizer) ev.props.push({ name: 'ORGANIZER', params: organizer.name ? { CN: organizer.name } : {}, value: `mailto:${organizer.email}` })
	for (const a of people.attendees) {
		const params: Record<string, string> = { CUTYPE: 'INDIVIDUAL', ROLE: a.role, PARTSTAT: a.partstat }
		if (a.name) params.CN = a.name
		// Ask the server to mail the guest (iTIP) unless it is the organizer.
		if (!organizer || a.email.toLowerCase() !== organizer.email.toLowerCase()) params.RSVP = 'TRUE'
		ev.props.push({ name: 'ATTENDEE', params, value: `mailto:${a.email}` })
	}
}

export const isOrganizer = (p: People, myEmail: string | null) => !p.organizer || (!!myEmail && p.organizer.email.toLowerCase() === myEmail.toLowerCase())
export const myAttendance = (p: People, myEmail: string | null) => (myEmail ? p.attendees.find((a) => a.email.toLowerCase() === myEmail.toLowerCase()) ?? null : null)

/** My answer to an invitation: only my own ATTENDEE changes (the server sends the reply). */
export function setMyAnswer(ev: VComponent, myEmail: string, answer: PartStat): boolean {
	const mine = ev.props.find((p): p is VProp => p.name === 'ATTENDEE' && mailOf(p.value).toLowerCase() === myEmail.toLowerCase())
	if (!mine) return false
	mine.params = { ...mine.params, PARTSTAT: answer }
	delete mine.params.RSVP
	return true
}

/** Save my answer on every copy of the event (series and changed occurrences). */
export async function answerInvite(obj: StoredObject, myEmail: string, answer: PartStat): Promise<void> {
	let changed = false
	for (const ev of obj.root.children.filter((c) => c.name === 'VEVENT')) changed = setMyAnswer(ev, myEmail, answer) || changed
	if (!changed) throw new Error('You are not on the guest list of this event')
	await dav.put(obj.url, serializeComponent(obj.root) + '\r\n', 'text/calendar; charset=utf-8', { etag: obj.etag })
}

// ---- Subscriptions ---------------------------------------------------------

/** webcal:// is https://; only http(s) feeds. */
export function feedUrl(input: string): string | null {
	const s = input.trim().replace(/^webcals?:\/\//i, 'https://')
	try {
		const u = new URL(s)
		return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
	} catch { return null }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function subscriptionBody(source: string, name: string, color: string): string {
	return `<?xml version="1.0"?><d:mkcol xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:x1="http://apple.com/ns/ical/"><d:set><d:prop>`
		+ `<d:resourcetype><d:collection/><cs:subscribed/></d:resourcetype><d:displayname>${esc(name)}</d:displayname>`
		+ `<x1:calendar-color>${esc(color)}</x1:calendar-color><cs:source><d:href>${esc(source)}</d:href></cs:source></d:prop></d:set></d:mkcol>`
}

export async function subscribe(user: string, source: string, name: string, color: string): Promise<void> {
	await dav.mkcol(`${homeUrl(user)}sub-${Date.now().toString(36)}/`, subscriptionBody(source, name, color))
}

// ---- Appointments ----------------------------------------------------------

export interface AppointmentConfig {
	id: number, token: string, name: string, description: string, location: string | null, visibility: 'PUBLIC' | 'PRIVATE',
	targetCalendarUri: string, length: number, increment: number, availability: Availability | null,
}
export type Day = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'
export const DAYS: Day[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
export interface Availability { timezoneId: string, slots: Record<Day, Array<{ start: number, end: number }>> }

export interface AppointmentForm {
	name: string, description: string, location: string, visibility: 'PUBLIC' | 'PRIVATE', calendar: string,
	/** Minutes. */
	length: number
	days: Day[]
	/** "HH:MM" */
	from: string
	to: string
}

/**
 * Weekly hours as the Calendar app stores them: per day a list of Unix
 * timestamps whose local time of day (in timezoneId) is the start and end.
 */
export function availabilityOf(f: Pick<AppointmentForm, 'days' | 'from' | 'to'>, tz: string, ref = new Date(2026, 0, 5)): Availability {
	const at = (hm: string) => { const [h, m] = hm.split(':').map(Number); return Math.floor(new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h || 0, m || 0).getTime() / 1000) }
	const slots = Object.fromEntries(DAYS.map((d) => [d, f.days.includes(d) ? [{ start: at(f.from), end: at(f.to) }] : []])) as Availability['slots']
	return { timezoneId: tz, slots }
}

export function appointmentPayload(f: AppointmentForm, tz: string) {
	return {
		name: f.name.trim(), description: f.description.trim(), location: f.location.trim() || null, visibility: f.visibility,
		targetCalendarUri: f.calendar, availability: availabilityOf(f, tz), length: f.length * 60, increment: f.length * 60,
		preparationDuration: 0, followupDuration: 0, timeBeforeNextSlot: 0, dailyMax: null, calendarFreeBusyUris: [f.calendar], futureLimit: 60 * 86400,
	}
}

const API = '/index.php/apps/calendar/v1/appointment_configs'
type Wrapped<T> = { status: string, data: T }

export const listAppointments = async () => (await request<Wrapped<AppointmentConfig[]>>(API)).data ?? []
export const createAppointment = async (f: AppointmentForm, tz: string) => (await request<Wrapped<AppointmentConfig>>(API, { method: 'POST', body: appointmentPayload(f, tz) })).data
export const deleteAppointment = (id: number) => request(`${API}/${id}`, { method: 'DELETE' })
export const bookingUrl = (c: AppointmentConfig) => `${location.origin}/index.php/apps/calendar/appointment/${c.token}`
