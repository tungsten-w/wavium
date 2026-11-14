// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Your data (v4): where each kind of data is stored on this machine
// (the Bun agent layer's GET /agent/v1/storage), and "is it safe?" next to the
// tools people use instead.
import { useEffect, useState } from 'react'
import { HttpError, request, type Session } from '@atrium/sdk'
import { Card, Icon, IconButton, Spinner, toast } from '@atrium/ui'
import { CRITERIA, markLabel, tally, TOOLS, VERDICT, type Mark } from './safety'

interface HostPlace { kind: 'path' | 'volume' | 'container', path: string, volume?: string, hint?: string }
interface StorageItem { id: string, label: string, what: string, where: 'disk' | 'database', container?: string, host?: HostPlace, tables?: string[], bytes?: number, partial?: boolean }
export interface StorageReport { uid: string, items: StorageItem[], database: { type: string, name: string, host?: HostPlace }, notes: string[] }

export const loadStorage = async (): Promise<StorageReport> => {
	try {
		return await request<StorageReport>('/agent/v1/storage')
	} catch (e) {
		if (e instanceof HttpError) throw new Error((e.body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${e.status}`)
		throw e
	}
}

const icons: Record<string, string> = { files: 'folder', versions: 'clock', trash: 'trash', mail: 'mail', calendar: 'calendar', contacts: 'address-book', todo: 'list-check', agents: 'robot' }

export function size(bytes: number | undefined, partial?: boolean): string {
	if (bytes === undefined) return ''
	const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
	let v = bytes, i = 0
	while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
	return `${partial ? 'at least ' : ''}${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

function copy(text: string) {
	navigator.clipboard?.writeText(text).then(() => toast('Path copied'), () => toast.error('Could not copy'))
}

function PathLine({ label, path, hint }: { label: string, path: string, hint?: string }) {
	return <div className="data-path">
		<span className="data-path__label">{label}</span>
		<code title={hint}>{path}</code>
		<IconButton icon="copy" label={`Copy the ${label.toLowerCase()} path`} onClick={() => copy(path)} />
	</div>
}

export function YourData(_: { session: Session }) {
	const [r, setR] = useState<StorageReport | null>(null)
	const [err, setErr] = useState<string | null>(null)
	useEffect(() => { loadStorage().then(setR, (e: Error) => setErr(e.message)) }, [])
	const disk = r?.items.filter((i) => i.where === 'disk') ?? []
	const db = r?.items.filter((i) => i.where === 'database') ?? []

	return <div className="settings-section settings-section--wide data">
		<h2>Your data</h2>
		<p className="at-muted">Wavium runs on your own machine. Here is where each kind of your data is kept, and what that means for its safety.</p>

		<div className="settings-block">
			<h3>Where it is stored</h3>
			{err && <p className="settings-bad">Could not read the storage places: {err}</p>}
			{!r && !err && <div className="settings-center"><Spinner /></div>}
			{r && <>
				<p className="at-muted data-intro">Two places hold everything: <strong>a folder of files</strong> on disk, and <strong>a {r.database.type} database</strong>. “On this machine” is where to look on the computer that runs Wavium; “in Wavium” is the same place as the server sees it.</p>
				<div className="data-grid">
					{disk.map((i, n) => <Card key={i.id} variant="outlined" className="data-card" style={{ animationDelay: `${n * 60}ms` }}>
						<div className="data-card__head"><span className="data-card__icon"><Icon name={icons[i.id] ?? 'folder'} /></span><strong>{i.label}</strong>{i.bytes !== undefined && <span className="data-card__size">{size(i.bytes, i.partial)}</span>}</div>
						<p>{i.what}</p>
						{i.host && <PathLine label="On this machine" path={i.host.path} hint={i.host.hint} />}
						{i.container && <PathLine label="In Wavium" path={i.container} />}
					</Card>)}
				</div>
				<Card variant="outlined" className="data-card data-card--db" style={{ animationDelay: `${disk.length * 60}ms` }}>
					<div className="data-card__head"><span className="data-card__icon"><Icon name="database" /></span><strong>Database: {r.database.type} “{r.database.name}”</strong></div>
					{r.database.host && <PathLine label="On this machine" path={r.database.host.path} hint={r.database.host.hint} />}
					{r.database.host?.volume && <p className="at-muted data-small">Docker volume <code>{r.database.host.volume}</code>. Open it with <code>docker volume inspect {r.database.host.volume}</code>.</p>}
					<ul className="data-tables">{db.map((i) => <li key={i.id}>
						<span className="data-card__icon data-card__icon--s"><Icon name={icons[i.id] ?? 'database'} /></span>
						<div><strong>{i.label}</strong><p>{i.what}</p>{i.tables && <small className="at-muted">Tables: {i.tables.map((t, k) => <code key={t}>{k ? ', ' : ''}{t}</code>)}</small>}</div>
					</li>)}</ul>
				</Card>
				<ul className="data-notes">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul>
			</>}
		</div>

		<SafetyChart />
	</div>
}

const markIcon: Record<Mark, string> = { yes: 'check', partly: 'warning', no: 'x' }

export function SafetyChart() {
	const [open, setOpen] = useState<string | null>(null)
	return <div className="settings-block safety">
		<h3>Is Wavium safe to install?</h3>
		<p className="at-muted">Wavium next to the tools people use instead, on what decides whether your data is safe. Hover or tap a mark for the details.</p>
		<ul className="safety__legend" aria-label="Legend">{(['yes', 'partly', 'no'] as Mark[]).map((m) => <li key={m}><span className={`safety__mark safety__mark--${m}`}><Icon name={markIcon[m]} /></span>{markLabel[m]}</li>)}</ul>
		<div className="safety__scroll">
			<table className="safety__table">
				<thead><tr><th scope="col"><span className="at-sr-only">Question</span></th>{TOOLS.map((t) => {
					const n = tally(t.id)
					return <th key={t.id} scope="col" className={t.id === 'wavium' ? 'safety__us' : undefined}>
						<span className="safety__tool">{t.name}</span><small>{t.kind}</small>
						<span className="safety__bar" aria-label={`${n.yes} yes, ${n.partly} partly, ${n.no} no`}>
							<span className="safety__seg safety__seg--yes" style={{ flexGrow: n.yes }} /><span className="safety__seg safety__seg--partly" style={{ flexGrow: n.partly }} /><span className="safety__seg safety__seg--no" style={{ flexGrow: n.no }} />
						</span>
					</th>
				})}</tr></thead>
				<tbody>{CRITERIA.map((c, row) => <tr key={c.id} style={{ animationDelay: `${row * 50}ms` }}>
					<th scope="row"><span>{c.question}</span><small>{c.why}</small></th>
					{TOOLS.map((t) => {
						const [m, note] = c.marks[t.id]
						const id = `${c.id}:${t.id}`
						return <td key={t.id} className={t.id === 'wavium' ? 'safety__us' : undefined}>
							<button className={`safety__mark safety__mark--${m}`} aria-label={`${t.name}: ${markLabel[m]}. ${note}`} aria-expanded={open === id}
								onClick={() => setOpen(open === id ? null : id)} onMouseEnter={() => setOpen(id)} onMouseLeave={() => setOpen((o) => o === id ? null : o)}>
								<Icon name={markIcon[m]} />
							</button>
							<span className={`safety__note${open === id ? ' safety__note--open' : ''}`}>{note}</span>
						</td>
					})}
				</tr>)}</tbody>
			</table>
		</div>
		<Card className="safety__verdict">
			<div className="data-card__head"><span className="data-card__icon"><Icon name="shield-check" /></span><strong>{VERDICT.title}</strong></div>
			<ul>{VERDICT.points.map((p) => <li key={p}>{p}</li>)}</ul>
		</Card>
	</div>
}
