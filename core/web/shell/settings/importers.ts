// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Move from Google" (v2.1): bring the files Google exports into Wavium over
// CalDAV / CardDAV, the same way phones and Thunderbird write, so nothing
// needs a Google API key.
//   .ics (Google Calendar > Settings > Import & export > Export) -> a calendar
//   .vcf (contacts.google.com > Export > vCard) -> an address book
//   secret iCal address -> a subscription that keeps itself up to date
import { dav, DAV_ROOT, parseComponent, serializeComponent, type VComponent } from '@atrium/sdk'

const CALDAV = 'urn:ietf:params:xml:ns:caldav'
const CARDDAV = 'urn:ietf:params:xml:ns:carddav'
const CS = 'http://calendarserver.org/ns/'

export interface Target { url: string, name: string }

/** One object per UID: its events/todos with the time zones they use, ready to PUT. */
export function splitIcs(text: string): Array<{ uid: string, ics: string }> {
	let cal: VComponent
	try { cal = parseComponent(text) } catch { return [] }
	if (cal.name !== 'VCALENDAR') return []
	const zones = cal.children.filter((c) => c.name === 'VTIMEZONE')
	const groups = new Map<string, VComponent[]>()
	for (const c of cal.children) {
		if (c.name !== 'VEVENT' && c.name !== 'VTODO') continue
		const uid = c.props.find((p) => p.name === 'UID')?.value || `wavium-import-${groups.size + 1}-${Date.now().toString(36)}`
		if (!c.props.some((p) => p.name === 'UID')) c.props.push({ name: 'UID', params: {}, value: uid })
		groups.set(uid, [...(groups.get(uid) ?? []), c])
	}
	const out: Array<{ uid: string, ics: string }> = []
	for (const [uid, comps] of groups) {
		const body = comps.map(serializeComponent).join('\r\n')
		const used = zones.filter((z) => body.includes(`TZID=${z.props.find((p) => p.name === 'TZID')?.value}`))
		const vcal: VComponent = {
			name: 'VCALENDAR',
			props: [{ name: 'VERSION', params: {}, value: '2.0' }, { name: 'PRODID', params: {}, value: '-//Wavium//Import//EN' }],
			children: [...used, ...comps],
		}
		out.push({ uid, ics: serializeComponent(vcal) })
	}
	return out
}

/** Each BEGIN:VCARD ... END:VCARD, with a UID added when the export has none. */
export function splitVcf(text: string): Array<{ uid: string, vcf: string }> {
	const cards = text.replace(/\r\n/g, '\n').match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi) ?? []
	return cards.map((c, i) => {
		const m = /^UID[;:](?:.*:)?(.+)$/im.exec(c)
		const uid = m?.[1].trim() || `wavium-import-${i + 1}-${Date.now().toString(36)}`
		const vcf = m ? c : c.replace(/END:VCARD$/i, `UID:${uid}\nEND:VCARD`)
		return { uid, vcf: vcf.replace(/\n/g, '\r\n') }
	})
}

/** A file name a DAV server accepts for a UID (Google's are long, with @ and dots). */
export const safeName = (uid: string) => uid.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180)

export const calendarHome = (user: string) => `${DAV_ROOT}/calendars/${encodeURIComponent(user)}/`
export const bookHome = (user: string) => `${DAV_ROOT}/addressbooks/users/${encodeURIComponent(user)}/`

/** The user's own calendars that take events (not subscriptions, not birthdays). */
export async function writableCalendars(user: string): Promise<Target[]> {
	const rs = await dav.propfind(calendarHome(user), ['d:displayname', 'd:resourcetype', 'oc:owner-principal', 'cal:supported-calendar-component-set'], 1)
	return rs.filter((r) => r.elements['d:resourcetype']?.getElementsByTagNameNS(CALDAV, 'calendar').length
		&& !r.elements['d:resourcetype']?.getElementsByTagNameNS(CS, 'subscribed').length
		&& !r.href.replace(/\/$/, '').endsWith('/contact_birthdays')
		&& (!r.props['oc:owner-principal'] || r.props['oc:owner-principal'].endsWith(`/${user}`))
		&& (() => { const set = r.elements['cal:supported-calendar-component-set']; return !set || Array.from(set.getElementsByTagNameNS(CALDAV, 'comp')).some((c) => c.getAttribute('name') === 'VEVENT') })())
		.map((r) => ({ url: r.href.endsWith('/') ? r.href : `${r.href}/`, name: r.props['d:displayname'] || r.href.replace(/\/$/, '').split('/').pop() || '' }))
}

export async function writableBooks(user: string): Promise<Target[]> {
	const rs = await dav.propfind(bookHome(user), ['d:displayname', 'd:resourcetype'], 1)
	return rs.filter((r) => r.elements['d:resourcetype']?.getElementsByTagNameNS(CARDDAV, 'addressbook').length && !r.href.includes('/z-'))
		.map((r) => ({ url: r.href.endsWith('/') ? r.href : `${r.href}/`, name: r.props['d:displayname'] || r.href.replace(/\/$/, '').split('/').pop() || '' }))
}

export interface ImportResult { added: number, skipped: number, failed: number }

/** PUTs each item once: an item already there (same UID) is skipped, never overwritten. */
export async function putAll(target: string, items: Array<{ name: string, body: string }>, type: string, onProgress?: (done: number) => void): Promise<ImportResult> {
	const r: ImportResult = { added: 0, skipped: 0, failed: 0 }
	let i = 0
	for (const it of items) {
		try {
			await dav.put(`${target}${it.name}`, it.body, type, { create: true })
			r.added++
		} catch (e) {
			if ((e as { status?: number }).status === 412) r.skipped++
			else r.failed++
		}
		onProgress?.(++i)
	}
	return r
}

export const importIcs = (target: string, text: string, onProgress?: (n: number) => void) =>
	putAll(target, splitIcs(text).map((o) => ({ name: `${safeName(o.uid)}.ics`, body: o.ics })), 'text/calendar; charset=utf-8', onProgress)

export const importVcf = (target: string, text: string, onProgress?: (n: number) => void) =>
	putAll(target, splitVcf(text).map((c) => ({ name: `${safeName(c.uid)}.vcf`, body: c.vcf })), 'text/vcard; charset=utf-8', onProgress)

/** A read-only calendar that follows a secret iCal address (Google keeps it current). */
export async function subscribe(user: string, source: string, name: string): Promise<void> {
	const url = source.trim().replace(/^webcal:\/\//i, 'https://')
	if (!/^https:\/\//i.test(url)) throw new Error('The address must start with https:// or webcal://')
	const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
	const body = `<?xml version="1.0"?><d:mkcol xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:x1="http://apple.com/ns/ical/"><d:set><d:prop>`
		+ `<d:resourcetype><d:collection/><cs:subscribed/></d:resourcetype><d:displayname>${esc(name)}</d:displayname>`
		+ `<x1:calendar-color>#0b6aa8</x1:calendar-color><cs:source><d:href>${esc(url)}</d:href></cs:source></d:prop></d:set></d:mkcol>`
	await dav.mkcol(`${calendarHome(user)}sub-${Date.now().toString(36)}/`, body)
}
