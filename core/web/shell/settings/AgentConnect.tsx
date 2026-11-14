// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Connect an agent (P2-7): the OAuth consent screen. An MCP client
// (Claude, Cursor, ...) sent the browser here (/agent/oauth/authorize). The
// user sees which app asks and where the browser goes back to, picks one of
// their agents (or creates one) after seeing what it may do, and says yes or
// no. The app then gets a token for that agent only: same permissions and
// approvals as an agent token from Settings > Agents.
import { useEffect, useState } from 'react'
import { type Session, useLocation } from '@atrium/sdk'
import { Button, Card, Select, Spinner, TextField, WaviumMark } from '@atrium/ui'
import { api } from './agentsApi'
import { type Agent, areaLabel, describeModes, type OAuthFlow, type Preset } from './agentsModel'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const NEW = '__new__'
const presetLabels: Record<Preset, string> = { mail: 'Mail only', todo: 'Daily Todo only', everything: 'Everything' }

/** Leaves the page for the app's redirect URI (a seam for tests). */
export const leave = { to: (url: string) => { window.location.assign(url) } }

export function AgentConnect(_: { session: Session }) {
	const { search } = useLocation()
	const flowId = new URLSearchParams(search).get('flow') ?? ''
	const [flow, setFlow] = useState<OAuthFlow | null>(null)
	const [agents, setAgents] = useState<Agent[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [choice, setChoice] = useState('')
	const [name, setName] = useState('')
	const [preset, setPreset] = useState<Preset>('mail')
	const [busy, setBusy] = useState(false)
	const [done, setDone] = useState<'approved' | 'denied' | null>(null)

	useEffect(() => {
		if (!flowId) { setError('No connection request. Start again from the app.'); return }
		Promise.all([api.oauthFlow(flowId), api.agents()]).then(([f, list]) => {
			setFlow(f)
			setAgents(list)
			setChoice(list.length ? list[0].uid : NEW)
			setName(f.client_name)
		}).catch((e) => setError(errText(e)))
	}, [flowId])

	const answer = async (yes: boolean) => {
		if (!flow) return
		setBusy(true)
		setError(null)
		try {
			let agent = choice
			if (yes && choice === NEW) {
				if (!name.trim()) throw new Error('Give the new agent a name')
				agent = (await api.createForOAuth({ name: name.trim(), description: `Connected from ${flow.client_name}`, preset })).agent.uid
			}
			const r = await api.oauthAnswer(flow.flow_id, yes ? 'approve' : 'deny', yes ? agent : undefined)
			setDone(yes ? 'approved' : 'denied')
			leave.to(r.redirect)
		} catch (e) {
			setError(errText(e))
		} finally {
			setBusy(false)
		}
	}

	const selected = agents?.find((a) => a.uid === choice)
	return (
		<section className="settings-section">
			<div className="agent-connect__brand"><WaviumMark size={26} /></div>
			<h2 className="at-headline">Connect an agent</h2>
			{done ? <Card className="settings-block"><p>{done === 'approved' ? `Done. You can go back to ${flow?.client_name}.` : 'Connection refused.'}</p></Card>
				: error && !flow ? <Card className="settings-block"><p>{error}</p></Card>
				: !flow || !agents ? <Spinner />
				: <Card className="settings-block agent-connect">
					<p style={{ marginTop: 0 }}><strong>{flow.client_name}</strong> wants to use Wavium as one of your agents.</p>
					<table className="settings-table"><tbody>
						<tr><td className="at-muted" style={{ width: 130 }}>Goes back to</td><td><strong>{flow.redirect_host}</strong></td></tr>
						{flow.client_kind === 'cimd' && <tr><td className="at-muted">App identity</td><td style={{ wordBreak: 'break-all' }}>{flow.client_id}</td></tr>}
					</tbody></table>
					{flow.localhost && <p className="at-muted agent-connect__warn">This app answers on a local address. Only continue if you started this from an app on this computer.</p>}

					<div style={{ marginTop: 16, maxWidth: 420 }}>
						<Select label="Act as" value={choice} onChange={(e) => setChoice(e.target.value)}>
							{agents.map((a) => <option key={a.uid} value={a.uid}>{a.displayName}</option>)}
							<option value={NEW}>A new agent…</option>
						</Select>
					</div>
					{choice === NEW ? <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12, maxWidth: 420 }}>
						<TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
						<Select label="What it may do" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
							{(Object.keys(presetLabels) as Preset[]).map((p) => <option key={p} value={p}>{presetLabels[p]}</option>)}
						</Select>
						<p className="at-muted" style={{ margin: 0 }}>Sending, deleting and sharing still ask you. You can change everything later in Settings &gt; Agents.</p>
					</div> : selected && <div className="agent-connect__access">
						<p className="at-muted" style={{ marginBottom: 4 }}>{selected.displayName} may:</p>
						{Object.keys(selected.access).length === 0 ? <p>Nothing yet (set its access in Settings &gt; Agents).</p>
							: <ul style={{ margin: 0, paddingLeft: 20 }}>{Object.entries(selected.access).map(([area, modes]) => <li key={area}>{areaLabel(area)}: {describeModes(modes)}</li>)}</ul>}
						{selected.paused && <p className="at-muted">This agent is paused: its calls are refused until you resume it.</p>}
					</div>}
					{error && <p className="agent-connect__error" role="alert">{error}</p>}
					<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
						<Button variant="text" disabled={busy} onClick={() => void answer(false)}>Deny</Button>
						<Button disabled={busy} onClick={() => void answer(true)}>Allow</Button>
					</div>
				</Card>}
		</section>
	)
}
