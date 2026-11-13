// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mail > Rules (PLAN P5-3): write a filing rule in your own words, the AI turns
// it into a rule and shows which mails it would match; nothing happens until
// you save it. Saved rules run on new mail without AI (/agent/v1/rules).
import { useCallback, useEffect, useState } from 'react'
import { HttpError, request, relativeTime } from '@atrium/sdk'
import { Button, Card, IconButton, NavToggle, Spinner, Switch, TextField, toast } from '@atrium/ui'

export interface RuleView {
	id: number
	name: string
	account: number
	when: Record<string, string>
	then: { move_to?: number, mark_read?: boolean, star?: boolean }
	enabled: boolean
	description: string
	source_text?: string | null
}
interface Proposal {
	rule: Omit<RuleView, 'id' | 'enabled' | 'description'> & { source_text: string }
	description: string
	preview: { scanned: number, count: number, sample: Array<{ subject: string, from: string | null }> }
}
interface Overview {
	rules: RuleView[]
	accounts: Array<{ id: number, email: string }>
	recent: Array<{ rule_id: number, subject: string, at: number }>
}

async function api<T>(path: string, opts: { method?: string, body?: unknown } = {}): Promise<T> {
	try {
		return await request<T>(`/agent/v1/rules${path}`, { ...opts, headers: { 'OCS-APIRequest': 'true' } })
	} catch (e) {
		if (e instanceof HttpError) throw new Error((e.body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${e.status}`)
		throw e
	}
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function MailRules() {
	const [data, setData] = useState<Overview | null>(null)
	const [text, setText] = useState('')
	const [account, setAccount] = useState<number | null>(null)
	const [proposal, setProposal] = useState<Proposal | null>(null)
	const [busy, setBusy] = useState(false)

	const load = useCallback(() => {
		api<Overview>('').then((d) => { setData(d); setAccount((a) => a ?? d.accounts[0]?.id ?? null) }, (e) => toast.error(errText(e)))
	}, [])
	useEffect(() => { load() }, [load])

	async function propose() {
		if (!text.trim()) return
		setBusy(true)
		setProposal(null)
		try { setProposal(await api<Proposal>('/propose', { method: 'POST', body: { text, ...(account !== null ? { account } : {}) } })) } catch (e) { toast.error(errText(e)) } finally { setBusy(false) }
	}

	async function save(applyNow: boolean) {
		if (!proposal) return
		setBusy(true)
		try {
			const r = await api<RuleView>('', { method: 'POST', body: proposal.rule })
			if (applyNow) {
				const { applied } = await api<{ applied: number }>(`/${r.id}/apply`, { method: 'POST' })
				toast(`Rule saved; ${applied} mail${applied === 1 ? '' : 's'} filed`)
			} else {
				toast('Rule saved: it applies to new mail')
			}
			setProposal(null)
			setText('')
			load()
		} catch (e) { toast.error(errText(e)) } finally { setBusy(false) }
	}

	async function toggle(r: RuleView, on: boolean) {
		try { await api(`/${r.id}`, { method: 'PATCH', body: { enabled: on } }); load() } catch (e) { toast.error(errText(e)) }
	}
	async function remove(r: RuleView) {
		try { await api(`/${r.id}`, { method: 'DELETE' }); load() } catch (e) { toast.error(errText(e)) }
	}
	async function apply(r: RuleView) {
		try {
			const { applied } = await api<{ applied: number }>(`/${r.id}/apply`, { method: 'POST' })
			toast(`${applied} mail${applied === 1 ? '' : 's'} filed`)
			load()
		} catch (e) { toast.error(errText(e)) }
	}

	return (
		<div className="ml-st ml-rules">
			<header className="ml-st__head"><NavToggle /><div><h1>Rules</h1><p>Filing rules run on new mail, without AI</p></div></header>
			<Card className="ml-st__card ml-st__wide">
				<h2>New rule</h2>
				<form className="ml-rules__ask" onSubmit={(e) => { e.preventDefault(); void propose() }}>
					<TextField label="Describe it in your own words" placeholder="e.g. invoices from EDF go to Admin, marked read" value={text} onChange={(e) => setText(e.target.value)} />
					{data && data.accounts.length > 1 && (
						<select aria-label="Account" value={account ?? ''} onChange={(e) => setAccount(Number(e.target.value))}>
							{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
						</select>
					)}
					<Button type="submit" icon="robot" busy={busy && !proposal} disabled={!text.trim()}>Propose</Button>
				</form>
				{proposal && (
					<div className="ml-rules__proposal" aria-label="Proposed rule">
						<p><strong>{proposal.rule.name}</strong>: {proposal.description}</p>
						<p className="ml-st__muted">
							{proposal.preview.count === 0 ? `No mail in the last ${proposal.preview.scanned} of your inbox matches yet.` : `Matches ${proposal.preview.count} of the last ${proposal.preview.scanned} mails in your inbox, e.g.:`}
						</p>
						{proposal.preview.sample.length > 0 && <ul>{proposal.preview.sample.map((s, i) => <li key={i}>{s.subject} <small>{s.from}</small></li>)}</ul>}
						<div className="ml-rules__actions">
							<Button busy={busy} onClick={() => void save(false)}>Save rule</Button>
							{proposal.preview.count > 0 && <Button variant="tonal" disabled={busy} onClick={() => void save(true)}>Save and file these {proposal.preview.count} now</Button>}
							<Button variant="text" disabled={busy} onClick={() => setProposal(null)}>Cancel</Button>
						</div>
					</div>
				)}
			</Card>

			<Card className="ml-st__card ml-st__wide">
				<h2>Your rules</h2>
				{!data && <Spinner small />}
				{data && !data.rules.length && <p className="ml-st__muted">No rules yet.</p>}
				{data && data.rules.length > 0 && (
					<ul className="ml-rules__list">
						{data.rules.map((r) => (
							<li key={r.id} data-rule={r.id}>
								<Switch checked={r.enabled} label={r.name} onChange={(e) => void toggle(r, e.target.checked)} />
								<span className="ml-rules__desc">{r.description}</span>
								<Button variant="text" onClick={() => void apply(r)}>Apply now</Button>
								<IconButton icon="delete" label={`Delete rule ${r.name}`} onClick={() => void remove(r)} />
							</li>
						))}
					</ul>
				)}
			</Card>

			{data && data.recent.length > 0 && (
				<Card className="ml-st__card ml-st__wide">
					<h2>Recently filed</h2>
					<ul className="ml-rules__recent">
						{data.recent.map((x, i) => <li key={i}>{x.subject} <small>· {data.rules.find((r) => r.id === x.rule_id)?.name ?? 'deleted rule'} · {relativeTime(x.at * 1000)}</small></li>)}
					</ul>
				</Card>
			)}
		</div>
	)
}
