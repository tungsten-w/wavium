// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Note } from './api'

/** First lines after the title, for the list. */
export function excerpt(n: Note): string {
	const lines = (n.content ?? '').split('\n').map((l) => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|>\s*|\d+[.)]\s+)/, '').replace(/[*_`~]/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').trim()).filter(Boolean)
	if (lines[0] && lines[0].toLowerCase() === n.title.toLowerCase()) lines.shift()
	return lines.join(' ').slice(0, 160)
}

/** List section of a note by its modification time. */
export function timeGroup(mod: number): string {
	const d = new Date(mod * 1000)
	const now = new Date()
	const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
	const diff = Math.round((day(now) - day(d)) / 86400000)
	if (diff <= 0) return 'Today'
	if (diff === 1) return 'Yesterday'
	if (diff < 7) return 'This week'
	if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 'This month'
	return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export function shortTime(mod: number): string {
	const d = new Date(mod * 1000)
	const now = new Date()
	if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
	return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
}
