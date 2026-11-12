// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Agents (ADR 0009): create agents, connect them (MCP URL, token,
// webhook secret), set what each may do per app (off / allowed / ask me), wake
// and doorbell settings, tokens, and the approvals inbox. Talks to the Bun
// agent layer's owner API (agentsApi.ts); logic in agentsModel.ts.
import { useCallback, useEffect, useState } from 'react'
import { relativeTime, type Session } from '@atrium/sdk'
import { Avatar, Button, Card, Dialog, EmptyState, IconButton, Select, Spinner, Switch, TextArea, TextField, confirmDialog, toast } from '@atrium/ui'
import { api } from './agentsApi'
import {
	type Action, ACTIONS, actionLabels, type Agent, applyCell, type Approval, areaLabel, type ConnectInfo, describeModes,
	type Mode, modeLabels, modesFor, payloadView, type Preset, sortAreas, statusLabels,
} from './agentsModel'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const ago = (iso: string | null) => (iso ? relativeTime(Date.parse(iso)) : '')

interface Areas { areas: Record<string, Action[]>, tools: Record<string, number> }

export function Agents(_: { session: Session }) {
	const [agents, setAgents] = useState<Agent[] | null>(null)
	const [areas, setAreas] = useState<Areas | null>(null)
	const [pending, setPending] = useState<Approval[]>([])
	const [history, setHistory] = useState<Approval[]>([])
	const [error, setError] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)
	const [connect, setConnect] = useState<ConnectInfo | null>(null)

	const loadApprovals = useCallback(async () => {
		const [p, all] = await Promise.all([api.approvals('pending'), api.approvals(undefined, 30)])
		setPending(p)
		setHistory(all.filter((a) => a.status !== 'pending'))
	}, [])
	const load = useCallback(async () => {
		try {
			const [list, ar] = await Promise.all([api.agents(), api.areas()])
			setAgents(list)
			setAreas({ areas: ar.areas ?? {}, tools: ar.tools ?? {} })
			await loadApprovals()
			setError(null)
		} catch (e) {
			setError(errText(e))
		}
	}, [loadApprovals])
	useEffect(() => {
		void load()
		// The approvals inbox refreshes while the page is open.
		const t = window.setInterval(() => { if (!document.hidden) void loadApprovals().catch(() => {}) }, 15_000)
		return () => window.clearInterval(t)
	}, [load, loadApprovals])

	const replace = (a: Agent) => setAgents((list) => list?.map((x) => (x.uid === a.uid ? a : x)) ?? null)
	const names = new Map(agents?.map((a) => [a.uid, a.displayName]) ?? [])

	return (
		<section className="settings-section settings-section--wide">
			<h2 className="at-headline">Agents</h2>
			<p className="at-muted">AI agents are accounts that act for you. You decide what each one may do in every app, and what has to wait for your OK.</p>
			{error ? <Card className="settings-block"><p>{error}</p><Button variant="tonal" onClick={() => void load()}>Retry</Button></Card>
				: !agents || !areas ? <Spinner />
				: <>
					{pending.length > 0 && <ApprovalsInbox items={pending} names={names} onDone={() => void loadApprovals()} />}
					<div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
						<Button icon="add" onClick={() => setCreating(true)}>New agent</Button>
					</div>
					{agents.length === 0 && <Card className="settings-block"><EmptyState icon="agent" title="No agents yet">Create one, then connect it with the MCP URL and token shown once.</EmptyState></Card>}
					{agents.map((a) => <AgentCard key={a.uid} agent={a} areas={areas} onChange={replace} onConnect={setConnect} onDeleted={() => void load()} />)}
					{history.length > 0 && <History items={history} names={names} />}
				</>}
			<CreateDialog open={creating} onClose={() => setCreating(false)} onCreated={(c) => { setCreating(false); setConnect(c); void load() }} />
			<ConnectDialog info={connect} onClose={() => setConnect(null)} />
		</section>
	)
}

function ApprovalsInbox({ items, names, onDone }: { items: Approval[], names: Map<string, string>, onDone: () => void }) {
	const [busy, setBusy] = useState<string | null>(null)
	const [rejecting, setRejecting] = useState<Approval | null>(null)
	const [note, setNote] = useState('')
	const decide = async (a: Approval, decision: 'approve' | 'reject', why?: string) => {
		setBusy(a.request_id)
		try {
			const r = await api.decide(a.request_id, decision, why)
			toast(r.status === 'executed' ? 'Approved and done' : r.status === 'failed' ? `Approved, but it failed: ${r.error ?? ''}` : r.status === 'void' ? 'It changed since it was asked; nothing was done' : statusLabels[r.status])
		} catch (e) {
			toast.error(errText(e))
		}
		setBusy(null)
		onDone()
	}
	return (
		<Card className="settings-block">
			<h3>Waiting for your OK ({items.length})</h3>
			{items.map((a) => {
				const v = payloadView(a.tool, a.payload)
				return (
					<div key={a.request_id} style={{ borderTop: '1px solid var(--at-outline-variant)', padding: '12px 0' }}>
						<div className="at-title-s">{a.summary}</div>
						<div className="at-muted" style={{ fontSize: 13 }}>{names.get(a.agent) ?? a.agent} · {a.tool} · asked {ago(a.requested_at)}</div>
						{v.rows.length > 0 && <table className="settings-table" style={{ marginTop: 8 }}><tbody>
							{v.rows.map((r) => <tr key={r.label}><td className="at-muted" style={{ width: 110 }}>{r.label}</td><td style={{ wordBreak: 'break-word' }}>{r.value}</td></tr>)}
						</tbody></table>}
						{v.body !== null && <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto', background: 'var(--at-surface-container, rgba(127,127,127,.08))', padding: 12, borderRadius: 8, fontSize: 13, fontFamily: 'inherit' }}>{v.body}</pre>}
						<div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
							<Button icon="check" busy={busy === a.request_id} onClick={() => void decide(a, 'approve')}>Approve</Button>
							<Button variant="tonal" icon="close" disabled={busy === a.request_id} onClick={() => { setNote(''); setRejecting(a) }}>Reject</Button>
						</div>
					</div>
				)
			})}
			<Dialog open={!!rejecting} title="Reject" onClose={() => setRejecting(null)} actions={<>
				<Button variant="text" onClick={() => setRejecting(null)}>Cancel</Button>
				<Button onClick={() => { const a = rejecting!; setRejecting(null); void decide(a, 'reject', note.trim() || undefined) }}>Reject</Button>
			</>}>
				<p className="at-muted" style={{ marginTop: 0 }}>The agent sees your note, so it can do better next time.</p>
				<TextArea label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
			</Dialog>
		</Card>
	)
}

function History({ items, names }: { items: Approval[], names: Map<string, string> }) {
	const [open, setOpen] = useState(false)
	return (
		<Card className="settings-block">
			<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
				<h3 style={{ margin: 0 }}>Recent decisions</h3>
				<Button variant="text" onClick={() => setOpen(!open)}>{open ? 'Hide' : `Show ${items.length}`}</Button>
			</div>
			{open && <div style={{ overflowX: 'auto' }}><table className="settings-table" style={{ marginTop: 8 }}>
				<thead><tr><th>Request</th><th>Agent</th><th>Result</th><th>When</th></tr></thead>
				<tbody>{items.map((a) => (
					<tr key={a.request_id}>
						<td>{a.summary}{a.note && <div className="at-muted" style={{ fontSize: 13 }}>Note: {a.note}</div>}{a.error && <div className="at-muted" style={{ fontSize: 13 }}>{a.error}</div>}</td>
						<td className="at-muted">{names.get(a.agent) ?? a.agent}</td>
						<td>{statusLabels[a.status]}</td>
						<td className="at-muted">{ago(a.decided_at ?? a.requested_at)}</td>
					</tr>
				))}</tbody>
			</table></div>}
		</Card>
	)
}

function AgentCard({ agent: a, areas, onChange, onConnect, onDeleted }: {
	agent: Agent, areas: Areas, onChange: (a: Agent) => void, onConnect: (c: ConnectInfo) => void, onDeleted: () => void
}) {
	const [webhook, setWebhook] = useState(a.webhookUrl ?? '')
	const [busy, setBusy] = useState(false)
	const [showAll, setShowAll] = useState(false)
	const [secret, setSecret] = useState<string | null>(null)
	useEffect(() => setWebhook(a.webhookUrl ?? ''), [a.webhookUrl])

	const run = async (fn: () => Promise<Agent | void>, done?: string) => {
		setBusy(true)
		try {
			const r = await fn()
			if (r) onChange(r)
			if (done) toast(done)
		} catch (e) {
			toast.error(errText(e))
		}
		setBusy(false)
	}
	const setCell = (area: string, action: Action, mode: Mode) =>
		run(() => api.setAccess(a.uid, { areas: { [area]: applyCell(a.access[area], action, mode, areas.areas[area] ?? []) } }))
	const preset = async (p: Preset) => {
		if (!(await confirmDialog(`Replace ${a.displayName}'s access with the "${p === 'mail' ? 'Mail only' : p === 'todo' ? 'Daily Todo only' : 'Everything'}" preset? Sending, deleting and sharing still ask you.`, { confirm: 'Replace' }))) return
		await run(() => api.setAccess(a.uid, { preset: p }), 'Access updated')
	}
	const remove = async () => {
		if (!(await confirmDialog(`Delete ${a.displayName}? Its account, tokens and access are removed. What it did stays.`, { confirm: 'Delete', danger: true }))) return
		setBusy(true)
		try { await api.remove(a.uid); toast('Agent deleted'); onDeleted() } catch (e) { toast.error(errText(e)); setBusy(false) }
	}

	const all = sortAreas(Object.keys(areas.areas), areas.tools)
	const shown = all.filter((x) => showAll || a.access[x] || (areas.tools[x] ?? 0) > 0)
	const granted = Object.keys(a.access).filter((x) => areas.areas[x])

	return (
		<Card className="settings-block">
			<div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
				<Avatar name={a.displayName} src={`/avatar/${encodeURIComponent(a.uid)}/64`} size={48} />
				<div style={{ flex: 1, minWidth: 0 }}>
					<div className="at-title-s">{a.displayName} {a.paused && <span className="at-chip at-chip--small">Paused</span>}</div>
					<div className="at-muted" style={{ fontSize: 13 }}>{a.description || a.uid} · added {relativeTime(a.createdAt * 1000)}</div>
				</div>
				<IconButton icon="delete" label={`Delete ${a.displayName}`} onClick={() => void remove()} disabled={busy} />
			</div>

			<div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
				<Switch label="Paused: every tool call is refused" checked={a.paused} disabled={busy} onChange={(e) => void run(() => api.update(a.uid, { paused: e.target.checked }))} />
				<Switch label="Wake it up for new Curated mail and decisions (for agents that run all the time)" checked={a.wakes} disabled={busy} onChange={(e) => void run(() => api.update(a.uid, { wakes: e.target.checked }))} />
				<Switch label="Notify me (ntfy) when it asks for approval" checked={a.notifyApprovals} disabled={busy} onChange={(e) => void run(() => api.update(a.uid, { notifyApprovals: e.target.checked }))} />
			</div>

			<h3 style={{ marginTop: 20 }}>Doorbell</h3>
			<p className="at-muted" style={{ marginTop: 0, fontSize: 13 }}>Atrium POSTs a signed, data-free ping to this URL when there is something new; the agent then reads its events. Leave empty if it polls.</p>
			<form className="settings-row" onSubmit={(e) => { e.preventDefault(); void run(() => api.update(a.uid, { webhookUrl: webhook.trim() || null }), 'Doorbell saved') }}>
				<TextField label="Webhook URL" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="http://agent-host.lan:7013/atrium/doorbell" />
				<Button type="submit" variant="tonal" busy={busy} disabled={webhook.trim() === (a.webhookUrl ?? '')}>Save</Button>
				<Button variant="text" disabled={busy} onClick={async () => {
					if (!(await confirmDialog('Make a new webhook secret? The agent must get the new one, or its doorbell stops being accepted.', { confirm: 'New secret' }))) return
					try { setSecret((await api.newSecret(a.uid)).webhookSecret) } catch (e) { toast.error(errText(e)) }
				}}>New secret</Button>
			</form>
			{a.doorbellError && <p style={{ color: 'var(--at-error)', fontSize: 13 }}>Doorbell problem {a.doorbellErrorAt ? relativeTime(a.doorbellErrorAt * 1000) : ''}: {a.doorbellError}</p>}

			<h3 style={{ marginTop: 20 }}>Access</h3>
			<div className="settings-row" style={{ marginBottom: 8, alignItems: 'center' }}>
				<span className="at-muted" style={{ fontSize: 13 }}>Presets:</span>
				<Button variant="tonal" size="s" disabled={busy} onClick={() => void preset('mail')}>Mail only</Button>
				<Button variant="tonal" size="s" disabled={busy} onClick={() => void preset('todo')}>Daily Todo only</Button>
				<Button variant="tonal" size="s" disabled={busy} onClick={() => void preset('everything')}>Everything</Button>
			</div>
			<div style={{ overflowX: 'auto' }}>
				<table className="settings-table">
					<thead><tr><th>App</th>{ACTIONS.map((x) => <th key={x}>{actionLabels[x]}</th>)}</tr></thead>
					<tbody>{shown.map((area) => {
						const available = areas.areas[area] ?? []
						const modes = a.access[area]
						return (
							<tr key={area}>
								<td>
									<div>{areaLabel(area)}</div>
									<div className="at-muted" style={{ fontSize: 12 }}>{(areas.tools[area] ?? 0) > 0 ? `${areas.tools[area]} agent tools` : 'App API only'} · {describeModes(modes)}</div>
								</td>
								{ACTIONS.map((x) => (
									<td key={x}>{available.includes(x) ? (
										<select className={`settings-mode settings-mode--${modes?.[x] ?? 'off'}`} aria-label={`${areaLabel(area)} ${actionLabels[x]}`} value={modes?.[x] ?? 'off'} disabled={busy}
											onChange={(e) => void setCell(area, x, e.target.value as Mode)}>
											{modesFor(x).map((m) => <option key={m} value={m}>{modeLabels[m]}</option>)}
										</select>
									) : <span className="at-muted">–</span>}</td>
								))}
							</tr>
						)
					})}</tbody>
				</table>
			</div>
			<Button variant="text" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer apps' : `Show all ${all.length} apps`}</Button>
			{granted.length === 0 && <p className="at-muted" style={{ fontSize: 13 }}>No access yet: the agent can only ask who it is.</p>}

			<h3 style={{ marginTop: 20 }}>Tokens</h3>
			<table className="settings-table">
				<tbody>
					{a.tokens.length === 0 && <tr><td className="at-muted">No tokens: the agent cannot connect.</td></tr>}
					{a.tokens.map((t) => (
						<tr key={t.id}>
							<td>{t.name}</td>
							<td className="at-muted">{t.lastActivity ? `used ${relativeTime(t.lastActivity * 1000)}` : 'never used'}</td>
							<td style={{ textAlign: 'right' }}><IconButton icon="delete" label={`Revoke ${t.name}`} disabled={busy} onClick={async () => {
								if (!(await confirmDialog(`Revoke the token "${t.name}"? Whatever uses it stops working.`, { confirm: 'Revoke', danger: true }))) return
								await run(async () => { await api.revokeToken(a.uid, t.id); onChange({ ...a, tokens: a.tokens.filter((x) => x.id !== t.id) }) }, 'Token revoked')
							}} /></td>
						</tr>
					))}
				</tbody>
			</table>
			<div style={{ marginTop: 8 }}>
				<Button variant="tonal" icon="key" disabled={busy} onClick={() => void run(async () => {
					const r = await api.newToken(a.uid, `token ${new Date().toISOString().slice(0, 10)}`)
					onConnect(r.connect)
					onChange({ ...a, tokens: [...a.tokens, { id: r.id, name: r.name, lastActivity: 0 }] })
				})}>New token</Button>
			</div>

			<Dialog open={!!secret} title="New webhook secret" onClose={() => setSecret(null)} actions={<Button onClick={() => setSecret(null)}>Done</Button>}>
				<p className="at-muted" style={{ marginTop: 0 }}>Give it to the agent. It is shown only once.</p>
				<Copyable label="Webhook secret" value={secret ?? ''} />
			</Dialog>
		</Card>
	)
}

function CreateDialog({ open, onClose, onCreated }: { open: boolean, onClose: () => void, onCreated: (c: ConnectInfo) => void }) {
	const [name, setName] = useState('')
	const [description, setDescription] = useState('')
	const [preset, setPreset] = useState<Preset | ''>('mail')
	const [busy, setBusy] = useState(false)
	useEffect(() => { if (open) { setName(''); setDescription(''); setPreset('mail') } }, [open])
	const submit = async () => {
		setBusy(true)
		try {
			const r = await api.create({ name: name.trim(), description: description.trim(), ...(preset ? { preset } : {}) })
			onCreated(r.connect)
		} catch (e) {
			toast.error(errText(e))
		}
		setBusy(false)
	}
	return (
		<Dialog open={open} title="New agent" onClose={onClose} actions={<>
			<Button variant="text" onClick={onClose}>Cancel</Button>
			<Button busy={busy} disabled={!name.trim()} onClick={() => void submit()}>Create</Button>
		</>}>
			<p className="at-muted" style={{ marginTop: 0 }}>An agent is its own account that cannot log in with a password. It connects with a token.</p>
			<TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} hint="For example: Nova" autoFocus />
			<div style={{ height: 12 }} />
			<TextField label="What it is for (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
			<div style={{ height: 12 }} />
			<Select label="Start with" value={preset} onChange={(e) => setPreset(e.target.value as Preset | '')}>
				<option value="mail">Mail: read and write; send and delete ask you</option>
				<option value="todo">Daily Todo only</option>
				<option value="everything">Every app (send, delete and share ask you)</option>
				<option value="">No access</option>
			</Select>
		</Dialog>
	)
}

function Copyable({ label, value, multiline }: { label: string, value: string, multiline?: boolean }) {
	return (
		<div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 12 }}>
			<div style={{ flex: 1, minWidth: 0 }}>
				{multiline
					? <TextArea label={label} value={value} readOnly rows={Math.min(8, value.split('\n').length)} onFocus={(e) => e.target.select()} style={{ fontFamily: 'monospace', fontSize: 12 }} />
					: <TextField label={label} value={value} readOnly onFocus={(e) => e.target.select()} />}
			</div>
			<IconButton icon="copy" label={`Copy ${label}`} onClick={() => { void navigator.clipboard?.writeText(value); toast('Copied') }} />
		</div>
	)
}

function ConnectDialog({ info, onClose }: { info: ConnectInfo | null, onClose: () => void }) {
	return (
		<Dialog open={!!info} title="Connect the agent" onClose={onClose} actions={<Button onClick={onClose}>Done</Button>}>
			{info && <>
				<p className="at-muted" style={{ marginTop: 0 }}>The token and webhook secret are shown only once. Copy them into the agent now.</p>
				<Copyable label="MCP URL" value={info.mcpUrl} />
				<Copyable label="Token" value={info.token} />
				{info.webhookSecret && <Copyable label="Webhook secret" value={info.webhookSecret} />}
				<Copyable label="Claude Code" value={info.snippets.claudeCode} multiline />
				<Copyable label=".mcp.json" value={info.snippets.mcpJson} multiline />
				<Copyable label="Codex (config.toml)" value={info.snippets.codex} multiline />
				<p className="at-muted" style={{ fontSize: 13 }}>REST: <code>{info.restUrl}</code> · OpenAPI: <code>{info.openapiUrl}</code></p>
			</>}
		</Dialog>
	)
}
