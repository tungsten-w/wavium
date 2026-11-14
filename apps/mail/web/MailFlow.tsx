// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Where your mail goes" (v4): for one address (or all), threads that leave
// the address and split into groups, then categories. They draw in on load
// and keep flowing; hover shows the numbers, a click on a category opens it.
import { useMemo, useState } from 'react'
import { bandPath, buildFlow, centrePath, GROUPS, pct, type FlowLink, type FlowNode, type FlowRow, type GroupId } from './flow'

interface Props {
	rows: FlowRow[]
	accounts: Array<{ id: number, email: string, pending: number }>
	hides: string[]
	onShowCategory?: (category: string) => void
}

const W = 760
const NODE_W = 10
const X = [150, 400, 600] as const

export function MailFlow({ rows, accounts, hides, onShowCategory }: Props) {
	const [accountId, setAccountId] = useState<number | null>(accounts.length === 1 ? accounts[0].id : null)
	const [hover, setHover] = useState<string | null>(null)
	const [table, setTable] = useState(false)
	const pending = accountId === null ? accounts.reduce((n, a) => n + a.pending, 0) : accounts.find((a) => a.id === accountId)?.pending ?? 0
	const source = accountId === null ? 'All addresses' : accounts.find((a) => a.id === accountId)?.email ?? ''
	const model = useMemo(() => buildFlow(rows, { accountId, pending, hides, source }), [rows, accountId, pending, hides, source])
	// Replays the draw-in animation when the address changes.
	const runKey = `${accountId}`

	const tip = hover ? describe(hover, model.nodes, model.links, model.total) : null
	const lit = (l: FlowLink) => !hover || hover === l.id || hover === l.from.id || hover === l.to.id

	return <div className="ml-flow">
		{accounts.length > 1 && <div className="ml-flow__pick" role="group" aria-label="Address">
			<button className={`ml-chip ${accountId === null ? 'ml-chip--on' : ''}`} aria-pressed={accountId === null} onClick={() => setAccountId(null)}>All addresses</button>
			{accounts.map((a) => <button key={a.id} className={`ml-chip ${accountId === a.id ? 'ml-chip--on' : ''}`} aria-pressed={accountId === a.id} onClick={() => setAccountId(a.id)}>{a.email}</button>)}
		</div>}

		{model.total === 0 ? <p className="ml-st__muted">No mail sorted yet for this address.</p> : <>
			<ul className="ml-flow__legend">{GROUPS.filter((g) => model.nodes.some((n) => n.group === g.id)).map((g) => (
				<li key={g.id}><span className={`ml-flow__key ml-flow--${g.id}`} />{g.label}</li>
			))}</ul>
			<div className="ml-flow__chart">
				<svg key={runKey} viewBox={`-4 -4 ${W + 8} ${model.height + 8}`} role="img" aria-label={summary(model.nodes, model.total, source)} onMouseLeave={() => setHover(null)}>
					<g>{model.links.map((l, i) => {
						const x0 = X[l.from.column] + NODE_W, x1 = X[l.to.column]
						return <g key={l.id} className={`ml-flow__link ml-flow--${l.to.group}${lit(l) ? '' : ' ml-flow__link--dim'}`} style={{ animationDelay: `${l.from.column * 450 + i * 40}ms` }}
							onMouseEnter={() => setHover(l.id)}>
							<path className="ml-flow__band" d={bandPath(x0, l.y0, x1, l.y1, l.h)} />
							{l.h >= 3 && <path className="ml-flow__thread" d={centrePath(x0, l.y0, x1, l.y1, l.h)} style={{ animationDuration: `${2.4 + (i % 4) * 0.4}s` }} />}
						</g>
					})}</g>
					<g>{model.nodes.map((n) => {
						const x = X[n.column]
						const click = n.category && onShowCategory ? () => onShowCategory(n.category!) : undefined
						return <g key={n.id} className={`ml-flow__node ml-flow--${n.group}${click ? ' ml-flow__node--link' : ''}`} style={{ animationDelay: `${n.column * 450}ms` }}
							onMouseEnter={() => setHover(n.id)} onClick={click} role={click ? 'link' : undefined} tabIndex={click ? 0 : undefined}
							onKeyDown={click ? (e) => { if (e.key === 'Enter') click() } : undefined}>
							<rect x={x - 6} y={n.y - 2} width={NODE_W + 12} height={n.h + 4} fill="transparent" />
							<rect className="ml-flow__bar" x={x} y={n.y} width={NODE_W} height={n.h} rx={3} />
							<text x={n.column === 0 ? x - 8 : x + NODE_W + 8} y={n.y + n.h / 2} dy="0.35em" textAnchor={n.column === 0 ? 'end' : 'start'} className="ml-flow__label">
								{n.column === 0 ? <tspan>{shorten(n.label)}</tspan> : n.label}
								<tspan className="ml-flow__count"> {n.count}{n.column > 0 ? ` · ${pct(n.count, model.total)}` : ''}</tspan>
							</text>
						</g>
					})}</g>
				</svg>
				{tip && <div className="ml-flow__tip" role="status">{tip}</div>}
			</div>
			<button className="ml-flow__table-toggle" onClick={() => setTable((t) => !t)} aria-expanded={table}>{table ? 'Hide the numbers' : 'Show as a table'}</button>
			{table && <table className="ml-st__table"><thead><tr><th>Group</th><th>Category</th><th>Mails</th><th>Share</th></tr></thead>
				<tbody>{model.nodes.filter((n) => n.column === 2 || n.group === 'pending').map((n) => (
					<tr key={n.id}><td>{GROUPS.find((g) => g.id === n.group)?.label}</td><td>{n.column === 2 ? n.label : '–'}</td><td>{n.count}</td><td>{pct(n.count, model.total)}</td></tr>
				))}</tbody></table>}
		</>}
	</div>
}

const shorten = (s: string) => s.length > 22 ? s.slice(0, 20) + '…' : s

function describe(id: string, nodes: FlowNode[], links: FlowLink[], total: number): string | null {
	const n = nodes.find((x) => x.id === id)
	if (n) {
		if (n.column === 0) return `${n.label}: ${n.count} mails`
		const g = GROUPS.find((x) => x.id === n.group)
		return n.column === 1 ? `${n.label}: ${n.count} mails (${pct(n.count, total)}), ${g?.hint}` : `${g?.label} › ${n.label}: ${n.count} mails (${pct(n.count, total)})${n.category ? '. Click to open them' : ''}`
	}
	const l = links.find((x) => x.id === id)
	return l ? `${l.from.column === 0 ? l.from.label : l.from.label} → ${l.to.label}: ${l.count} mails (${pct(l.count, total)})` : null
}

function summary(nodes: FlowNode[], total: number, source: string): string {
	const groups = nodes.filter((n) => n.column === 1).map((n) => `${n.count} ${n.label.toLowerCase()}`)
	return `${source}: ${total} mails, ${groups.join(', ')}`
}

export type { GroupId }
