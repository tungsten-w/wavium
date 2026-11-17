// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The daily digest (PLAN P5-1): "what needs a reply or an action today".
// Pure assembly over four sources (mail triage, calendar, tasks, Daily Todo),
// injected so tests need no PHP. A source that fails is left out and named in
// `errors`; the digest is still built from the others.

import { isLayout } from '../todo'

/** Mail as listMessages() returns it (the fields the digest uses). */
export interface MailRow {
	message_key: string
	date: string
	from: { address?: string | null, name?: string | null } | null
	subject: string
	flags: { seen: boolean, answered: boolean }
	classification: { category?: string | null, urgency?: string | null, needs_reply?: number | null, needs_action?: number | null, has_deadline?: number | null, suspicious?: number | null } | null
}
export interface EventRow { event_id: string, title: string, start: string | null, end: string | null, all_day: boolean, location?: string | null, status?: string | null }
export interface TaskRow { task_id: string, title: string, due: string | null, done: boolean }
export interface TodoRow { item_id: number, title: string, kind: string, done: boolean, parent_id: number | null }

export interface TextRow { conversation_id: string, name: string, last_text: string, last_at: number, one_time_code?: boolean }
export interface DigestText { conversation_id: string, name: string, text: string, at: string, link: string }

export interface DigestSources {
	/** Inbox mail since `since` (unix s) that needs a reply or an action, curated (no ads, spam...). */
	mail(uid: string, since: number): Promise<MailRow[]>
	events(uid: string, from: Date, to: Date): Promise<EventRow[]>
	/** Open tasks due before `before`. */
	tasks(uid: string, before: Date): Promise<TaskRow[]>
	/** Today's Daily Todo items. */
	todo(uid: string): Promise<TodoRow[]>
	/** Agent requests waiting for the person's OK (quiet hours hold their pings, V4-11). */
	approvals?(uid: string): Promise<number>
	/** Text conversations (Messages) whose last message waits for an answer. */
	texts?(uid: string): Promise<TextRow[]>
	/** Where the mail opens in Atrium (only for the mail the digest keeps). */
	mailLink?(uid: string, messageKey: string): Promise<string | null>
}

export interface DigestMail { message_key: string, subject: string, from: string, date: string, urgency: string | null, deadline: boolean, reason: 'reply' | 'action', link?: string | null }
export interface DigestEvent { event_id: string, title: string, start: string | null, end: string | null, all_day: boolean, location: string | null }
export interface DigestTask { task_id: string, title: string, due: string | null, overdue: boolean }
export interface DigestTodo { item_id: number, title: string, kind: string }

export interface Digest {
	/** Local day (YYYY-MM-DD) in `timezone`. */
	day: string
	timezone: string
	generated_at: string
	headline: string
	/** One or two sentences from the user's AI, when asked for and available. */
	ai_summary: string | null
	mail: DigestMail[]
	events: DigestEvent[]
	tasks: DigestTask[]
	todo: DigestTodo[]
	/** Texts (SMS/RCS) waiting for an answer (v4 Messages). */
	texts: DigestText[]
	counts: { reply: number, action: number, events: number, tasks: number, overdue: number, todo: number, texts: number, approvals?: number }
	/** Sources that failed, with why. */
	errors: Record<string, string>
}

/** Mail older than this is not "today" any more (it sits in the inbox list). */
export const MAIL_DAYS = 7
export const MAX_MAIL = 15
/** Same line as the "Suspicious" chip in Mail: such mail is never a to-do. */
export const SUSPICIOUS = 0.6
const URGENCY_RANK: Record<string, number> = { now: 4, today: 3, this_week: 2, whenever: 1, never: 0 }

/** Wall-clock parts of `at` in `tz`. */
export function localParts(at: Date, tz: string): { y: number, m: number, d: number, hh: number, mm: number } {
	const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
	const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]))
	return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute }
}

export const localDay = (at: Date, tz: string) => {
	const p = localParts(at, tz)
	return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

/** UTC instant of local midnight starting `day` (YYYY-MM-DD) in `tz` (DST-safe). */
export function localMidnight(day: string, tz: string): Date {
	const [y, m, d] = day.split('-').map(Number)
	let t = Date.UTC(y, m - 1, d)
	// Two passes converge for every real offset (one more covers a DST jump).
	for (let i = 0; i < 3; i++) {
		const p = localParts(new Date(t), tz)
		const seen = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm)
		t += Date.UTC(y, m - 1, d) - seen
	}
	return new Date(t)
}

export function validTimezone(tz: string | null | undefined): string {
	if (tz) {
		try {
			new Intl.DateTimeFormat('en', { timeZone: tz })
			return tz
		} catch { /* fall through */ }
	}
	return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

const who = (f: MailRow['from']) => (f?.name || f?.address || 'unknown sender').trim()

/** Mail worth a line: needs a reply (not answered yet) or an action, not suspicious; most urgent first. */
export function pickMail(rows: MailRow[]): DigestMail[] {
	const seen = new Set<string>()
	const out: Array<DigestMail & { rank: number }> = []
	for (const r of rows) {
		if (seen.has(r.message_key)) continue
		seen.add(r.message_key)
		const c = r.classification ?? {}
		if ((c.suspicious ?? 0) >= SUSPICIOUS) continue
		const reply = (c.needs_reply ?? 0) >= 0.5 && !r.flags.answered
		const action = (c.needs_action ?? 0) >= 0.5
		if (!reply && !action) continue
		const urgency = c.urgency ?? null
		out.push({
			message_key: r.message_key, subject: r.subject || '(no subject)', from: who(r.from), date: r.date,
			urgency, deadline: (c.has_deadline ?? 0) >= 0.5, reason: reply ? 'reply' : 'action',
			rank: (URGENCY_RANK[urgency ?? ''] ?? 0) * 10 + ((c.has_deadline ?? 0) >= 0.5 ? 5 : 0) + (r.flags.seen ? 0 : 1),
		})
	}
	return out.sort((a, b) => b.rank - a.rank || b.date.localeCompare(a.date)).slice(0, MAX_MAIL).map(({ rank: _r, ...m }) => m)
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

function hhmm(iso: string | null, tz: string): string | null {
	if (!iso || !iso.includes('T')) return null
	const p = localParts(new Date(iso), tz)
	return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`
}

/** "2 mails need a reply, 1 an action · 3 events, the first at 09:00 · 2 tasks due (1 overdue)". */
export function headline(d: Pick<Digest, 'counts' | 'events' | 'timezone'>): string {
	const c = d.counts
	const parts: string[] = []
	const need = (n: number) => (n === 1 ? 'needs' : 'need')
	if (c.reply && c.action) parts.push(`${plural(c.reply, 'mail')} ${need(c.reply)} a reply, ${c.action} ${need(c.action)} an action`)
	else if (c.reply) parts.push(`${plural(c.reply, 'mail')} ${need(c.reply)} a reply`)
	else if (c.action) parts.push(`${plural(c.action, 'mail')} ${need(c.action)} an action`)
	if (c.events) {
		const first = d.events.map((e) => hhmm(e.start, d.timezone)).find((t) => t !== null)
		parts.push(`${plural(c.events, 'event')}${first ? `, the first at ${first}` : ''}`)
	}
	if (c.tasks) parts.push(`${plural(c.tasks, 'task')} due${c.overdue ? ` (${c.overdue} overdue)` : ''}`)
	if (c.todo) parts.push(`${plural(c.todo, 'thing')} on today's list`)
	if (c.texts) parts.push(`${plural(c.texts, 'text')} ${need(c.texts)} a reply`)
	if (c.approvals) parts.push(`${plural(c.approvals, 'agent request')} ${c.approvals === 1 ? 'waits' : 'wait'} for your OK`)
	return parts.length ? parts.join(' · ') : 'Nothing needs you today.'
}

async function safe<T>(errors: Record<string, string>, name: string, f: () => Promise<T>, empty: T): Promise<T> {
	try {
		return await f()
	} catch (e) {
		errors[name] = (e as Error).message || String(e)
		return empty
	}
}

export async function buildDigest(src: DigestSources, uid: string, opts: { now: Date, timezone: string }): Promise<Digest> {
	const tz = validTimezone(opts.timezone)
	const day = localDay(opts.now, tz)
	const start = localMidnight(day, tz)
	const next = new Date(start.getTime() + 36 * 3600_000)
	const end = localMidnight(localDay(next, tz), tz)
	const errors: Record<string, string> = {}
	const [mailRows, eventRows, taskRows, todoRows] = await Promise.all([
		safe(errors, 'mail', () => src.mail(uid, Math.floor(opts.now.getTime() / 1000) - MAIL_DAYS * 86400), []),
		safe(errors, 'calendar', () => src.events(uid, start, end), []),
		safe(errors, 'tasks', () => src.tasks(uid, end), []),
		safe(errors, 'todo', () => src.todo(uid), []),
	])
	const textRows = src.texts ? await safe(errors, 'messages', () => src.texts!(uid), []) : []
	const approvals = src.approvals ? await safe(errors, 'agents', () => src.approvals!(uid), 0) : 0
	// Only texts of the last week; codes are not "waiting for a reply".
	const texts = textRows
		.filter((t) => !t.one_time_code && t.last_at > opts.now.getTime() - MAIL_DAYS * 86_400_000)
		.slice(0, 10)
		.map((t) => ({ conversation_id: t.conversation_id, name: t.name, text: t.last_text.slice(0, 140), at: new Date(t.last_at).toISOString(), link: `/apps/messages/${encodeURIComponent(t.conversation_id)}` }))
	const mail = pickMail(mailRows)
	if (src.mailLink) {
		await Promise.all(mail.map(async (m) => { m.link = await src.mailLink!(uid, m.message_key).catch(() => null) }))
	}
	const events = eventRows
		.filter((e) => e.status !== 'cancelled')
		.map((e) => ({ event_id: e.event_id, title: e.title || '(untitled)', start: e.start, end: e.end, all_day: e.all_day, location: e.location ?? null }))
		.sort((a, b) => Number(b.all_day) - Number(a.all_day) || String(a.start).localeCompare(String(b.start)))
	const tasks = taskRows
		.filter((t) => !t.done)
		.map((t) => ({ task_id: t.task_id, title: t.title || '(untitled)', due: t.due, overdue: t.due !== null && dueDay(t.due, tz) < day }))
		.sort((a, b) => String(a.due).localeCompare(String(b.due)))
	// Top-level open items; Daily Todo also lists today's events and tasks, shown above already.
	const todo = todoRows
		.filter((i) => !i.done && i.parent_id === null && (i.kind === 'item' || i.kind === 'routine') && !isLayout(i.title))
		.map((i) => ({ item_id: i.item_id, title: i.title, kind: i.kind }))
	const counts = {
		reply: mail.filter((m) => m.reason === 'reply').length,
		action: mail.filter((m) => m.reason === 'action').length,
		events: events.length,
		tasks: tasks.length,
		overdue: tasks.filter((t) => t.overdue).length,
		todo: todo.length,
		texts: texts.length,
		...(approvals ? { approvals } : {}),
	}
	const d: Digest = { day, timezone: tz, generated_at: opts.now.toISOString(), headline: '', ai_summary: null, mail, events, tasks, todo, texts, counts, errors }
	d.headline = headline(d)
	return d
}

/** Local day of a due value: a date ("2026-11-13") or an instant. */
function dueDay(due: string, tz: string): string {
	return /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : localDay(new Date(due), tz)
}

/** Plain text of a digest, for a notification or for the AI. */
export function digestText(d: Digest, max = 3000): string {
	const lines: string[] = [d.headline]
	if (d.mail.length) {
		lines.push('', 'Mail:')
		for (const m of d.mail) lines.push(`- ${m.reason === 'reply' ? 'Reply to' : 'Act on'} ${m.from}: ${m.subject}${m.urgency === 'now' || m.urgency === 'today' ? ` (${m.urgency})` : ''}${m.deadline ? ' [deadline]' : ''}`)
	}
	if (d.events.length) {
		lines.push('', 'Calendar:')
		for (const e of d.events) lines.push(`- ${e.all_day ? 'all day' : hhmm(e.start, d.timezone) ?? ''} ${e.title}${e.location ? ` (${e.location})` : ''}`)
	}
	if (d.tasks.length) {
		lines.push('', 'Tasks:')
		for (const t of d.tasks) lines.push(`- ${t.title}${t.overdue ? ' (overdue)' : ''}`)
	}
	if (d.texts?.length) {
		lines.push('', 'Texts waiting:')
		for (const t of d.texts) lines.push(`- ${t.name}: ${t.text}`)
	}
	if (d.todo.length) {
		lines.push('', 'Today list:')
		for (const t of d.todo) lines.push(`- ${t.title}`)
	}
	const text = lines.join('\n')
	return text.length > max ? text.slice(0, max - 1) + '…' : text
}
