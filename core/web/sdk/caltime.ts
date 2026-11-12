// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// iCalendar date-times <-> JS Dates, time zones through Intl (no tz database shipped).
import type { VComponent, VProp } from './ical'

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const pad = (n: number, w = 2) => String(n).padStart(w, '0')

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function parts(ts: number, tz: string) {
	let f = fmtCache.get(tz)
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
		fmtCache.set(tz, f)
	}
	const o: Record<string, number> = {}
	for (const p of f.formatToParts(new Date(ts))) if (p.type !== 'literal') o[p.type] = Number(p.value)
	return { y: o.year, m: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second }
}
/** Offset of tz from UTC at ts, in ms (Paris in winter: +3600000). */
export function tzOffset(ts: number, tz: string): number {
	try {
		const p = parts(ts, tz)
		return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000
	} catch {
		return 0
	}
}
/** A wall-clock time in tz -> the instant. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, s: number, tz: string): Date {
	const guess = Date.UTC(y, m - 1, d, h, mi, s)
	let t = guess - tzOffset(guess, tz)
	const o2 = tzOffset(t, tz)
	if (guess - o2 !== t) t = guess - o2
	return new Date(t)
}

export interface IcsTime { date: Date, allDay: boolean }

export function parseIcsTime(p: VProp | undefined): IcsTime | null {
	if (!p) return null
	const v = p.value.trim()
	const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v)
	if (!m) return null
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
	if (!m[4] || p.params.VALUE === 'DATE') return { date: new Date(y, mo - 1, d), allDay: true }
	const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6])]
	if (m[7]) return { date: new Date(Date.UTC(y, mo - 1, d, h, mi, s)), allDay: false }
	if (p.params.TZID) return { date: zonedToUtc(y, mo, d, h, mi, s, normaliseTzid(p.params.TZID)), allDay: false }
	return { date: new Date(y, mo - 1, d, h, mi, s), allDay: false } // floating
}

/** Outlook-style TZIDs ("/freeassociation.sourceforge.net/Europe/Paris", "W. Europe Standard Time") -> IANA where we can. */
function normaliseTzid(id: string): string {
	const iana = id.replace(/^\/[^/]+\/(Tzfile\/)?/, '')
	try { new Intl.DateTimeFormat('en', { timeZone: iana }); return iana } catch { return localZone() }
}

export const icsUtc = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
export const icsDate = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
export function icsLocal(d: Date, tz: string): string {
	const p = parts(d.getTime(), tz)
	return `${p.y}${pad(p.m)}${pad(p.d)}T${pad(p.h)}${pad(p.mi)}${pad(p.s)}`
}

/** DTSTART/DTEND style prop for a time: all-day -> DATE, else wall time in tz. */
export function timeProp(name: string, t: IcsTime, tz: string): VProp {
	if (t.allDay) return { name, params: { VALUE: 'DATE' }, value: icsDate(t.date) }
	if (tz === 'UTC') return { name, params: {}, value: icsUtc(t.date) }
	return { name, params: { TZID: tz }, value: icsLocal(t.date, tz) }
}

const fmtOffset = (ms: number) => {
	const m = Math.round(ms / 60000)
	return `${m < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(m) / 60))}${pad(Math.abs(m) % 60)}`
}

/**
 * A VTIMEZONE for tz, derived from Intl: the DST transitions of the current year
 * become yearly rules ("last Sunday of March"), which is how every common zone works.
 */
export function vtimezone(tz: string): VComponent {
	const year = new Date().getFullYear()
	const transitions: { at: number, from: number, to: number }[] = []
	let prev = tzOffset(Date.UTC(year, 0, 1), tz)
	for (let day = 1; day <= 366; day++) {
		const t = Date.UTC(year, 0, day, 12)
		const off = tzOffset(t, tz)
		if (off !== prev) {
			let lo = t - 86400000
			let hi = t
			while (hi - lo > 60000) {
				const mid = Math.floor((lo + hi) / 2)
				if (tzOffset(mid, tz) === prev) lo = mid; else hi = mid
			}
			transitions.push({ at: hi, from: prev, to: off })
			prev = off
		}
	}
	const comp: VComponent = { name: 'VTIMEZONE', props: [{ name: 'TZID', params: {}, value: tz }], children: [] }
	if (transitions.length === 0) {
		comp.children.push({ name: 'STANDARD', children: [], props: [
			{ name: 'DTSTART', params: {}, value: '19700101T000000' },
			{ name: 'TZOFFSETFROM', params: {}, value: fmtOffset(prev) },
			{ name: 'TZOFFSETTO', params: {}, value: fmtOffset(prev) },
		] })
		return comp
	}
	const minOff = Math.min(...transitions.map((t) => t.to))
	for (const tr of transitions) {
		// Wall time of the transition in the old offset, as rules count it.
		const wall = new Date(tr.at + tr.from)
		const month = wall.getUTCMonth() + 1
		const dow = wall.getUTCDay()
		const dom = wall.getUTCDate()
		const daysInMonth = new Date(Date.UTC(wall.getUTCFullYear(), month, 0)).getUTCDate()
		const nth = dom + 7 > daysInMonth ? -1 : Math.ceil(dom / 7)
		const byday = `${nth}${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][dow]}`
		const start1970 = nthWeekday(1970, month, dow, nth)
		comp.children.push({ name: tr.to === minOff ? 'STANDARD' : 'DAYLIGHT', children: [], props: [
			{ name: 'TZOFFSETFROM', params: {}, value: fmtOffset(tr.from) },
			{ name: 'TZOFFSETTO', params: {}, value: fmtOffset(tr.to) },
			{ name: 'DTSTART', params: {}, value: `1970${pad(month)}${pad(start1970)}T${pad(wall.getUTCHours())}${pad(wall.getUTCMinutes())}00` },
			{ name: 'RRULE', params: {}, value: `FREQ=YEARLY;BYMONTH=${month};BYDAY=${byday}` },
		] })
	}
	return comp
}

function nthWeekday(year: number, month: number, dow: number, nth: number): number {
	if (nth > 0) {
		const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
		return 1 + ((dow - first + 7) % 7) + (nth - 1) * 7
	}
	const last = new Date(Date.UTC(year, month, 0))
	return last.getUTCDate() - ((last.getUTCDay() - dow + 7) % 7)
}

// Calendar arithmetic on local dates.
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes())
export const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), 28))
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
/** Monday-first week start (ISO), the European default; Intl weekInfo where the browser has it. */
export function firstDayOfWeek(): number {
	try {
		const loc = new Intl.Locale(navigator.language) as Intl.Locale & { weekInfo?: { firstDay: number }, getWeekInfo?: () => { firstDay: number } }
		const fd = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay
		if (fd) return fd % 7
	} catch { /* older browsers */ }
	return 1
}
export const startOfWeek = (d: Date) => {
	const fd = firstDayOfWeek()
	return addDays(startOfDay(d), -((d.getDay() - fd + 7) % 7))
}
export const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export function parseKey(k: string): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k)
	return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}
/** "HH:MM" for <input type=time>. */
export const timeOfDay = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
export const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/** Add the VTIMEZONE for the local zone if a TZID property needs it (RFC 5545 3.6.5). */
export function ensureTimezone(root: VComponent, tz = localZone()): void {
	if (tz === 'UTC') return
	if (!root.children.some((c) => c.name === 'VTIMEZONE' && c.props.some((p) => p.name === 'TZID' && p.value === tz))) root.children.unshift(vtimezone(tz))
}
