// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Share a task list (P4-3): who has it (can edit or read only), add a person
// or a group found by name, change or remove access. CalDAV sharing
// (sharing.ts), so the share also shows on phones and other clients.
import { useCallback, useEffect, useState } from 'react'
import { Button, Dialog, IconButton, Select, Spinner, TextField, toast } from '@atrium/ui'
import type { TaskList } from './api'
import { listSharees, searchSharees, share, type Sharee, unshare } from './sharing'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function ShareDialog({ list, onClose }: { list: TaskList, onClose: () => void }) {
	const [sharees, setSharees] = useState<Sharee[] | null>(null)
	const [q, setQ] = useState('')
	const [found, setFound] = useState<Array<Pick<Sharee, 'kind' | 'id' | 'name'>>>([])
	const [busy, setBusy] = useState(false)
	const load = useCallback(() => { listSharees(list.url).then(setSharees, (e) => { toast.error(`Could not read the shares: ${errText(e)}`); setSharees([]) }) }, [list.url])
	useEffect(load, [load])
	useEffect(() => {
		let gone = false
		const t = setTimeout(() => { searchSharees(q).then((r) => { if (!gone) setFound(r) }, () => { if (!gone) setFound([]) }) }, 250)
		return () => { gone = true; clearTimeout(t) }
	}, [q])

	const run = async (fn: () => Promise<void>, done: string) => {
		setBusy(true)
		try { await fn(); toast(done); load() } catch (e) { toast.error(errText(e)) } finally { setBusy(false) }
	}
	const has = (s: Pick<Sharee, 'kind' | 'id'>) => (sharees ?? []).some((x) => x.kind === s.kind && x.id === s.id)

	return (
		<Dialog open title={`Share "${list.name}"`} onClose={onClose} actions={<Button onClick={onClose}>Done</Button>}>
			<div className="tk-share">
				{sharees === null ? <Spinner /> : sharees.length === 0 ? <p className="at-muted" style={{ margin: 0 }}>Not shared yet.</p> : (
					<ul className="tk-share__list" aria-label="Shared with">
						{sharees.map((s) => (
							<li key={`${s.kind}/${s.id}`} data-sharee={`${s.kind}/${s.id}`}>
								<span className="tk-share__who">{s.name}{s.kind === 'group' && <span className="at-muted"> (group)</span>}</span>
								<Select label="Access" value={s.edit ? 'edit' : 'read'} disabled={busy} onChange={(e) => run(() => share(list.url, { ...s, edit: e.target.value === 'edit' }), 'Access changed')}>
									<option value="read">Can view</option>
									<option value="edit">Can edit</option>
								</Select>
								<IconButton icon="close" label={`Stop sharing with ${s.name}`} disabled={busy} onClick={() => run(() => unshare(list.url, s), `Stopped sharing with ${s.name}`)} />
							</li>
						))}
					</ul>
				)}
				<TextField label="Share with a person or group" value={q} onChange={(e) => setQ(e.target.value)} />
				{found.filter((f) => !has(f)).length > 0 && (
					<ul className="tk-share__found" aria-label="Suggestions">
						{found.filter((f) => !has(f)).map((f) => (
							<li key={`${f.kind}/${f.id}`}>
								<button type="button" disabled={busy} onClick={() => run(async () => { await share(list.url, { ...f, edit: false }); setQ('') }, `Shared with ${f.name}`)}>
									{f.name}{f.kind === 'group' ? ' (group)' : ''}
								</button>
							</li>
						))}
					</ul>
				)}
				<p className="at-muted tk-hint">People you add can view the list; set "Can edit" to let them change it.</p>
			</div>
		</Dialog>
	)
}
