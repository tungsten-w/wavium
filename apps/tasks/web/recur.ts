// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tasks gaps (P4-3), pure parts: repeating tasks and manual order.
//
// Repeating task = a VTODO with an RRULE. Ticking it does not close it: its
// due (and start) date moves to the next occurrence after today, like phone
// reminder apps do, so the list always shows the next one. Without a date
// there is nothing to move: the task is completed.
//
// Manual order = X-APPLE-SORT-ORDER (what Apple Reminders, Thunderbird and the
// upstream Tasks app use): lower first; tasks without it come after.

export type Repeat = 'none' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY' | 'custom'
export const REPEATS: Array<{ id: Exclude<Repeat, 'custom'>, label: string }> = [
	{ id: 'none', label: 'Does not repeat' }, { id: 'DAILY', label: 'Every day' }, { id: 'WEEKLY', label: 'Every week' },
	{ id: 'MONTHLY', label: 'Every month' }, { id: 'YEARLY', label: 'Every year' },
]

/** The repeat of an RRULE value: a simple frequency, or "custom" for anything else. */
export function repeatOf(rrule: string | undefined): Repeat {
	if (!rrule) return 'none'
	const m = /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;INTERVAL=1)?(;WKST=\w+)?$/.exec(rrule)
	return m ? m[1] as Repeat : 'custom'
}

/**
 * `n` steps of a frequency from `d`; months keep the day when they can
 * (31 Jan → 28/29 Feb → 31 Mar: counted from `d`, not from the last step).
 */
export function step(d: Date, freq: Exclude<Repeat, 'none' | 'custom'>, n = 1): Date {
	const y = d.getFullYear(), m = d.getMonth(), day = d.getDate(), h = d.getHours(), mi = d.getMinutes()
	if (freq === 'DAILY') return new Date(y, m, day + n, h, mi)
	if (freq === 'WEEKLY') return new Date(y, m, day + 7 * n, h, mi)
	const months = (freq === 'MONTHLY' ? 1 : 12) * n
	const last = new Date(y, m + months + 1, 0).getDate()
	return new Date(y, m + months, Math.min(day, last), h, mi)
}

/**
 * The next due date after `now` (at least one step, so ticking today's
 * occurrence moves to tomorrow's). Steps from the stored date to keep the day
 * of month of a monthly task.
 */
export function nextDue(due: Date, freq: Exclude<Repeat, 'none' | 'custom'>, now = new Date()): Date {
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
	let n = 1
	let d = step(due, freq, n)
	while (n < 50_000 && new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() <= today) d = step(due, freq, ++n)
	return d
}

/** Sort key of a task for manual order (no value = after the others). */
export const sortKey = (n: number | null) => (n === null || Number.isNaN(n) ? Number.POSITIVE_INFINITY : n)

/**
 * Move `moved` just before `before` (null = to the end) among `siblings`
 * (already in display order). Returns the sort orders to write, only for the
 * tasks whose value changes.
 */
export function reorder<T extends { url: string, sortOrder: number | null }>(siblings: T[], moved: T, before: T | null): Array<{ task: T, sortOrder: number }> {
	const rest = siblings.filter((t) => t.url !== moved.url)
	const at = before ? rest.findIndex((t) => t.url === before.url) : -1
	const next = at < 0 ? [...rest, moved] : [...rest.slice(0, at), moved, ...rest.slice(at)]
	return next.map((task, i) => ({ task, sortOrder: (i + 1) * 10 })).filter(({ task, sortOrder }) => task.sortOrder !== sortOrder)
}
