// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helpers of the Messages UI (tested in util.test.ts).
import qrcode from 'qrcode-generator'
import type { Message } from './api'

/** SVG path of a QR code (1 unit per module, `size` modules wide), drawn in the page. */
export function qrPath(data: string): { size: number, d: string } {
	const qr = qrcode(0, 'L')
	qr.addData(data, 'Byte')
	qr.make()
	const n = qr.getModuleCount()
	let d = ''
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`
	}
	return { size: n, d }
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** "14:05" today, "Yesterday", "Mon", or "12 Nov" (list times). */
export function shortTime(ms: number, now = new Date()): string {
	const d = new Date(ms)
	if (sameDay(d, now)) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	const y = new Date(now); y.setDate(y.getDate() - 1)
	if (sameDay(d, y)) return 'Yesterday'
	if (now.getTime() - ms < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: 'short' })
	return d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}

export function dayLabel(ms: number, now = new Date()): string {
	const d = new Date(ms)
	if (sameDay(d, now)) return 'Today'
	const y = new Date(now); y.setDate(y.getDate() - 1)
	if (sameDay(d, y)) return 'Yesterday'
	return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}

export interface Bubble { m: Message, first: boolean, last: boolean }
export interface DayGroup { day: string, label: string, bubbles: Bubble[] }

/**
 * Messages grouped by day; inside a day, consecutive messages of the same
 * sender within 5 minutes form a run (rounded corners only at its ends).
 */
export function groupMessages(ms: Message[], now = new Date()): DayGroup[] {
	const out: DayGroup[] = []
	for (let i = 0; i < ms.length; i++) {
		const m = ms[i]
		const d = new Date(m.at)
		const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
		if (out.length === 0 || out[out.length - 1].day !== key) out.push({ day: key, label: dayLabel(m.at, now), bubbles: [] })
		const prev = ms[i - 1]
		const next = ms[i + 1]
		const joins = (a?: Message, b?: Message) => !!a && !!b && a.from_me === b.from_me && a.sender_number === b.sender_number && Math.abs(b.at - a.at) < 300_000 && sameDay(new Date(a.at), new Date(b.at))
		out[out.length - 1].bubbles.push({ m, first: !joins(prev, m), last: !joins(m, next) })
	}
	return out
}

/** Text with links made clickable: [{text}|{href}] parts (no HTML). */
export function linkParts(text: string): Array<{ text: string, href?: string }> {
	const parts: Array<{ text: string, href?: string }> = []
	const re = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g
	let at = 0
	for (const m of text.matchAll(re)) {
		if (m.index! > at) parts.push({ text: text.slice(at, m.index) })
		parts.push({ text: m[0], href: m[0] })
		at = m.index! + m[0].length
	}
	if (at < text.length) parts.push({ text: text.slice(at) })
	return parts
}

const STATUS: Record<string, string> = { sending: 'Sending…', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not sent' }
export const statusLabel = (s: string) => STATUS[s] ?? ''

/** SMS segments: 160 GSM characters (153 when split), 70 with emoji/accents outside GSM (67 split). */
export function smsSegments(text: string): { segments: number, left: number } {
	// eslint-disable-next-line no-control-regex
	const gsm = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/.test(text)
	const len = [...text].length
	const single = gsm ? 160 : 70
	const multi = gsm ? 153 : 67
	if (len <= single) return { segments: len === 0 ? 0 : 1, left: single - len }
	const segments = Math.ceil(len / multi)
	return { segments, left: segments * multi - len }
}

/** Avatar colour from a name, stable. */
export function hue(name: string): number {
	let h = 0
	for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
	return h
}
