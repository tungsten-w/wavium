// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One day's checklist. Rules (AGENTS.md): one add box, Enter in a title opens a new
// line below, actions live in the row menu, only today's items can be postponed,
// past/future days are read-only, and the day is re-read only when its version changes.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Dialog, EmptyState, Icon, IconButton, Menu, Progress, Select, Spinner, Switch, TextArea, TextField, toast, type MenuEntry } from '@atrium/ui'
import { api, dateKeyOf, errorText, parseKey, separatorKind, shortDay, type Day, type Item, type OverdueTask } from './api'

type Group = { item: Item, children: Item[] }
/** An open "new item" line: next to `target` (same level) or as a subtask of it. */
type Draft = { kind: 'sibling' | 'sub', target: number }

const POLL_MS = 10_000

export function DayView({ date, owner, sharedBy, onDate, onChanged }: { date: Date, owner: string | null, sharedBy?: string, onDate: (d: Date) => void, onChanged: () => void }) {
	const key = dateKeyOf(date)
	const [day, setDay] = useState<Day | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState('')
	const [quick, setQuick] = useState('')
	const [draft, setDraft] = useState<Draft | null>(null)
	const [draftTitle, setDraftTitle] = useState('')
	const [renaming, setRenaming] = useState<number | null>(null)
	const [renameTitle, setRenameTitle] = useState('')
	const [hideDone, setHideDone] = useState(false)
	const [overdue, setOverdue] = useState<OverdueTask[]>([])
	const [showOverdue, setShowOverdue] = useState(false)
	const [editing, setEditing] = useState<number | null>(null)
	const [deleting, setDeleting] = useState<Item | null>(null)
	const [postponing, setPostponing] = useState<Item | null>(null)
	const root = useRef<HTMLDivElement>(null)
	// Live state for the background poll (it must not disturb typing or pending saves).
	const live = useRef({ version: '', saving: 0, busy: false, key, owner })
	live.current.key = key
	live.current.owner = owner
	live.current.busy = renaming !== null || draft !== null || postponing !== null || deleting !== null || editing !== null

	const showError = (e: unknown) => setError(errorText(e))

	const load = useCallback(async (silent = false, background = false) => {
		if (!silent) { setLoading(true); setError('') }
		const k = live.current.key
		try {
			const d = await api.day(k, live.current.owner)
			if (k !== live.current.key) return
			setDay(d)
			live.current.version = d.version
			onChanged()
			if (!live.current.owner && d.editable && d.day === d.logicalToday) {
				api.overdue().then(setOverdue, () => setOverdue([]))
			} else setOverdue([])
		} catch (e) {
			if (!background) showError(e)
		} finally {
			setLoading(false)
		}
	}, [onChanged])

	useEffect(() => {
		setDraft(null)
		setRenaming(null)
		void load()
	}, [key, owner, load])

	// Pick up edits made elsewhere (phone, agents) with the cheap version check.
	useEffect(() => {
		let checking = false
		const check = async () => {
			const s = live.current
			if (document.visibilityState !== 'visible' || checking || s.saving > 0 || s.busy) return
			checking = true
			const k = s.key
			try {
				const { version } = await api.dayVersion(k, s.owner)
				if (version !== s.version && k === live.current.key) await load(true, true)
			} catch { /* try again next time */ } finally { checking = false }
		}
		const t = setInterval(check, POLL_MS)
		const onVis = () => { if (document.visibilityState === 'visible') void check() }
		document.addEventListener('visibilitychange', onVis)
		window.addEventListener('focus', check)
		return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', check) }
	}, [load])

	async function mutate<T>(fn: () => Promise<T>): Promise<T> {
		live.current.saving++
		try { return await fn() } finally { live.current.saving-- }
	}

	const items = day?.items ?? []
	const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
	const checkable = items.filter((i) => !separatorKind(i.title))
	const done = checkable.filter((i) => i.completed).length

	const groups = useMemo<Group[]>(() => {
		const rootOf = (item: Item) => {
			let cur = item
			for (let step = 0; step < items.length; step++) {
				const parent = cur.parent_id === null ? undefined : byId.get(cur.parent_id)
				if (!parent) break
				cur = parent
			}
			return cur
		}
		const shown = (i: Item) => !hideDone || !i.completed
		const out = new Map<number, Group>()
		for (const item of items) {
			const top = rootOf(item)
			const g = out.get(top.id) ?? { item: top, children: [] }
			if (item !== top && shown(item)) g.children.push(item)
			out.set(top.id, g)
		}
		return [...out.values()].filter((g) => separatorKind(g.item.title) || shown(g.item) || g.children.length)
	}, [items, byId, hideDone])

	const depthOf = (item: Item) => {
		let depth = 0
		for (let cur = item; cur.parent_id !== null && depth < 20; depth++) {
			const p = byId.get(cur.parent_id)
			if (!p) break
			cur = p
		}
		return depth
	}

	const editable = !!day?.editable
	const isToday = !!day && day.day === day.logicalToday
	const isQuick = (i: Item) => i.source_type === 'quick' && editable
	const canRename = (i: Item) => editable && i.source_type !== 'event' && !separatorKind(i.title)
	const canPostpone = (i: Item) => editable && isToday && (isQuick(i) || (i.source_type === 'task' && i.parent_id === null && !i.completed))

	function focusSoon(selector: string) {
		setTimeout(() => root.current?.querySelector<HTMLInputElement>(selector)?.focus(), 30)
	}

	async function toggle(item: Item) {
		const next = !item.completed
		setDay((d) => d && { ...d, items: d.items.map((i) => i.id === item.id ? { ...i, completed: next } : i) })
		try {
			await mutate(() => api.complete(item.id, next))
			if (next && day?.completeSubtasks) await load(true)
			else onChanged()
		} catch (e) {
			setDay((d) => d && { ...d, items: d.items.map((i) => i.id === item.id ? { ...i, completed: !next } : i) })
			showError(e)
		}
	}

	async function addQuick(e: React.FormEvent) {
		e.preventDefault()
		const title = quick.trim()
		if (!title) return
		try {
			await mutate(() => api.createQuick(key, title, owner))
			setQuick('')
			await load(true)
			focusSoon('.dt-add input')
		} catch (err) { showError(err) }
	}

	function openDraft(kind: Draft['kind'], target: number) {
		setRenaming(null)
		setDraft({ kind, target })
		setDraftTitle('')
		focusSoon('.dt-draft input')
	}

	async function commitDraft() {
		const cur = draft
		const title = draftTitle.trim()
		if (!cur || !title) { setDraft(null); return }
		try {
			const created = cur.kind === 'sub'
				? await mutate(() => api.createQuick(key, title, owner, cur.target))
				: await mutate(() => api.createQuick(key, title, owner, undefined, cur.target))
			await load(true)
			// Keep going: the next line opens right below the one just added.
			openDraft('sibling', created.id)
		} catch (e) { showError(e) }
	}

	function startRename(item: Item) {
		if (!canRename(item)) return
		if (item.source_type === 'task') {
			// A real task: edit it in a dialog, saved in Tasks.
			setDraft(null)
			setEditing(item.id)
			return
		}
		setDraft(null)
		setRenaming(item.id)
		setRenameTitle(item.title)
		focusSoon('.dt-rename')
	}

	async function commitRename(item: Item) {
		if (renaming !== item.id) return
		setRenaming(null)
		const title = renameTitle.trim()
		if (!title || title === item.title) return
		setDay((d) => d && { ...d, items: d.items.map((i) => i.id === item.id ? { ...i, title } : i) })
		try { await mutate(() => api.renameQuick(item.id, title)) } catch (e) { showError(e); void load(true) }
	}

	/** Swap with the visible sibling above/below (a parent keeps its subtasks). */
	function siblingsOf(item: Item): number[] {
		if (item.parent_id === null || !byId.has(item.parent_id)) return groups.map((g) => g.item.id)
		const g = groups.find((x) => x.children.some((c) => c.id === item.id))
		return g ? g.children.filter((c) => c.parent_id === item.parent_id).map((c) => c.id) : []
	}
	const neighbourOf = (item: Item, dir: -1 | 1) => { const ids = siblingsOf(item); return ids[ids.indexOf(item.id) + dir] as number | undefined }

	const reorderChain = useRef<Promise<unknown>>(Promise.resolve())
	function moveItem(item: Item, dir: -1 | 1) {
		const neighbour = neighbourOf(item, dir)
		if (neighbour === undefined || !day) return
		const known = new Set(items.map((i) => i.id))
		const parentKey = (i: Item) => i.parent_id !== null && known.has(i.parent_id) ? i.parent_id : null
		const childrenOf = new Map<number | null, number[]>()
		for (const i of items) childrenOf.set(parentKey(i), [...childrenOf.get(parentKey(i)) ?? [], i.id])
		const sibs = childrenOf.get(parentKey(item)) ?? []
		const from = sibs.indexOf(item.id), to = sibs.indexOf(neighbour)
		if (from < 0 || to < 0) return
		;[sibs[from], sibs[to]] = [sibs[to], sibs[from]]
		const order: number[] = []
		const seen = new Set<number>()
		const walk = (k: number | null) => { for (const id of childrenOf.get(k) ?? []) { if (seen.has(id)) continue; seen.add(id); order.push(id); walk(id) } }
		walk(null)
		for (const i of items) if (!seen.has(i.id)) order.push(i.id)
		setDay({ ...day, items: order.map((id) => byId.get(id)!) })
		live.current.saving++
		reorderChain.current = reorderChain.current
			.then(() => api.reorder(key, order, owner))
			.catch(async (e) => { showError(e); await load(true) })
			.finally(() => { live.current.saving-- })
	}

	function offerUndo(trash: number | undefined, message: string) {
		if (typeof trash !== 'number') { toast(message); return }
		toast(message, { action: { label: 'Undo', onClick: () => { void mutate(() => api.restore(trash)).then(() => load(true), showError) } } })
	}

	async function deleteItem(item: Item) {
		try {
			const r = await mutate(() => api.deleteQuick(item.id))
			await load(true)
			offerUndo(r?.trash, `Deleted "${item.title}"`)
		} catch (e) { showError(e) }
	}

	async function postpone(item: Item, days: number) {
		setPostponing(null)
		if (!Number.isInteger(days) || days < 1 || days > 365) { showError(new Error('Choose between 1 and 365 days')); return }
		try {
			const r = await mutate(() => api.postpone(item.id, days))
			await load(true)
			offerUndo(r?.trash, `"${item.title}" comes back ${days === 1 ? 'tomorrow' : r?.due ? shortDay(r.due) : `in ${days} days`}`)
		} catch (e) { showError(e) }
	}

	function subname(item: Item, g: Group) {
		const subs = g.item === item ? g.children : []
		const time = item.all_day ? 'All day' : item.starts_at ? new Date(item.starts_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
		return [
			time,
			item.due_at ? `Due ${new Date(item.due_at * 1000).toLocaleString()}` : '',
			subs.length ? `${subs.filter((c) => c.completed).length}/${subs.length} subtasks` : '',
		].filter(Boolean).join(' · ')
	}

	function menuFor(item: Item): (MenuEntry | false)[] {
		return [
			canRename(item) && { label: item.source_type === 'task' ? 'Edit' : 'Rename', icon: 'edit', onClick: () => startRename(item) },
			item.parent_id === null && { label: 'Add subtask', icon: 'add', onClick: () => openDraft('sub', item.id) },
			neighbourOf(item, -1) !== undefined && { label: 'Move up', icon: 'arrowUp', onClick: () => moveItem(item, -1) },
			neighbourOf(item, 1) !== undefined && { label: 'Move down', icon: 'arrowDown', onClick: () => moveItem(item, 1) },
			canPostpone(item) && { label: 'Postpone', icon: 'postpone', onClick: () => setPostponing(item) },
			(isQuick(item) || item.source_type === 'task') && { label: 'Delete', icon: 'delete', danger: true, onClick: () => item.source_type === 'task' ? setDeleting(item) : void deleteItem(item) },
		]
	}

	function draftRow(indented: boolean) {
		return (
			<li className={'dt-draft' + (indented ? ' dt-draft--sub' : '')}>
				<span className="dt-draft__dot" />
				<input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="New item (Enter to add, Esc to stop)" aria-label="New item"
					onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void commitDraft() } else if (e.key === 'Escape') setDraft(null) }}
					onBlur={() => { if (!draftTitle.trim()) setDraft(null) }} />
			</li>
		)
	}

	const heading = date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
	const shift = (n: number) => onDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + n))

	return (
		<div className="dt-page" ref={root}>
			<header className="dt-head">
				<div>
					<h1 className="dt-title">{heading}</h1>
					{day && <p className="dt-sub">{done} of {checkable.length} completed{sharedBy ? ` · Shared by ${sharedBy}` : ''}</p>}
				</div>
				<div className="dt-daynav">
					<IconButton icon="chevronLeft" label="Previous day" onClick={() => shift(-1)} />
					<Button variant="tonal" onClick={() => onDate(new Date())}>Today</Button>
					<IconButton icon="chevronRight" label="Next day" onClick={() => shift(1)} />
				</div>
			</header>

			{error && <div className="dt-note dt-note--error" role="alert"><Icon name="warning" />{error}<IconButton icon="close" label="Dismiss" onClick={() => setError('')} /></div>}

			{loading ? <div className="dt-loading"><Spinner /></div> : day && <>
				<Progress value={checkable.length ? done / checkable.length * 100 : 0} />
				{!day.editable && <div className="dt-note"><Icon name="info" />{day.future ? "This day hasn't started yet." : 'This historical day is read-only.'}</div>}
				{overdue.length > 0 && (
					<div className="dt-note dt-note--warn dt-overdue">
						<button type="button" className="dt-overdue__toggle" aria-expanded={showOverdue} onClick={() => setShowOverdue(!showOverdue)}>
							<Icon name="schedule" />{overdue.length === 1 ? '1 task is overdue' : `${overdue.length} tasks are overdue`}<Icon name="expandMore" className={showOverdue ? 'dt-flip' : ''} />
						</button>
						{showOverdue && <ul>{overdue.map((t) => (
							<li key={t.id}><span>{t.title}</span><small>was due {shortDay(t.date)}</small>
								<Button variant="text" onClick={() => { void mutate(() => api.moveOverdue(t.id)).then(() => load(true), showError) }}>Move to today</Button></li>
						))}</ul>}
					</div>
				)}

				{day.editable && (
					<form className="dt-add" onSubmit={addQuick}>
						<Icon name="add" />
						<input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Add a task" aria-label="Add a task" autoComplete="off" enterKeyHint="done" />
						{quick.trim() && <kbd>Enter</kbd>}
					</form>
				)}

				{items.length ? (
					<ul className="dt-list">
						{groups.map((g) => {
							const sep = separatorKind(g.item.title)
							if (sep) return (
								<li key={g.item.id} className={'dt-sep dt-sep--' + sep}>
									{sep === 'rule' && <hr />}
									{isQuick(g.item) && <IconButton icon="delete" label="Delete separator" onClick={() => void deleteItem(g.item)} />}
								</li>
							)
							const rows = [g.item, ...g.children]
							const target = draft && rows.find((r) => r.id === draft.target)
							const slot = target ? { after: target === g.item ? rows[rows.length - 1].id : target.id, indented: draft!.kind === 'sub' || target !== g.item } : null
							return (
								<li key={g.item.id} className="dt-group">
									<ul>
										{rows.map((item) => (
											<FragmentRow key={item.id}>
												<li className={'dt-row' + (item.completed ? ' dt-row--done' : '') + (item !== g.item ? ' dt-row--child' : '')} style={{ '--depth': depthOf(item) } as React.CSSProperties} data-item-id={item.id}>
													<Checkbox round checked={item.completed} disabled={!editable} aria-label={`Mark ${item.title} as done`} onChange={() => void toggle(item)} />
													<div className="dt-row__text">
														{renaming === item.id ? (
															<input className="dt-rename" value={renameTitle} aria-label="Title" onChange={(e) => setRenameTitle(e.target.value)}
																onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void commitRename(item).then(() => openDraft('sibling', item.id)) } else if (e.key === 'Escape') setRenaming(null) }}
																onBlur={() => void commitRename(item)} />
														) : canRename(item) ? (
															<button type="button" className="dt-row__title" onClick={() => startRename(item)}>{item.title}</button>
														) : item.href ? (
															<a className="dt-row__title" href={item.href} target="_blank" rel="noopener noreferrer">{item.title}</a>
														) : <span className="dt-row__title">{item.title}</span>}
														{subname(item, g) && <span className="dt-row__sub">{subname(item, g)}</span>}
														{item.error && <span className="dt-row__err">{item.error}</span>}
													</div>
													<span className={'dt-chip dt-chip--' + item.source_type} title={item.source_type}>{item.source_type === 'event' ? <Icon name="event" /> : item.source_type === 'task' ? <Icon name="task" /> : item.source_type === 'routine' ? <Icon name="refresh" /> : null}</span>
													{editable && <Menu trigger={(open, ex) => <IconButton icon="moreVert" label="Actions" aria-expanded={ex} onClick={open} />} items={menuFor(item)} />}
												</li>
												{slot?.after === item.id && draftRow(slot.indented)}
											</FragmentRow>
										))}
									</ul>
								</li>
							)
						})}
					</ul>
				) : (
					<EmptyState icon="sunrise" title="Nothing planned yet">
						{day.editable ? 'Add a task above or enable sources in Settings.' : day.future ? 'A day is created when it starts.' : 'Nothing was recorded on this day.'}
					</EmptyState>
				)}
				{done > 0 && <Switch label="Hide completed items" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />}
			</>}

			{editing !== null && <TaskDialog itemId={editing} onClose={() => setEditing(null)} onSaved={async (r) => {
				setEditing(null)
				await load(true)
				if (r.moved) toast(r.day ? `"${r.title}" is now on ${shortDay(r.day)}` : `"${r.title}" no longer has a date`)
			}} />}

			<Dialog open={!!deleting} title="Delete task?" onClose={() => setDeleting(null)} actions={<>
				<Button variant="text" onClick={() => setDeleting(null)}>Cancel</Button>
				<Button onClick={() => { const it = deleting!; setDeleting(null); void deleteItem(it) }}>Delete from Tasks</Button>
			</>}>
				<p style={{ margin: 0 }}>"{deleting?.title}" is a task: deleting it here also deletes it in Tasks. You can undo for a few seconds.</p>
			</Dialog>

			{postponing && <PostponeDialog item={postponing} today={day?.logicalToday ?? key} onClose={() => setPostponing(null)} onPick={(n) => void postpone(postponing, n)} />}
		</div>
	)
}

function FragmentRow({ children }: { children: React.ReactNode }) { return <>{children}</> }

function PostponeDialog({ item, today, onClose, onPick }: { item: Item, today: string, onClose: () => void, onPick: (days: number) => void }) {
	const [custom, setCustom] = useState('')
	const base = parseKey(today)
	const label = (n: number) => shortDay(dateKeyOf(new Date(base.getFullYear(), base.getMonth(), base.getDate() + n)))
	const choices: [string, number][] = [['Tomorrow', 1], ['In 2 days', 2], ['In 3 days', 3], ['Next week', 7]]
	return (
		<Dialog open title={`Postpone "${item.title}"`} onClose={onClose} actions={<Button variant="text" onClick={onClose}>Cancel</Button>}>
			<div className="dt-postpone">
				{choices.map(([name, n]) => (
					<button key={n} type="button" className="dt-postpone__opt" onClick={() => onPick(n)}><span>{name}</span><small>{label(n)}</small></button>
				))}
				<form className="dt-postpone__custom" onSubmit={(e) => { e.preventDefault(); onPick(Number(custom)) }}>
					<TextField label="Days (1-365)" type="number" min={1} max={365} value={custom} onChange={(e) => setCustom(e.target.value)} />
					<Button type="submit" variant="tonal" disabled={!custom}>Postpone</Button>
				</form>
				{item.source_type === 'task' && <p className="at-muted" style={{ margin: 0 }}>The task's dates move in Tasks too.</p>}
			</div>
		</Dialog>
	)
}

const PRIORITIES = [{ value: '0', label: 'None' }, { value: '1', label: 'High' }, { value: '5', label: 'Medium' }, { value: '9', label: 'Low' }]

function TaskDialog({ itemId, onClose, onSaved }: { itemId: number, onClose: () => void, onSaved: (r: { title: string, moved: boolean, day: string | null }) => void }) {
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState('')
	const [unreadable, setUnreadable] = useState(false)
	const [saving, setSaving] = useState(false)
	const [repeating, setRepeating] = useState(false)
	const [f, setF] = useState({ title: '', description: '', start: '', due: '', priority: '0' })
	useEffect(() => {
		api.taskDetails(itemId).then((t) => {
			setF({ title: t.title, description: t.description, start: t.start ?? '', due: t.due ?? '', priority: String(t.priority) })
			setRepeating(t.repeating)
		}, (e) => { setError(errorText(e)); setUnreadable(true) }).finally(() => setLoading(false))
	}, [itemId])
	const ordered = !f.start || !f.due || f.due >= f.start
	const priorities = PRIORITIES.some((p) => p.value === f.priority) ? PRIORITIES : [...PRIORITIES, { value: f.priority, label: `Priority ${f.priority}` }]
	async function save(e: React.FormEvent) {
		e.preventDefault()
		if (!f.title.trim() || !ordered) return
		setSaving(true)
		try {
			onSaved(await api.editTask(itemId, { title: f.title.trim(), description: f.description, start: f.start || null, due: f.due || null, priority: Number(f.priority) }))
		} catch (err) { setError(errorText(err)); setSaving(false) }
	}
	const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })
	return (
		<Dialog open title="Edit task" onClose={onClose} actions={<>
			<Button variant="text" onClick={onClose}>Cancel</Button>
			<Button type="submit" form="dt-task" busy={saving} disabled={loading || unreadable || !f.title.trim() || !ordered}>Save</Button>
		</>}>
			{loading ? <div className="dt-loading"><Spinner /></div> : (
				<form id="dt-task" className="dt-taskform" onSubmit={save}>
					{error && <div className="dt-note dt-note--error">{error}</div>}
					{!unreadable && <>
						<TextField label="Title" value={f.title} onChange={set('title')} required autoFocus />
						<TextArea label="Notes" value={f.description} onChange={set('description')} rows={4} />
						<div className="dt-taskform__row">
							<TextField label="Start" type="date" value={f.start} onChange={set('start')} disabled={repeating} />
							<TextField label="Due" type="date" value={f.due} onChange={set('due')} disabled={repeating} error={ordered ? undefined : 'Due is before start'} />
						</div>
						{repeating && <p className="at-muted" style={{ margin: 0 }}>This task repeats: its dates are managed in Tasks.</p>}
						<Select label="Priority" value={f.priority} onChange={set('priority')}>
							{priorities.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
						</Select>
					</>}
				</form>
			)}
		</Dialog>
	)
}
