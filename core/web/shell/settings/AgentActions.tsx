// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Agents, "Recent agent actions" (P3-7): what agents changed in your
// data over the last 30 days, with Undo where Atrium knows the inverse (restore
// from a trash, delete what was created, untick, unshare, move back).
import { useCallback, useEffect, useState } from 'react'
import { relativeTime } from '@atrium/sdk'
import { Button, Card, toast } from '@atrium/ui'
import { api } from './agentsApi'
import type { AgentAction } from './agentsModel'

const ago = (iso: string | null) => (iso ? relativeTime(Date.parse(iso)) : '')
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function AgentActions({ names, refresh }: { names: Map<string, string>, refresh: number }) {
	const [items, setItems] = useState<AgentAction[] | null>(null)
	const [next, setNext] = useState<string | null>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	const load = useCallback(async () => {
		try {
			const r = await api.actions()
			setItems(r.actions)
			setNext(r.next_cursor)
			setError(null)
		} catch (e) {
			setError(errText(e))
		}
	}, [])
	useEffect(() => { void load() }, [load, refresh])

	const more = async () => {
		if (!next) return
		try {
			const r = await api.actions(next)
			setItems((list) => [...(list ?? []), ...r.actions])
			setNext(r.next_cursor)
		} catch (e) {
			toast.error(errText(e))
		}
	}

	const undo = async (a: AgentAction) => {
		setBusy(a.action_id)
		try {
			const done = await api.undo(a.action_id)
			setItems((list) => list?.map((x) => (x.action_id === a.action_id ? done : x)) ?? null)
			toast('Undone')
		} catch (e) {
			toast.error(errText(e))
			void load()
		} finally {
			setBusy(null)
		}
	}

	if (error) return <Card className="settings-block"><h3 style={{ margin: 0 }}>Recent agent actions</h3><p className="at-muted">{error}</p></Card>
	if (!items || items.length === 0) return null
	return (
		<Card className="settings-block agent-actions">
			<h3 style={{ margin: 0 }}>Recent agent actions</h3>
			<p className="at-muted" style={{ marginTop: 4 }}>Changes made by your agents in the last 30 days. Undo puts things back where Atrium knows how.</p>
			<div style={{ overflowX: 'auto' }}><table className="settings-table" style={{ marginTop: 8 }}>
				<thead><tr><th>Action</th><th>Agent</th><th>When</th><th /></tr></thead>
				<tbody>{items.map((a) => (
					<tr key={a.action_id} data-action={a.action_id}>
						<td>{a.summary}{a.undo_error && <div className="at-muted" style={{ fontSize: 13 }}>Undo failed: {a.undo_error}</div>}</td>
						<td className="at-muted">{names.get(a.agent) ?? a.agent}</td>
						<td className="at-muted">{ago(a.at)}</td>
						<td>{a.undone_at ? <span className="at-muted">Undone {ago(a.undone_at)}</span>
							: a.undo ? <Button variant="text" title={a.undo} disabled={busy === a.action_id} onClick={() => void undo(a)}>Undo</Button>
							: null}</td>
					</tr>
				))}</tbody>
			</table></div>
			{next && <Button variant="text" onClick={() => void more()}>Show more</Button>}
		</Card>
	)
}
