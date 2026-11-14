// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Mail status: the whole pipeline at a glance, from IMAP sync to classification.
import { useCallback, useEffect, useState } from 'react'
import { relativeTime } from '@atrium/sdk'
import { Card, NavToggle, Progress, Spinner, Switch, toast } from '@atrium/ui'
import { MailFlow } from './MailFlow'
import { categoryLabels, DEFAULT_CURATED_HIDES, filterCategories, loadCuratedHides, saveCuratedHides, setTriageEnabled, triageStatus, urgencyLabels, type TriageStatus } from './api'

const stateText: Record<string, [string, string]> = {
	running: ['Classifying', 'ok'],
	idle: ['Up to date', 'ok'],
	backfill_cap: ['New mail only: today’s backlog budget is used', 'warn'],
	daily_cap: ['Paused: today’s budget is used', 'warn'],
	budget_exhausted: ['Paused: the AI budget is used up', 'warn'],
	backoff: ['Waiting after errors', 'warn'],
	unauthorized: ['The AI refused the key', 'error'],
	not_configured: ['Not configured: add an AI in Settings > AI', 'error'],
	disabled: ['Off', 'off'],
}
const eur = (v: number) => v < 0.01 && v > 0 ? `€${v.toFixed(4)}` : `€${v.toFixed(2)}`
const when = (t: number | null | undefined) => t ? relativeTime(t * 1000) : 'never'
const jobLabels: Record<string, string> = {
	SyncJob: 'Sync with mail server', TriageJob: 'Classification', PreviewEnhancementProcessingJob: 'Prepare previews',
	OutboxWorkerJob: 'Send outbox', TrainImportanceClassifierJob: 'Importance training', QuotaJob: 'Quota check',
	CleanupJob: 'Cleanup', DraftsJob: 'Drafts', TrashRetentionJob: 'Trash retention', IMipMessageJob: 'Calendar invitations',
	WakeJob: 'Wake snoozed', ContextChat: 'Context chat', RepairSyncJob: 'Repair sync', FollowUpClassifierJob: 'Follow-up check',
}

/** Horizontal bars, largest first. */
function Bars({ rows }: { rows: { label: string, count: number }[] }) {
	const max = Math.max(1, ...rows.map((r) => r.count))
	if (!rows.length) return <p className="ml-st__muted">Nothing classified yet.</p>
	return <ul className="ml-st__bars">{[...rows].sort((a, b) => b.count - a.count).map((r) => (
		<li key={r.label}><span>{r.label}</span><span className="ml-st__bar"><span style={{ width: `${(r.count / max) * 100}%` }} /></span><span className="ml-st__num">{r.count}</span></li>
	))}</ul>
}

export function MailStatus({ onCuratedChange, onShowCategory }: { onCuratedChange?: () => void, onShowCategory?: (category: string) => void } = {}) {
	const [s, setS] = useState<TriageStatus | null>(null)
	const [hides, setHides] = useState<string[]>([...DEFAULT_CURATED_HIDES])
	useEffect(() => { loadCuratedHides().then(setHides).catch(() => {}) }, [])
	const [busy, setBusy] = useState(false)
	const load = useCallback(() => triageStatus().then(setS).catch((e) => toast.error(e instanceof Error ? e.message : String(e))), [])
	useEffect(() => {
		void load()
		const t = window.setInterval(() => { if (!document.hidden) void load() }, 10_000)
		return () => window.clearInterval(t)
	}, [load])

	if (!s) return <div className="ml-center"><Spinner /></div>
	const waiting = s.queue.pendingNew + s.queue.pendingBacklog
	// "idle" with mail still queued = between runs (cron every 5 minutes), not done.
	const [label, tone] = s.state.state === 'idle' && waiting > 0 ? [`${waiting} waiting for the next run (every 5 minutes)`, 'ok'] : stateText[s.state.state] ?? [s.state.state, 'warn']
	const total = s.queue.done + s.queue.pendingNew + s.queue.pendingBacklog + s.queue.parked
	const maxDay = Math.max(1, ...s.daily.map((d) => d.count))
	// Always 14 slots, today last, so quiet days show as gaps.
	const days = Array.from({ length: 14 }, (_, i) => {
		const d = new Date(s.now * 1000 - (13 - i) * 86_400_000)
		const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
		return s.daily.find((x) => x.day === key) ?? { day: key, count: 0, eur: 0 }
	})
	const toggle = async (on: boolean) => {
		setBusy(true)
		try { await setTriageEnabled(on); await load() } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
	}

	return <div className="ml-st">
		<header className="ml-st__head"><NavToggle /><div><h1>Mail status</h1><p>Updates every 10 seconds</p></div></header>

		<Card className="ml-st__card ml-st__wide">
			<div className="ml-st__pipe">
				<div className={`ml-st__state ml-st__state--${tone}`}><span className="ml-st__dot" />{label}</div>
				{s.canManage && <Switch label="Classification" checked={s.settings.enabled} disabled={busy || !s.settings.configured} onChange={(e) => void toggle(e.target.checked)} />}
			</div>
			<dl className="ml-st__facts">
				<div><dt>Last run</dt><dd>{when(s.state.lastRun)}</dd></div>
				<div><dt>Last classified</dt><dd>{when(s.state.lastOk)}</dd></div>
				<div><dt>New mail check</dt><dd>{when(s.state.lastScan)}</dd></div>
				{s.state.pausedUntil && <div><dt>Resumes</dt><dd>{when(s.state.pausedUntil)}</dd></div>}
				<div><dt>Model</dt><dd>{s.settings.model} · {s.settings.questionsVersion}</dd></div>
			</dl>
			{s.state.lastError && <p className="ml-st__error">Last error {when(s.state.lastErrorAt)}: {s.state.lastError}</p>}
		</Card>

		<Card className="ml-st__card ml-st__wide">
			<h2>Where your mail goes</h2>
			<p className="ml-st__muted">Every mail of an address, split by what the classifier found. Hover a thread for the numbers; click a category to open those mails.</p>
			<MailFlow rows={s.flows ?? []} hides={hides} onShowCategory={onShowCategory}
				accounts={s.accounts.map((a) => ({ id: a.id, email: a.email, pending: a.pendingNew + a.pendingBacklog + a.parked }))} />
		</Card>

		<CuratedCard onChange={(h) => { setHides(h); onCuratedChange?.() }} />

		<div className="ml-st__tiles ml-st__wide">
			<Card className="ml-st__tile"><span>Classified</span><strong>{s.queue.done}</strong><small>of {total} mails</small></Card>
			<Card className="ml-st__tile"><span>New mail waiting</span><strong>{s.queue.pendingNew}</strong><small>handled first</small></Card>
			<Card className="ml-st__tile"><span>Backlog waiting</span><strong>{s.queue.pendingBacklog}</strong><small>older mail, newest first</small></Card>
			<Card className="ml-st__tile"><span>Problems</span><strong>{s.queue.parked}</strong><small>gave up after 5 tries</small></Card>
		</div>

		{s.sync && <div className="ml-st__tiles ml-st__wide">
			<Card className="ml-st__tile"><span>Waiting for the mail server</span><strong>{s.sync.pendingWrites}</strong><small>{s.sync.failedWrites > 0 ? `${s.sync.failedWrites} gave up; ` : ''}flag, move and delete changes, retried every minute</small></Card>
			<Card className="ml-st__tile"><span>Reader copies to fill</span><strong>{s.sync.readerTodo}</strong><small>{s.sync.readerUnavailable} could not be loaded, skipped</small></Card>
			<Card className="ml-st__tile"><span>Attachments kept</span><strong>{s.sync.attachments}</strong><small>{s.sync.attachmentBytes > 0 ? `${(s.sync.attachmentBytes / 1048576).toFixed(1)} MB, ` : ''}only what was downloaded</small></Card>
		</div>}

		<Card className="ml-st__card">
			<h2>Spending</h2>
			<div className="ml-st__meter"><span>Today</span><span>{eur(s.spent.todayEur)} of {eur(s.settings.capTotalEur)}</span></div>
			<Progress value={s.spent.todayEur / s.settings.capTotalEur} />
			<div className="ml-st__meter"><span>Today on the backlog</span><span>{eur(s.spent.todayBackfillEur)} of {eur(s.settings.capBackfillEur)}</span></div>
			<Progress value={s.spent.todayBackfillEur / s.settings.capBackfillEur} />
			<p className="ml-st__muted">This month: {eur(s.spent.monthEur)}. Days reset at midnight ({s.settings.timezone}). {s.settings.backend === 'tollgate' ? 'tollgate’s monthly budget applies on top.' : 'Estimated from tokens; the caps in Settings > AI apply on top.'}</p>
		</Card>

		<Card className="ml-st__card">
			<h2>Last 14 days</h2>
			{s.daily.length ? <div className="ml-st__days">{days.map((d) => (
				<div key={d.day} title={`${d.day}: ${d.count} mails, ${eur(d.eur)}`}><span style={{ height: `${(d.count / maxDay) * 100}%` }} /><small>{d.day.slice(8)}</small></div>
			))}</div> : <p className="ml-st__muted">Nothing classified yet.</p>}
		</Card>

		<Card className="ml-st__card"><h2>Categories</h2><Bars rows={s.categories.map((c) => ({ label: categoryLabels[c.category] ?? c.category, count: c.count }))} /></Card>
		<Card className="ml-st__card"><h2>Urgency</h2><Bars rows={s.urgency.map((u) => ({ label: urgencyLabels[u.urgency] ?? u.urgency, count: u.count }))} /></Card>

		<Card className="ml-st__card ml-st__wide">
			<h2>Accounts</h2>
			<table className="ml-st__table"><thead><tr><th>Account</th><th>Classified</th><th>New waiting</th><th>Backlog</th><th>Problems</th></tr></thead>
				<tbody>{s.accounts.map((a) => <tr key={a.id}><td>{a.email}</td><td>{a.done}</td><td>{a.pendingNew}</td><td>{a.pendingBacklog}</td><td>{a.parked}</td></tr>)}</tbody></table>
		</Card>

		<Card className="ml-st__card ml-st__wide">
			<h2>Recently classified</h2>
			{s.recent.length ? <table className="ml-st__table"><thead><tr><th>Mail</th><th>Category</th><th>Urgency</th><th>Reply</th><th>Action</th><th>Cost</th><th>When</th></tr></thead>
				<tbody>{s.recent.map((r, i) => <tr key={i}><td className="ml-st__subject">{r.subject ?? '(gone)'}</td><td>{categoryLabels[r.category ?? ''] ?? r.category}</td><td>{urgencyLabels[r.urgency ?? ''] ?? r.urgency}</td>
					<td>{r.needsReply === null ? '–' : `${Math.round(r.needsReply * 100)}%`}</td><td>{r.needsAction === null ? '–' : `${Math.round(r.needsAction * 100)}%`}</td><td>{eur(r.costEur)}</td><td>{when(r.classifiedAt)}</td></tr>)}</tbody></table>
				: <p className="ml-st__muted">Nothing classified yet.</p>}
		</Card>

		{s.problems.length > 0 && <Card className="ml-st__card ml-st__wide">
			<h2>Problems</h2>
			<table className="ml-st__table"><thead><tr><th>Mail</th><th>State</th><th>Tries</th><th>Error</th><th>When</th></tr></thead>
				<tbody>{s.problems.map((p, i) => <tr key={i}><td className="ml-st__subject">{p.subject ?? '(gone)'}</td><td>{p.status === 'parked' ? 'Gave up' : 'Will retry'}</td><td>{p.attempts}</td><td className="ml-st__err">{p.error}</td><td>{when(p.at)}</td></tr>)}</tbody></table>
		</Card>}

		<Card className="ml-st__card ml-st__wide">
			<h2>Our copy and the mail server</h2>
			<p className="ml-st__muted">Wavium’s own copy is the one to trust. Per account, every mail (counted once by Message-ID) is either on the server and in Wavium with its text, on the server with its text not copied yet, or only in Wavium: the server no longer has it and Wavium keeps it (listed in its folder, marked “Only in Wavium”). Mail that only moved on the server is not counted twice. Attachments are not kept.</p>
			{s.copy.map((c) => {
				const a = s.accounts.find((x) => x.id === c.accountId)
				const total = Math.max(1, c.withBody + c.missingBody + c.onlyInAtrium)
				const pct = (n: number) => `${(n / total) * 100}%`
				return <div key={c.accountId} className="ml-st__copy">
					<div className="ml-st__meter"><span>{a?.email ?? c.accountId}</span><span>{c.withBody + (c.keptWithText ?? 0) + (c.orphanTexts ?? 0)} of {c.inList + c.onlyInAtrium} mails with text kept</span></div>
					<div className="ml-st__stack" role="img" aria-label="Mail copy status">
						<span className="ml-st__seg ml-st__seg--have" style={{ width: pct(c.withBody) }} />
						<span className="ml-st__seg ml-st__seg--missing" style={{ width: pct(c.missingBody) }} />
						<span className="ml-st__seg ml-st__seg--only" style={{ width: pct(c.onlyInAtrium) }} />
					</div>
					<ul className="ml-st__legend">
						<li><span className="ml-st__seg ml-st__seg--have" />On the server and in Wavium: <strong>{c.withBody}</strong></li>
						<li><span className="ml-st__seg ml-st__seg--missing" />On the server, text not copied yet: <strong>{c.missingBody}</strong></li>
						<li><span className="ml-st__seg ml-st__seg--only" />Only in Wavium (gone from the server): <strong>{c.onlyInAtrium}</strong>{c.onlyInAtrium > 0 && <small className="ml-st__muted"> · {c.keptRows ?? 0} kept in the list ({c.keptWithText ?? 0} with text){(c.orphanTexts ?? 0) > 0 && `, ${c.orphanTexts} text only (removed before Wavium kept list rows)`}</small>}</li>
					</ul>
				</div>
			})}
		</Card>

		<Card className="ml-st__card ml-st__wide">
			<h2>Folders</h2>
			<p className="ml-st__muted">Per folder: what the mail server has, what Wavium’s list holds, and how many mails Wavium has a full copy of (body text, never attachments) and has classified. “Of” counts the mails queued for classification (Inbox and Spam).</p>
			<table className="ml-st__table"><thead><tr><th>Folder</th><th>On server</th><th>In Wavium (list)</th><th>Body stored</th><th>Classified</th><th>Previews ready</th><th>State</th></tr></thead>
				<tbody>{s.folders.map((f) => {
					const account = s.accounts.find((a) => a.id === f.accountId)
					return <tr key={f.id}><td>{f.name}{s.accounts.length > 1 && <small className="ml-st__muted"> · {account?.email}</small>}</td><td>{f.serverMessages}</td><td>{f.cached ? f.stored : '–'}{f.kept > 0 && <small className="ml-st__muted" title="Kept in Wavium after the server stopped holding them"> ({f.kept} only in Wavium)</small>}</td><td>{f.queued ? `${f.bodies} of ${f.queued}` : "–"}</td><td>{f.queued ? `${f.classified} of ${f.queued}` : "–"}</td>
						<td>{f.stored ? `${Math.round((f.previews / f.stored) * 100)}%` : '–'}</td><td>{f.syncing ? 'Syncing' : f.cached ? 'Synced' : 'Not synced yet (opens on first visit)'}</td></tr>
				})}</tbody></table>
		</Card>

		<Card className="ml-st__card ml-st__wide">
			<h2>Background jobs</h2>
			<table className="ml-st__table"><thead><tr><th>Job</th><th>Account</th><th>Last run</th><th>Took</th></tr></thead>
				<tbody>{s.jobs.map((j, i) => <tr key={i}><td>{jobLabels[j.name] ?? j.name}{j.running && ' (running)'}</td><td>{j.accountId === null ? '–' : s.accounts.find((a) => a.id === j.accountId)?.email ?? j.accountId}</td>
					<td>{when(j.lastRun || null)}</td><td>{j.duration ? `${j.duration}s` : '–'}</td></tr>)}</tbody></table>
		</Card>
	</div>
}

/** Which categories the Curated view shows. Agents with wakes on are woken only by these. */
function CuratedCard({ onChange }: { onChange?: (hides: string[]) => void }) {
	const [hides, setHides] = useState<string[] | null>(null)
	const [busy, setBusy] = useState(false)
	useEffect(() => { loadCuratedHides().then(setHides).catch(() => setHides([...DEFAULT_CURATED_HIDES])) }, [])
	const toggle = async (c: string) => {
		if (!hides) return
		const next = hides.includes(c) ? hides.filter((x) => x !== c) : [...hides, c]
		setBusy(true)
		try { await saveCuratedHides(next); setHides(next); onChange?.(next) } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
	}
	return <Card className="ml-st__card ml-st__wide">
		<h2>Curated</h2>
		<p className="ml-st__muted">Categories the Curated view shows. Agents that may wake up are woken only by new mail in these categories.</p>
		{hides ? <div className="ml-st__chips">{filterCategories.map((c) => (
			<button key={c} className={`ml-chip ${hides.includes(c) ? '' : 'ml-chip--on'}`} aria-pressed={!hides.includes(c)} disabled={busy} onClick={() => void toggle(c)}>{categoryLabels[c] ?? c}</button>
		))}</div> : <Spinner />}
	</Card>
}
