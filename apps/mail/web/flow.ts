// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mail flow (v4): where the mail of one address goes, as a three-column
// flow chart: the address, then four groups (important, everyday, hidden by
// Curated, spam) plus "not sorted yet", then the categories inside each group.
// Pure model here (counts and geometry), drawn by MailFlow.tsx.
import { categoryLabels } from './api'

export interface FlowRow { accountId: number, category: string, important: boolean, count: number }

export type GroupId = 'important' | 'everyday' | 'hidden' | 'spam' | 'pending'

export const GROUPS: Array<{ id: GroupId, label: string, hint: string }> = [
	{ id: 'important', label: 'Important', hint: 'needs a reply or an action, or is due today' },
	{ id: 'everyday', label: 'Everyday', hint: 'shown in Curated, nothing to do' },
	{ id: 'hidden', label: 'Hidden by Curated', hint: 'newsletters, ads, social: kept, out of the way' },
	{ id: 'spam', label: 'Spam', hint: 'spam, whatever it asks' },
	{ id: 'pending', label: 'Not sorted yet', hint: 'waiting for the classifier' },
]

export interface FlowNode { id: string, label: string, count: number, group: GroupId | 'source', column: 0 | 1 | 2, y: number, h: number, category?: string }
export interface FlowLink { id: string, from: FlowNode, to: FlowNode, count: number, y0: number, y1: number, h: number }
export interface FlowModel { total: number, nodes: FlowNode[], links: FlowLink[], height: number }

/** Which group a classified mail falls in. Spam wins over important (a scam often "needs an action"). */
export function groupOf(row: Pick<FlowRow, 'category' | 'important'>, hides: string[]): GroupId {
	if (row.category === 'spam') return 'spam'
	if (row.important) return 'important'
	return hides.includes(row.category) ? 'hidden' : 'everyday'
}

/** At most `max` categories per group; the rest fold into "Other". */
const MAX_PER_GROUP = 4

/**
 * Counts and layout. `accountId` null = every address. `pending` = mails not
 * classified yet. Heights are proportional to counts inside `height` pixels,
 * with a minimum so a 1-mail branch stays visible.
 */
export function buildFlow(rows: FlowRow[], opts: { accountId: number | null, pending: number, hides: string[], source: string, height?: number, gap?: number, minH?: number }): FlowModel {
	const height = opts.height ?? 320
	const gap = opts.gap ?? 10
	const minH = opts.minH ?? 4
	const mine = rows.filter((r) => opts.accountId === null || r.accountId === opts.accountId)

	// group -> category -> count
	const tree = new Map<GroupId, Map<string, number>>()
	for (const r of mine) {
		if (r.count <= 0) continue
		const g = groupOf(r, opts.hides)
		const cats = tree.get(g) ?? new Map<string, number>()
		cats.set(r.category, (cats.get(r.category) ?? 0) + r.count)
		tree.set(g, cats)
	}
	if (opts.pending > 0) tree.set('pending', new Map())

	const groupCount = (g: GroupId) => g === 'pending' ? opts.pending : [...(tree.get(g)?.values() ?? [])].reduce((a, b) => a + b, 0)
	const groups = GROUPS.filter((g) => tree.has(g.id) && groupCount(g.id) > 0)
	const total = groups.reduce((n, g) => n + groupCount(g.id), 0)
	if (total === 0) return { total: 0, nodes: [], links: [], height }

	// Pixels per mail for a column with `n` nodes, so the column fits with its gaps.
	const scale = (n: number) => Math.max(0, (height - gap * Math.max(0, n - 1))) / total
	const hOf = (count: number, k: number) => Math.max(minH, count * k)

	const leaves: Array<{ group: GroupId, category: string, count: number }> = []
	for (const g of groups) {
		if (g.id === 'pending') continue
		const cats = [...tree.get(g.id)!.entries()].sort((a, b) => b[1] - a[1])
		const kept = cats.slice(0, MAX_PER_GROUP)
		const rest = cats.slice(MAX_PER_GROUP).reduce((n, [, c]) => n + c, 0)
		for (const [category, count] of kept) leaves.push({ group: g.id, category, count })
		if (rest > 0) leaves.push({ group: g.id, category: '__other', count: rest })
	}

	// One scale for both columns, set by the busier one.
	const k = Math.min(scale(groups.length), scale(leaves.length))

	const source: FlowNode = { id: 'source', label: opts.source, count: total, group: 'source', column: 0, y: 0, h: 0 }
	const nodes: FlowNode[] = [source]
	const links: FlowLink[] = []

	// Middle column, centred vertically.
	const midH = groups.reduce((n, g) => n + hOf(groupCount(g.id), k), 0) + gap * (groups.length - 1)
	const rightH = leaves.reduce((n, l) => n + hOf(l.count, k), 0) + gap * Math.max(0, leaves.length - 1)
	const colH = Math.max(midH, rightH)
	source.h = groups.reduce((n, g) => n + hOf(groupCount(g.id), k), 0)
	source.y = (colH - source.h) / 2
	let y = (colH - midH) / 2
	let sy = source.y
	const mid = new Map<GroupId, FlowNode>()
	for (const g of groups) {
		const c = groupCount(g.id)
		const node: FlowNode = { id: `g:${g.id}`, label: g.label, count: c, group: g.id, column: 1, y, h: hOf(c, k) }
		nodes.push(node)
		mid.set(g.id, node)
		links.push({ id: `source>${g.id}`, from: source, to: node, count: c, y0: sy, y1: y, h: node.h })
		sy += node.h
		y += node.h + gap
	}

	// Right column: categories, in group order.
	y = (colH - rightH) / 2
	const used = new Map<GroupId, number>()
	for (const l of leaves) {
		const parent = mid.get(l.group)!
		const h = hOf(l.count, k)
		const label = l.category === '__other' ? 'Other' : categoryLabels[l.category] ?? l.category
		const node: FlowNode = { id: `c:${l.group}:${l.category}`, label, count: l.count, group: l.group, column: 2, y, h, category: l.category === '__other' ? undefined : l.category }
		nodes.push(node)
		// Links leave the parent stacked, so a group's branches together are as thick as the group.
		const off = used.get(l.group) ?? 0
		const share = parent.h * (l.count / parent.count)
		links.push({ id: `${l.group}>${l.category}`, from: parent, to: node, count: l.count, y0: parent.y + off, y1: y, h: Math.min(share, h) })
		used.set(l.group, off + share)
		y += h + gap
	}

	return { total, nodes, links, height: colH }
}

/** A filled band from (x0, y0) to (x1, y1), `h` thick, with soft S curves. */
export function bandPath(x0: number, y0: number, x1: number, y1: number, h: number): string {
	const mx = (x0 + x1) / 2
	return `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1} L${x1},${y1 + h} C${mx},${y1 + h} ${mx},${y0 + h} ${x0},${y0 + h} Z`
}

/** The centre line of the same band, for the moving "threads". */
export function centrePath(x0: number, y0: number, x1: number, y1: number, h: number): string {
	const mx = (x0 + x1) / 2
	return `M${x0},${y0 + h / 2} C${mx},${y0 + h / 2} ${mx},${y1 + h / 2} ${x1},${y1 + h / 2}`
}

export const pct = (n: number, total: number) => total ? `${Math.round((n / total) * 100)}%` : '0%'
