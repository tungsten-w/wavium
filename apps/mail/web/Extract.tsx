// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mail -> calendar and tasks (PLAN P5-7): the user's AI proposes the events
// and deadlines it finds in the mail; each one is created only on its own click.
import { useEffect, useState } from 'react'
import { HttpError, request } from '@atrium/sdk'
import { Button, Dialog, Icon, Spinner } from '@atrium/ui'

export interface EventProposal { title: string, start: string, end: string, all_day: boolean, location: string | null }
export interface TaskProposal { title: string, due: string | null }
interface Proposals { events: EventProposal[], tasks: TaskProposal[], source: { message_key: string, subject: string } }

async function api<T>(path: string, body: unknown): Promise<T> {
	try {
		return await request<T>(`/agent/v1/extract${path}`, { method: 'POST', body, headers: { 'OCS-APIRequest': 'true' } })
	} catch (e) {
		if (e instanceof HttpError) throw new Error((e.body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${e.status}`)
		throw e
	}
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function when(e: EventProposal): string {
	if (e.all_day) return new Date(`${e.start}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
	const s = new Date(e.start)
	return `${s.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}, ${s.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}–${new Date(e.end).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}
const due = (d: string | null) => (!d ? 'no date' : d.length === 10 ? `by ${new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}` : `by ${new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`)

export function ExtractDialog({ dbId, open, onClose }: { dbId: number, open: boolean, onClose: () => void }) {
	const [data, setData] = useState<Proposals | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [done, setDone] = useState<Record<string, 'busy' | 'ok' | string>>({})
	useEffect(() => {
		if (!open) return
		setData(null); setError(null); setDone({})
		api<Proposals>('', { db_id: dbId }).then(setData, (e) => setError(errText(e)))
	}, [open, dbId])

	async function add(key: string, kind: 'event' | 'task', item: EventProposal | TaskProposal) {
		setDone((d) => ({ ...d, [key]: 'busy' }))
		try {
			await api('/create', { kind, item, db_id: dbId })
			setDone((d) => ({ ...d, [key]: 'ok' }))
		} catch (e) {
			setDone((d) => ({ ...d, [key]: errText(e) }))
		}
	}
	const state = (key: string, kind: 'event' | 'task', item: EventProposal | TaskProposal) => {
		const s = done[key]
		if (s === 'ok') return <span className="ml-extract__ok"><Icon name="check" /> Added</span>
		return <>{s && s !== 'busy' && <small className="ml-extract__err">{s}</small>}<Button size="s" variant="tonal" busy={s === 'busy'} onClick={() => void add(key, kind, item)}>{kind === 'event' ? 'Add to calendar' : 'Add task'}</Button></>
	}

	return (
		<Dialog open={open} title="Dates in this mail" onClose={onClose} actions={<Button variant="text" onClick={onClose}>Done</Button>}>
			<div className="ml-extract">
				{!data && !error && <div className="ml-center"><Spinner small /></div>}
				{error && <p className="ml-extract__err">{error}</p>}
				{data && !data.events.length && !data.tasks.length && <p className="ml-st__muted">No appointment or deadline found in this mail.</p>}
				{data && data.events.length > 0 && <><h3>Events</h3><ul>{data.events.map((e, i) => (
					<li key={`e${i}`}><span><strong>{e.title}</strong><small>{when(e)}{e.location ? ` · ${e.location}` : ''}</small></span>{state(`e${i}`, 'event', e)}</li>
				))}</ul></>}
				{data && data.tasks.length > 0 && <><h3>Tasks</h3><ul>{data.tasks.map((t, i) => (
					<li key={`t${i}`}><span><strong>{t.title}</strong><small>{due(t.due)}</small></span>{state(`t${i}`, 'task', t)}</li>
				))}</ul></>}
				{data && <p className="ml-st__muted">Found by your AI: check before adding. Nothing is added without your click.</p>}
			</div>
		</Dialog>
	)
}
