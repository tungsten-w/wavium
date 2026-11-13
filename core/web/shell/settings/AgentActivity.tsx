// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Agent activity (P2-8): who did what, for all your agents or one
// (?agent=<uid>). Actions come from the journal (with Undo); requests that did
// not become an action show their status. Every line that came through an
// approval opens that request (?request=<id>), where a waiting one can also be
// approved or rejected. Approval notifications link here.
import { useCallback, useEffect, useState } from 'react'
import { navigate, relativeTime, type Session, useLocation } from '@atrium/sdk'
import { Button, Card, Dialog, EmptyState, Select, Spinner, toast } from '@atrium/ui'
import { api } from './agentsApi'
import { type ActivityItem, type Agent, type Approval, payloadView, statusLabels } from './agentsModel'

const ago = (iso: string | null) => (iso ? relativeTime(Date.parse(iso)) : '')
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const PATH = '/settings/user/agent-activity'

function setQuery(agent: string, request: string | null) {
	const q = new URLSearchParams()
	if (agent) q.set('agent', agent)
	if (request) q.set('request', request)
	const s = q.toString()
	navigate(PATH + (s ? `?${s}` : ''), { replace: true })
}

export function AgentActivity(_: { session: Session }) {
	const { search } = useLocation()
	const params = new URLSearchParams(search)
	const agent = params.get('agent') ?? ''
	const request = params.get('request')
	const [agents, setAgents] = useState<Agent[]>([])
	const [items, setItems] = useState<ActivityItem[] | null>(null)
	const [next, setNext] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState<string | null>(null)

	const load = useCallback(async () => {
		try {
			const r = await api.activity({ agent: agent || undefined })
			setItems(r.items)
			setNext(r.next_cursor)
			setError(null)
		} catch (e) {
			setError(errText(e))
		}
	}, [agent])
	useEffect(() => { void load() }, [load])
	useEffect(() => { api.agents().then(setAgents).catch(() => {}) }, [])

	const names = new Map(agents.map((a) => [a.uid, a.displayName]))
	const more = async () => {
		if (!next) return
		try {
			const r = await api.activity({ agent: agent || undefined, cursor: next })
			setItems((list) => [...(list ?? []), ...r.items])
			setNext(r.next_cursor)
		} catch (e) {
			toast.error(errText(e))
		}
	}
	const undo = async (id: string) => {
		setBusy(id)
		try {
			const done = await api.undo(id)
			setItems((list) => list?.map((x) => (x.kind === 'action' && x.action_id === id ? { kind: 'action', ...done } : x)) ?? null)
			toast('Undone')
		} catch (e) {
			toast.error(errText(e))
			void load()
		} finally {
			setBusy(null)
		}
	}

	return (
		<section className="settings-section settings-section--wide">
			<h2 className="at-headline">Agent activity</h2>
			<p className="at-muted">What your agents did in your data over the last 30 days, and what they asked you. Undo puts a change back where Atrium knows how.</p>
			<div style={{ maxWidth: 320, marginBottom: 12 }}>
				<Select label="Agent" value={agent} onChange={(e) => setQuery(e.target.value, null)}>
					<option value="">All agents</option>
					{agents.map((a) => <option key={a.uid} value={a.uid}>{a.displayName}</option>)}
					{agent && !names.has(agent) && <option value={agent}>{agent}</option>}
				</Select>
			</div>
			{error ? <Card className="settings-block"><p>{error}</p><Button variant="tonal" onClick={() => void load()}>Retry</Button></Card>
				: !items ? <Spinner />
				: items.length === 0 ? <Card className="settings-block"><EmptyState icon="activity" title="Nothing yet">Changes and requests from your agents will show here.</EmptyState></Card>
				: <Card className="settings-block agent-activity">
					<div style={{ overflowX: 'auto' }}><table className="settings-table">
						<thead><tr><th>What</th><th>Agent</th><th>When</th><th>State</th><th /></tr></thead>
						<tbody>{items.map((it) => (
							<tr key={it.kind === 'action' ? it.action_id : it.request_id} data-item={it.kind === 'action' ? it.action_id : it.request_id}>
								<td>{it.summary}
									{it.kind === 'action' && it.undo_error && <div className="at-muted" style={{ fontSize: 13 }}>Undo failed: {it.undo_error}</div>}
									{it.kind === 'request' && it.error && <div className="at-muted" style={{ fontSize: 13 }}>{it.error}</div>}</td>
								<td className="at-muted">{names.get(it.agent) ?? it.agent}</td>
								<td className="at-muted">{ago(it.at)}</td>
								<td>{it.kind === 'request' ? statusLabels[it.status] ?? it.status
									: it.undone_at ? <span className="at-muted">Undone {ago(it.undone_at)}</span>
									: it.request_id ? 'Done after your OK' : 'Done'}</td>
								<td style={{ whiteSpace: 'nowrap' }}>
									{it.kind === 'action' && it.undo && !it.undone_at && <Button variant="text" title={it.undo} disabled={busy === it.action_id} onClick={() => void undo(it.action_id)}>Undo</Button>}
									{it.request_id && <Button variant="text" onClick={() => setQuery(agent, it.request_id)}>Request</Button>}
								</td>
							</tr>
						))}</tbody>
					</table></div>
					{next && <Button variant="text" onClick={() => void more()}>Show more</Button>}
				</Card>}
			<RequestDialog rid={request} names={names} onClose={() => setQuery(agent, null)} onDecided={() => void load()} />
		</section>
	)
}

function RequestDialog({ rid, names, onClose, onDecided }: { rid: string | null, names: Map<string, string>, onClose: () => void, onDecided: () => void }) {
	const [req, setReq] = useState<Approval | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	useEffect(() => {
		setReq(null)
		setError(null)
		if (rid) api.approval(rid).then(setReq).catch((e) => setError(errText(e)))
	}, [rid])
	const decide = async (d: 'approve' | 'reject') => {
		if (!req) return
		setBusy(true)
		try {
			setReq(await api.decide(req.request_id, d))
			toast(d === 'approve' ? 'Approved' : 'Rejected')
			onDecided()
		} catch (e) {
			toast.error(errText(e))
		} finally {
			setBusy(false)
		}
	}
	const v = req ? payloadView(req.tool, req.payload) : null
	const result = req?.result === undefined || req?.result === null ? null : JSON.stringify(req.result, null, 2)
	return (
		<Dialog open={!!rid} title="Request" onClose={onClose} actions={<>
			{req?.status === 'pending' && <>
				<Button variant="text" disabled={busy} onClick={() => void decide('reject')}>Reject</Button>
				<Button disabled={busy} onClick={() => void decide('approve')}>Approve</Button>
			</>}
			<Button variant="text" onClick={onClose}>Close</Button>
		</>}>
			{error ? <p>{error}</p> : !req || !v ? <Spinner /> : <div className="agent-request">
				<p style={{ marginTop: 0 }}><strong>{req.summary}</strong></p>
				<table className="settings-table"><tbody>
					<tr><td className="at-muted" style={{ width: 110 }}>Agent</td><td>{names.get(req.agent) ?? req.agent}</td></tr>
					<tr><td className="at-muted">Tool</td><td>{req.tool}</td></tr>
					<tr><td className="at-muted">Asked</td><td>{ago(req.requested_at)}</td></tr>
					<tr><td className="at-muted">State</td><td>{statusLabels[req.status] ?? req.status}{req.decided_at ? ` · ${ago(req.decided_at)}` : ''}</td></tr>
					{req.note && <tr><td className="at-muted">Note</td><td>{req.note}</td></tr>}
					{req.error && <tr><td className="at-muted">Error</td><td>{req.error}</td></tr>}
					{v.rows.map((r) => <tr key={r.label}><td className="at-muted">{r.label}</td><td style={{ wordBreak: 'break-word' }}>{r.value}</td></tr>)}
				</tbody></table>
				{v.body !== null && <pre className="agent-request__body">{v.body}</pre>}
				{result && <details><summary>Result</summary><pre className="agent-request__body">{result}</pre></details>}
			</div>}
		</Dialog>
	)
}
