// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Today" card (PLAN P5-1): the daily digest of the Bun agent layer
// (/agent/v1/digest): mail that needs a reply or an action, today's events,
// tasks due and the Daily Todo list, plus the morning AI summary when it is on.
// The settings (morning time, notification, AI summary) are in a dialog.
import { useCallback, useEffect, useState } from 'react'
import { HttpError, linkHandler, request } from '@atrium/sdk'
import { Button, Dialog, IconButton, Spinner, Switch, TextField, toast } from '@atrium/ui'

export interface DigestMail { message_key: string, subject: string, from: string, date: string, urgency: string | null, deadline: boolean, reason: 'reply' | 'action', link?: string | null }
export interface Digest {
	day: string
	timezone: string
	headline: string
	ai_summary: string | null
	mail: DigestMail[]
	events: Array<{ event_id: string, title: string, start: string | null, end: string | null, all_day: boolean, location: string | null }>
	tasks: Array<{ task_id: string, title: string, due: string | null, overdue: boolean }>
	todo: Array<{ item_id: number, title: string, kind: string }>
	/** v4: texts waiting for an answer (older digests have none). */
	texts?: Array<{ conversation_id: string, name: string, text: string, at: string, link: string }>
	counts: { reply: number, action: number, events: number, tasks: number, overdue: number, todo: number, texts?: number, approvals?: number }
	errors: Record<string, string>
}
export interface DigestSettings { enabled: boolean, time: string, notify: boolean, ai: boolean }

async function api<T>(path: string, opts: { method?: string, body?: unknown } = {}): Promise<T> {
	try {
		return await request<T>(`/agent/v1/digest${path}`, { ...opts, headers: { 'OCS-APIRequest': 'true' } })
	} catch (e) {
		if (e instanceof HttpError) throw new Error((e.body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${e.status}`)
		throw e
	}
}

export const digestApi = {
	today: () => api<Digest>(''),
	refresh: () => api<Digest>('/refresh', { method: 'POST' }),
	settings: () => api<DigestSettings>('/settings'),
	save: (s: Partial<DigestSettings>) => api<DigestSettings>('/settings', { method: 'PUT', body: s }),
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function time(iso: string | null, tz: string): string {
	if (!iso || !iso.includes('T')) return ''
	return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: tz })
}

const SOURCE: Record<string, string> = { mail: 'Mail', calendar: 'Calendar', tasks: 'Tasks', todo: 'Daily Todo', messages: 'Messages', agents: 'Agents' }

export function TodayCard() {
	const [d, setD] = useState<Digest | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [settingsOpen, setSettingsOpen] = useState(false)

	const load = useCallback(() => {
		digestApi.today().then((x) => { setD(x); setError(null) }, (e) => setError(errText(e)))
	}, [])
	useEffect(() => { load() }, [load])

	async function refresh() {
		setBusy(true)
		try { setD(await digestApi.refresh()) } catch (e) { toast.error(`Could not refresh: ${errText(e)}`) } finally { setBusy(false) }
	}

	const failed = d ? Object.keys(d.errors) : []
	return (
		<section className="dash-card dash-today" aria-label="Today">
			<h2>
				<span className="dash-today__title">Today</span>
				<IconButton icon="refresh" label="Refresh" disabled={busy} onClick={() => void refresh()} />
				<IconButton icon="settings" label="Digest settings" onClick={() => setSettingsOpen(true)} />
			</h2>
			{!d && !error && <div className="dash-loading"><Spinner small /></div>}
			{error && <p className="dash-empty">Could not load today’s digest: {error}</p>}
			{d && (
				<>
					{d.ai_summary && <p className="dash-today__ai">{d.ai_summary}</p>}
					<p className="dash-today__headline">{d.headline}</p>
					{(d.counts.approvals ?? 0) > 0 && <p className="dash-today__waiting"><a href="/settings/user/agent-activity" onClick={linkHandler}>{d.counts.approvals} agent request{d.counts.approvals === 1 ? '' : 's'} wait{d.counts.approvals === 1 ? 's' : ''} for your OK ›</a></p>}
					<div className="dash-today__cols">
						{d.mail.length > 0 && (
							<div>
								<h3>Mail</h3>
								<ul className="dash-today__list">
									{d.mail.map((m) => (
										<li key={m.message_key}>
											<a href={m.link ?? '/apps/mail/'} onClick={linkHandler}>
												<span className={`dash-today__tag dash-today__tag--${m.reason}`}>{m.reason === 'reply' ? 'Reply' : 'Act'}</span>
												<span className="dash-today__what"><strong>{m.from}</strong> {m.subject}</span>
												{(m.urgency === 'now' || m.urgency === 'today') && <span className="dash-today__urgent">{m.urgency === 'now' ? 'now' : 'today'}</span>}
											</a>
										</li>
									))}
								</ul>
							</div>
						)}
						{(d.texts?.length ?? 0) > 0 && (
							<div>
								<h3>Texts</h3>
								<ul className="dash-today__list">
									{d.texts!.map((t) => (
										<li key={t.conversation_id}>
											<a href={t.link} onClick={linkHandler}>
												<span className="dash-today__tag dash-today__tag--reply">Reply</span>
												<span className="dash-today__what"><strong>{t.name}</strong> {t.text}</span>
											</a>
										</li>
									))}
								</ul>
							</div>
						)}
						{(d.events.length > 0 || d.tasks.length > 0 || d.todo.length > 0) && (
							<div>
								{d.events.length > 0 && (
									<>
										<h3>Calendar</h3>
										<ul className="dash-today__list">
											{d.events.map((e) => (
												<li key={e.event_id}><a href="/apps/calendar/" onClick={linkHandler}>
													<span className="dash-today__time">{e.all_day ? 'All day' : time(e.start, d.timezone)}</span>
													<span className="dash-today__what">{e.title}{e.location && <small> · {e.location}</small>}</span>
												</a></li>
											))}
										</ul>
									</>
								)}
								{d.tasks.length > 0 && (
									<>
										<h3>Tasks</h3>
										<ul className="dash-today__list">
											{d.tasks.map((t) => (
												<li key={t.task_id}><a href="/apps/tasks/" onClick={linkHandler}>
													<span className="dash-today__what">{t.title}</span>
													{t.overdue && <span className="dash-today__urgent">overdue</span>}
												</a></li>
											))}
										</ul>
									</>
								)}
								{d.todo.length > 0 && (
									<>
										<h3>Today’s list</h3>
										<ul className="dash-today__list">
											{d.todo.map((t) => <li key={t.item_id}><a href="/apps/daily_todo/" onClick={linkHandler}><span className="dash-today__what">{t.title}</span></a></li>)}
										</ul>
									</>
								)}
							</div>
						)}
					</div>
					{failed.length > 0 && <p className="dash-empty dash-empty--small">Left out: {failed.map((k) => SOURCE[k] ?? k).join(', ')} could not be read.</p>}
				</>
			)}
			<DigestSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
		</section>
	)
}

function DigestSettingsDialog({ open, onClose }: { open: boolean, onClose: () => void }) {
	const [s, setS] = useState<DigestSettings | null>(null)
	const [busy, setBusy] = useState(false)
	useEffect(() => {
		if (open) digestApi.settings().then(setS, (e) => toast.error(errText(e)))
	}, [open])

	async function save(patch: Partial<DigestSettings>) {
		setBusy(true)
		try { setS(await digestApi.save(patch)) } catch (e) { toast.error(`Could not save: ${errText(e)}`) } finally { setBusy(false) }
	}

	return (
		<Dialog open={open} title="Morning digest" onClose={onClose} actions={<Button variant="text" onClick={onClose}>Done</Button>}>
			{!s ? <div className="dash-loading"><Spinner small /></div> : (
				<div className="dash-today__settings">
					<Switch label="Prepare it every morning" checked={s.enabled} disabled={busy} onChange={(e) => void save({ enabled: e.target.checked })} />
					<TextField label="At" type="time" value={s.time} disabled={busy || !s.enabled} onChange={(e) => { if (/^\d\d:\d\d$/.test(e.target.value)) void save({ time: e.target.value }) }} />
					<Switch label="Send it as a notification (ntfy)" checked={s.notify} disabled={busy || !s.enabled} onChange={(e) => void save({ notify: e.target.checked })} />
					<Switch label="Add a short AI summary (uses your AI budget)" checked={s.ai} disabled={busy} onChange={(e) => void save({ ai: e.target.checked })} />
					<p className="dash-empty dash-empty--small">The card is always up to date. The morning digest is kept for the day; the AI summary is written then, or when you press refresh.</p>
				</div>
			)}
		</Dialog>
	)
}
