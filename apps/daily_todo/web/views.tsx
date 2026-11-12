// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Daily Todo secondary pages: month calendar (navigation), Template, Postponed,
// Stats, Settings.
import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Checkbox, Chip, EmptyState, Icon, IconButton, Select, Spinner, Switch, TextArea, TextField, confirmDialog, toast } from '@atrium/ui'
import { summarise, WEEKDAYS } from '../src/stats'
import { api, dateKeyOf, errorText, separatorKind, shortDay, type Counts, type Settings, type Share, type Sources, type TemplateRow, type TrashEntry } from './api'

// ------------------------------------------------------------------ calendar

/** Month grid. A day is grey exactly when it was not created (not in the summary). */
export function MonthCalendar({ value, owner, version, onPick }: { value: Date, owner: string | null, version: number, onPick: (d: Date) => void }) {
	const [month, setMonth] = useState(new Date(value.getFullYear(), value.getMonth(), 1))
	const [summary, setSummary] = useState<Counts>({})
	useEffect(() => { setMonth(new Date(value.getFullYear(), value.getMonth(), 1)) }, [value.getFullYear(), value.getMonth()])
	const monthKey = dateKeyOf(month).slice(0, 7)
	useEffect(() => {
		let live = true
		api.summary(monthKey, owner).then((s) => live && setSummary(s), () => live && setSummary({}))
		return () => { live = false }
	}, [monthKey, owner, version])
	const first = (month.getDay() + 6) % 7
	const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
	const today = dateKeyOf(new Date())
	const selected = dateKeyOf(value)
	const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)]
	return (
		<div className="dt-cal">
			<div className="dt-cal__head">
				<IconButton icon="chevronLeft" label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} />
				<span>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
				<IconButton icon="chevronRight" label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} />
			</div>
			<div className="dt-cal__grid">
				{WEEKDAYS.map((d) => <span key={d} className="dt-cal__wd">{d.slice(0, 2)}</span>)}
				{cells.map((n, i) => {
					if (n === null) return <span key={'e' + i} />
					const key = `${monthKey}-${String(n).padStart(2, '0')}`
					const s = summary[key]
					const cls = ['dt-cal__day', !s && 'dt-cal__day--empty', key === today && 'dt-cal__day--today', key === selected && 'dt-cal__day--sel', s && s.total > 0 && s.done === s.total && 'dt-cal__day--full'].filter(Boolean).join(' ')
					return (
						<button key={key} type="button" className={cls} title={s ? `${s.done}/${s.total}` : 'Not created'} onClick={() => onPick(new Date(month.getFullYear(), month.getMonth(), n))}>
							{n}
							{s && s.total > 0 && <span className="dt-cal__bar" style={{ width: `${Math.round(s.done / s.total * 100)}%` }} />}
						</button>
					)
				})}
			</div>
		</div>
	)
}

// ------------------------------------------------------------------ template

const PLACEHOLDER = '__DAY_ITEMS__'
const SUB = '↳ '
type Row = TemplateRow & { key: number }
let nextKey = 0
const withKey = (r: TemplateRow): Row => ({ ...r, key: nextKey++ })
const isSub = (r: Row) => /^\s*↳/.test(r.title)
const label = (r: Row) => r.title.replace(/^\s*↳\s*/, '')

export function TemplateView() {
	const [rows, setRows] = useState<Row[] | null>(null)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState('')
	useEffect(() => { api.template().then((r) => setRows(r.map(withKey)), (e) => setError(errorText(e))) }, [])
	if (!rows) return <div className="dt-page">{error ? <div className="dt-note dt-note--error">{error}</div> : <div className="dt-loading"><Spinner /></div>}</div>

	const update = (next: Row[]) => setRows([...next])
	const block = (i: number): [number, number] => {
		const r = rows[i]
		if (isSub(r) || r.title === PLACEHOLDER) return [i, i + 1]
		let end = i + 1
		while (end < rows.length && isSub(rows[end]) && rows[end].title !== PLACEHOLDER) end++
		return [i, end]
	}
	const canMove = (i: number, d: -1 | 1) => d < 0 ? i > 0 : block(i)[1] < rows.length
	function move(i: number, d: -1 | 1) {
		if (!canMove(i, d)) return
		const next = [...rows!]
		const [start, end] = block(i)
		if (d < 0) {
			let target = start - 1
			if (!isSub(next[start])) while (target > 0 && isSub(next[target])) target--
			const moved = next.splice(start, end - start)
			next.splice(target, 0, ...moved)
		} else {
			const nextEnd = block(end)[1]
			const moved = next.splice(start, end - start)
			next.splice(nextEnd - moved.length, 0, ...moved)
		}
		update(next)
	}
	function insert(title: string) {
		const at = rows!.findIndex((r) => r.title === PLACEHOLDER)
		const next = [...rows!]
		next.splice(at < 0 ? next.length : at, 0, withKey({ title }))
		update(next)
	}
	async function save() {
		setSaving(true)
		setError('')
		try {
			const payload = rows!.filter((r) => r.title === PLACEHOLDER || label(r).trim()).map(({ id, title }) => ({ id, title }))
			setRows((await api.saveTemplate(payload)).map(withKey))
			toast('Template saved. New days use it; today keeps its order until you regenerate it in Settings.')
		} catch (e) { setError(errorText(e)) }
		setSaving(false)
	}
	return (
		<div className="dt-page">
			<header className="dt-head">
				<div>
					<h1 className="dt-title">Template</h1>
					<p className="dt-sub">Rows above "Day items" are morning, rows below are evening. A row named <code>---</code> is a divider and <code>&lt;br&gt;</code> a blank gap.</p>
				</div>
				<Button icon="check" busy={saving} onClick={save}>Save changes</Button>
			</header>
			{error && <div className="dt-note dt-note--error">{error}</div>}
			<Card className="dt-tpl">
				{rows.map((r, i) => (
					<div key={r.key} className={'dt-tpl__row' + (r.title === PLACEHOLDER ? ' dt-tpl__row--slot' : '') + (isSub(r) ? ' dt-tpl__row--sub' : '')}>
						{r.title === PLACEHOLDER ? <strong className="dt-tpl__slot"><Icon name="today" />Day items (tasks and events)</strong>
							: separatorKind(label(r)) ? <span className="dt-tpl__div">{separatorKind(label(r)) === 'rule' ? <hr /> : '(blank gap)'}</span>
								: <input className="dt-tpl__input" value={label(r)} aria-label="Routine item" placeholder="Routine item"
									onChange={(e) => { r.title = (isSub(r) ? SUB : '') + e.target.value; update(rows) }} />}
						<IconButton icon="arrowUp" label="Move up" disabled={!canMove(i, -1)} onClick={() => move(i, -1)} />
						<IconButton icon="arrowDown" label="Move down" disabled={!canMove(i, 1)} onClick={() => move(i, 1)} />
						{r.title !== PLACEHOLDER && !separatorKind(label(r)) && <IconButton icon={isSub(r) ? 'indentLess' : 'indentMore'} label={isSub(r) ? 'Make top-level item' : 'Make sub-item of the row above'} onClick={() => { r.title = isSub(r) ? label(r) : SUB + label(r); update(rows) }} />}
						{r.title !== PLACEHOLDER && separatorKind(label(r)) && <span className="dt-tpl__gap" aria-hidden="true" />}
						{r.title !== PLACEHOLDER && <IconButton icon="delete" label="Remove" onClick={() => update(rows.filter((x) => x !== r))} />}
					</div>
				))}
			</Card>
			<div className="dt-buttons">
				<Button variant="tonal" icon="add" onClick={() => insert('')}>Add routine</Button>
				<Button variant="text" onClick={() => insert('---')}>Add divider</Button>
			</div>
		</div>
	)
}

// ------------------------------------------------------------------ postponed

export function PostponedView({ onChanged }: { onChanged: () => void }) {
	const [entries, setEntries] = useState<TrashEntry[] | null>(null)
	const [error, setError] = useState('')
	const [busy, setBusy] = useState<number | null>(null)
	const load = () => api.trash().then(setEntries, (e) => { setError(errorText(e)); setEntries([]) })
	useEffect(() => { void load() }, [])
	async function bringBack(e: TrashEntry) {
		setBusy(e.id)
		try {
			await api.restore(e.id, true)
			toast(`"${e.title}" is back on today's list.`)
			onChanged()
		} catch (err) { setError(errorText(err)) }
		setBusy(null)
		await load()
	}
	const inDays = (key: string | null) => {
		if (!key) return ''
		const t = new Date()
		const n = Math.round((new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))).getTime() - new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()) / 86_400_000)
		return n <= 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`
	}
	const subs = (e: TrashEntry) => e.count > 1 ? ` · with ${e.count - 1} subtask${e.count === 2 ? '' : 's'}` : ''
	const postponed = (entries ?? []).filter((e) => e.kind === 'postponed').sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''))
	const deleted = (entries ?? []).filter((e) => e.kind === 'deleted')
	return (
		<div className="dt-page">
			<header className="dt-head"><div><h1 className="dt-title">Postponed</h1><p className="dt-sub">What waits for its day, and what you deleted this week.</p></div></header>
			{error && <div className="dt-note dt-note--error">{error}</div>}
			{!entries ? <div className="dt-loading"><Spinner /></div> : !entries.length ? (
				<EmptyState icon="schedule" title="Nothing postponed">Postponed and deleted items show up here for a week.</EmptyState>
			) : <>
				{postponed.length > 0 && <section><h2 className="dt-h2">Coming back</h2><Card className="dt-trash">{postponed.map((e) => (
					<div key={e.id} className="dt-trash__row">
						<div><strong>{e.title}</strong><small>{e.due ? `${shortDay(e.due)} · ${inDays(e.due)}` : ''}{subs(e)}</small></div>
						<Button variant="tonal" busy={busy === e.id} onClick={() => void bringBack(e)}>Show today</Button>
					</div>
				))}</Card></section>}
				{deleted.length > 0 && <section><h2 className="dt-h2">Deleted</h2><Card className="dt-trash">{deleted.map((e) => (
					<div key={e.id} className="dt-trash__row">
						<div><strong>{e.title}</strong><small>Deleted {new Date(e.created_at * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{subs(e)}</small></div>
						<Button variant="text" busy={busy === e.id} onClick={() => void bringBack(e)}>Restore to today</Button>
					</div>
				))}</Card></section>}
			</>}
		</div>
	)
}

// ------------------------------------------------------------------ stats

const RANGES = [{ id: 'week', label: '7 days', days: 7 }, { id: 'month', label: '30 days', days: 30 }, { id: 'year', label: '12 months', days: 365 }] as const

export function StatsView() {
	const [range, setRange] = useState<typeof RANGES[number]>(RANGES[1])
	const [data, setData] = useState<{ counts: Counts, from: string, to: string } | null>(null)
	const [error, setError] = useState('')
	useEffect(() => {
		let live = true
		const end = new Date()
		const start = new Date()
		start.setDate(end.getDate() - (range.days - 1))
		const from = dateKeyOf(start), to = dateKeyOf(end)
		setData(null)
		api.stats(from, to).then((counts) => live && setData({ counts, from, to }), (e) => live && setError(errorText(e)))
		return () => { live = false }
	}, [range])
	const stats = useMemo(() => data && summarise(data.counts, data.from, data.to), [data])
	const pct = (r: number | null) => r === null ? '–' : `${Math.round(r * 100)}%`
	const best = stats && (() => { const top = Math.max(...stats.weekdays.map((r) => r ?? -1)); return top > 0 ? WEEKDAYS[stats.weekdays.indexOf(top)] : null })()
	return (
		<div className="dt-page">
			<header className="dt-head">
				<div><h1 className="dt-title">Stats</h1><p className="dt-sub">How much of your lists you get done.</p></div>
				<div className="dt-chips">{RANGES.map((r) => <Chip key={r.id} selected={r.id === range.id} onClick={() => setRange(r)}>{r.label}</Chip>)}</div>
			</header>
			{error && <div className="dt-note dt-note--error">{error}</div>}
			{!stats ? <div className="dt-loading"><Spinner /></div> : !stats.recorded ? (
				<EmptyState icon="barChart" title="Nothing recorded yet">Days are recorded as you use the list. Come back after a few days.</EmptyState>
			) : <>
				<div className="dt-tiles">
					<Card className="dt-tile"><strong>{pct(stats.rate)}</strong><span>done</span></Card>
					<Card className="dt-tile"><strong>{stats.done}<small>/{stats.total}</small></strong><span>items ticked</span></Card>
					<Card className="dt-tile"><strong>{stats.complete}<small>/{stats.recorded}</small></strong><span>days fully done</span></Card>
					{best && <Card className="dt-tile"><strong>{best}</strong><span>your best weekday</span></Card>}
				</div>
				<Card className="dt-chart">
					<h2 className="dt-h2">{range.id === 'year' ? 'Per month' : 'Per day'}</h2>
					<div className="dt-bars" role="img" aria-label={`Completion over the last ${range.label}`}>
						{stats.buckets.map((b, i) => (
							<div key={i} className="dt-bar" title={b.title}>
								<div className="dt-bar__track">{b.rate !== null && <div className="dt-bar__fill" style={{ height: `${Math.max(b.rate * 100, 3)}%` }} />}</div>
								<span>{stats.buckets.length <= 14 || i % 5 === 0 || range.id === 'year' ? b.label : ''}</span>
							</div>
						))}
					</div>
				</Card>
				<Card className="dt-chart">
					<h2 className="dt-h2">By weekday</h2>
					<div className="dt-bars" role="img" aria-label="Average completion per weekday">
						{stats.weekdays.map((r, i) => (
							<div key={i} className="dt-bar" title={`${WEEKDAYS[i]}: ${pct(r)}`}>
								<div className="dt-bar__track">{r !== null && <div className="dt-bar__fill" style={{ height: `${Math.max(r * 100, 3)}%` }} />}</div>
								<span>{WEEKDAYS[i]}</span>
							</div>
						))}
					</div>
				</Card>
			</>}
		</div>
	)
}

// ------------------------------------------------------------------ settings

const ROLLOVER = [{ id: 'quick_only', label: 'Quick items only' }, { id: 'all', label: 'Quick items and tasks' }, { id: 'none', label: 'Do not roll forward' }] as const

export function SettingsView() {
	const [s, setS] = useState<Settings | null>(null)
	const [sources, setSources] = useState<Sources>({ tasks: [], calendars: [] })
	const [shares, setShares] = useState<Share[]>([])
	const [today, setToday] = useState('')
	const [error, setError] = useState('')
	const [saving, setSaving] = useState(false)
	const [shareType, setShareType] = useState<Share['share_type']>('user')
	const [shareWith, setShareWith] = useState('')
	// Public status titles, one per line; split into publicItems on save.
	const [publicText, setPublicText] = useState('')
	useEffect(() => {
		Promise.all([api.settings(), api.sources(), api.day(dateKeyOf(new Date()), null), api.shares()]).then(([a, b, c, d]) => {
			setS(a); setPublicText((a.publicItems ?? []).join('\n')); setSources(b); setToday(c.logicalToday); setShares(d)
		}, (e) => setError(errorText(e)))
	}, [])
	if (!s) return <div className="dt-page">{error ? <div className="dt-note dt-note--error">{error}</div> : <div className="dt-loading"><Spinner /></div>}</div>
	const toggle = (kind: 'taskLists' | 'calendars', id: string) => setS({ ...s, [kind]: s[kind].includes(id) ? s[kind].filter((x) => x !== id) : [...s[kind], id] })
	async function save() {
		setSaving(true); setError('')
		try {
			const saved = await api.saveSettings({ ...s!, publicItems: publicText.split('\n').map((t) => t.trim()).filter(Boolean) })
			setS(saved); setPublicText((saved.publicItems ?? []).join('\n')); toast('Settings saved.')
		} catch (e) { setError(errorText(e)) }
		setSaving(false)
	}
	const publicUrl = `${window.location.origin}/apps/daily_todo/public/${encodeURIComponent(s.owner)}/status`
	async function addShare(e: React.FormEvent) {
		e.preventDefault()
		if (!shareWith.trim()) return
		try { await api.addShare(shareType, shareWith.trim()); setShareWith(''); setShares(await api.shares()) } catch (err) { setError(errorText(err)) }
	}
	async function regenerate() {
		if (!await confirmDialog('Rebuild today from the template? Routine items are recreated; your own items, tasks and events stay.', { title: 'Regenerate today', confirm: 'Regenerate' })) return
		try { await api.reset(today); toast('Today was regenerated.') } catch (e) { setError(errorText(e)) }
	}
	return (
		<div className="dt-page">
			<header className="dt-head">
				<div><h1 className="dt-title">Settings</h1><p className="dt-sub">How your list is built every day.</p></div>
				<Button icon="check" busy={saving} onClick={save}>Save changes</Button>
			</header>
			{error && <div className="dt-note dt-note--error">{error}</div>}
			<Card className="dt-set">
				<h2 className="dt-h2">Day boundary</h2>
				<p className="at-muted">Before this local hour, Today is the preceding date.</p>
				<div className="dt-set__fields">
					<TextField label="Time zone" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} />
					<TextField label="Rollover hour" type="number" min={0} max={23} value={String(s.rolloverHour)} onChange={(e) => setS({ ...s, rolloverHour: Number(e.target.value) })} />
					<Select label="Unfinished items" value={s.rolloverMode} onChange={(e) => setS({ ...s, rolloverMode: e.target.value as Settings['rolloverMode'] })}>
						{ROLLOVER.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
					</Select>
				</div>
			</Card>
			<Card className="dt-set">
				<h2 className="dt-h2">Subtasks</h2>
				<p className="at-muted">By default every subtask is ticked on its own. Un-ticking never changes the subtasks.</p>
				<Switch label="Ticking a task also ticks its subtasks" checked={s.completeSubtasks} onChange={(e) => setS({ ...s, completeSubtasks: e.target.checked })} />
			</Card>
			<div className="dt-set__two">
				<Card className="dt-set">
					<h2 className="dt-h2">Task lists</h2>
					<p className="at-muted">New lists stay off until selected.</p>
					{sources.tasks.length ? sources.tasks.map((x) => <Checkbox key={x.id} label={x.name} checked={s.taskLists.includes(x.id)} onChange={() => toggle('taskLists', x.id)} />) : <p className="at-muted">No task lists.</p>}
				</Card>
				<Card className="dt-set">
					<h2 className="dt-h2">Calendars</h2>
					<p className="at-muted">Only selected calendars appear.</p>
					{sources.calendars.length ? sources.calendars.map((x) => <Checkbox key={x.id} label={x.name} checked={s.calendars.includes(x.id)} onChange={() => toggle('calendars', x.id)} />) : <p className="at-muted">No calendars.</p>}
				</Card>
			</div>
			<Card className="dt-set">
				<h2 className="dt-h2">Public status</h2>
				<p className="at-muted">Items named here (one per line, as they appear on your list) get a public, read-only yes/no: anyone with the link sees whether they are all ticked today, nothing else, and nothing can be changed through it. Leave empty to turn it off. Saved with Save changes.</p>
				<TextArea label="Public items" rows={3} value={publicText} onChange={(e) => setPublicText(e.target.value)} />
				{publicText.trim() && <p className="at-muted"><code>{publicUrl}</code></p>}
			</Card>
			<Card className="dt-set">
				<h2 className="dt-h2">Sharing</h2>
				<p className="at-muted">People you share your list with can see and edit it (tick, add, rename, remove), including the tasks and events on it. They cannot change your template, settings or sharing. Applied at once.</p>
				{shares.map((sh) => (
					<div key={sh.id} className="dt-share">
						<Icon name={sh.share_type === 'group' ? 'group' : 'person'} />
						<span>{sh.display_name} <small className="at-muted">{sh.share_type === 'group' ? 'Group' : sh.share_with}</small></span>
						<IconButton icon="delete" label={`Stop sharing with ${sh.display_name}`} onClick={() => { void api.deleteShare(sh.id).then(() => api.shares()).then(setShares, (e) => setError(errorText(e))) }} />
					</div>
				))}
				<form className="dt-share__add" onSubmit={addShare}>
					<Select label="Share with" value={shareType} onChange={(e) => setShareType(e.target.value as Share['share_type'])}>
						<option value="user">A person</option><option value="group">A group</option>
					</Select>
					<TextField label={shareType === 'user' ? 'Account name' : 'Group name'} value={shareWith} onChange={(e) => setShareWith(e.target.value)} />
					<Button type="submit" variant="tonal" icon="share" disabled={!shareWith.trim()}>Share</Button>
				</form>
			</Card>
			<Card className="dt-set">
				<h2 className="dt-h2">Today</h2>
				<p className="at-muted">Rebuild today ({today && shortDay(today)}) from the template, for example after changing it.</p>
				<Button variant="tonal" icon="refresh" onClick={regenerate}>Regenerate current day</Button>
			</Card>
		</div>
	)
}
