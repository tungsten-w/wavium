// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tasks for the Atrium shell (VTODO over CalDAV). Routes below /apps/tasks:
//   /<collection>[/<uid>]   collection = all | today | week | important | completed
//   /list/<id>[/<uid>]      one task list
// Upstream hash links (#/collections/all, #/calendars/<id>/tasks/<file>) are redirected.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addDays, defineApp, navigate, startOfDay, useApp, useAppPath, useLocation } from '@atrium/sdk'
import { AppLayout, Button, Checkbox, Dialog, EmptyState, Icon, IconButton, Menu, NavItem, NavSection, NavToggle, Spinner, TextField, confirmDialog, toast } from '@atrium/ui'
import { createList, createTask, deleteList, deleteTask, listLists, listTasks, restoreTask, updateList, updateTask, type Patch, type Task, type TaskList } from './api'
import { TaskDetail } from './Detail'
import { reorder, sortKey } from './recur'
import { ShareDialog } from './Share'
import './style.css'

type Collection = 'all' | 'today' | 'week' | 'important' | 'completed'
const COLLECTIONS: { id: Collection, label: string, icon: string }[] = [
	{ id: 'all', label: 'All', icon: 'task' }, { id: 'today', label: 'Today', icon: 'today' }, { id: 'week', label: 'Next 7 days', icon: 'event' },
	{ id: 'important', label: 'Important', icon: 'star' }, { id: 'completed', label: 'Completed', icon: 'check' },
]
const COLORS = ['#0082c9', '#386a20', '#b3261e', '#e8710a', '#a142f4', '#00897b', '#c2185b', '#5f6368']
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
export const isImportant = (t: Task) => t.priority >= 1 && t.priority <= 4

function Tasks() {
	const { basePath, session, setTitle } = useApp()
	const user = session.user.id
	const path = useAppPath()
	const { hash } = useLocation()
	const [lists, setLists] = useState<TaskList[] | null>(null)
	const [tasks, setTasks] = useState<Task[]>([])
	const [listDialog, setListDialog] = useState<{ list: TaskList | null, name: string, color: string } | null>(null)
	const [showDone, setShowDone] = useState(false)
	const [draft, setDraft] = useState('')
	const [sharing, setSharing] = useState<TaskList | null>(null)

	const seg = path.split('/').filter(Boolean).map(decodeURIComponent)
	const listId = seg[0] === 'list' ? seg[1] ?? null : null
	const collection: Collection | null = listId ? null : COLLECTIONS.some((c) => c.id === seg[0]) ? seg[0] as Collection : 'all'
	const selectedUid = listId ? seg[2] ?? null : seg[1] ?? null
	const here = listId ? `${basePath}/list/${encodeURIComponent(listId)}` : `${basePath}/${collection}`

	// Upstream hash links.
	useEffect(() => {
		const m = /^#\/(collections\/(\w+)|calendars\/([^/]+)(?:\/tasks\/([^/]+))?)/.exec(hash)
		if (!m) return
		if (m[2]) navigate(`${basePath}/${m[2] === 'current' || m[2] === 'starred' ? (m[2] === 'starred' ? 'important' : 'all') : m[2]}`, { replace: true })
		else navigate(`${basePath}/list/${encodeURIComponent(m[3])}`, { replace: true })
	}, [hash, basePath])

	const load = useCallback(async () => {
		try {
			let ls = await listLists(user)
			if (!ls.some((l) => !l.readOnly && !l.shared)) {
				await createList(user, 'Tasks', '#0082c9', 'tasks').catch(() => {})
				ls = await listLists(user)
			}
			const all = await Promise.all(ls.map((l) => listTasks(l).catch(() => [] as Task[])))
			setLists(ls)
			latest.current = new Map(all.flat().map((t) => [t.url, t]))
			setTasks(all.flat())
		} catch (e) {
			toast.error(`Could not load tasks: ${errText(e)}`)
			setLists((l) => l ?? [])
		}
	}, [user])
	useEffect(() => { load() }, [load])

	// Pick up changes from phones and Daily Todo when the tab comes back.
	const listsRef = useRef(lists)
	listsRef.current = lists
	useEffect(() => {
		const check = async () => {
			if (document.hidden || !listsRef.current) return
			const fresh = await listLists(user).catch(() => null)
			if (!fresh) return
			const old = new Map(listsRef.current.map((l) => [l.url, l.ctag]))
			if (fresh.length !== old.size || fresh.some((l) => old.get(l.url) !== l.ctag)) load()
		}
		document.addEventListener('visibilitychange', check)
		return () => document.removeEventListener('visibilitychange', check)
	}, [user, load])

	const currentList = listId ? lists?.find((l) => l.id === listId) ?? null : null
	const title = currentList?.name ?? COLLECTIONS.find((c) => c.id === collection)?.label ?? 'Tasks'
	useEffect(() => { setTitle(title === 'Tasks' ? 'Tasks' : `${title} - Tasks`) }, [title, setTitle])

	const writable = (lists ?? []).filter((l) => !l.readOnly)
	const targetList = currentList && !currentList.readOnly ? currentList : writable[0]
	const endOfToday = addDays(startOfDay(new Date()), 1).getTime()
	const inScope = useCallback((t: Task) => {
		if (listId) return t.list.id === listId
		const when = (t.due ?? t.start)?.date.getTime()
		switch (collection) {
			case 'today': return !t.done && when !== undefined && when < endOfToday
			case 'week': return !t.done && when !== undefined && when < endOfToday + 6 * 86400000
			case 'important': return !t.done && isImportant(t)
			case 'completed': return t.done
			default: return !t.done
		}
	}, [listId, collection, endOfToday])

	const scoped = useMemo(() => tasks.filter(inScope), [tasks, inScope])
	const open = scoped.filter((t) => collection === 'completed' || !t.done)
	const done = listId ? scoped.filter((t) => t.done) : []
	const counts = useMemo(() => {
		const c: Record<string, number> = {}
		for (const col of COLLECTIONS) if (col.id !== 'completed') c[col.id] = 0
		const eot = endOfToday
		for (const t of tasks) {
			if (t.done) continue
			c.all++
			const when = (t.due ?? t.start)?.date.getTime()
			if (when !== undefined && when < eot) c.today++
			if (when !== undefined && when < eot + 6 * 86400000) c.week++
			if (isImportant(t)) c.important++
			c[`list:${t.list.url}`] = (c[`list:${t.list.url}`] ?? 0) + 1
		}
		return c
	}, [tasks, endOfToday])

	const replace = (next: Task, prev?: Task) => {
		latest.current.set(next.url, next)
		setTasks((ts) => [...ts.filter((t) => t !== prev && t.url !== next.url), next])
	}
	// Edits of one task run one after the other, each on the version the previous one saved:
	// two quick changes (a date, then the repeat) must not overwrite each other.
	const latest = useRef(new Map<string, Task>())
	const queues = useRef(new Map<string, Promise<unknown>>())
	const patch = (t: Task, p: Patch): Promise<Task | null> => {
		const run = (queues.current.get(t.url) ?? Promise.resolve()).then(() => patchNow(latest.current.get(t.url) ?? t, p))
		queues.current.set(t.url, run.catch(() => {}))
		return run
	}
	const patchNow = async (t: Task, p: Patch) => {
		try {
			const n = await updateTask(t, p)
			replace(n, t)
			// A repeating task moved to its next date instead of closing.
			if (p.done === true && !n.done && n.repeat !== 'none') {
				const next = dueLabel(n)
				toast(next ? `Done. Next: ${next.text}` : 'Done. It comes back.')
				return n
			}
			// Ticking a parent ticks its open subtasks too (upstream behaviour).
			if (p.done === true) for (const c of tasks.filter((x) => x.parent === t.uid && !x.done)) updateTask(c, { done: true }).then((nc) => replace(nc, c), () => {})
			return n
		} catch (e) {
			toast.error(`Could not save: ${errText(e)}`)
			if (/412|Precondition/i.test(errText(e))) load()
			return null
		}
	}
	const add = async (title: string, extra: Patch = {}, into: TaskList | undefined = targetList) => {
		if (!title.trim() || !into) return
		const auto: Patch = extra.parent ? {} : collection === 'today' ? { due: { date: startOfDay(new Date()), allDay: true } } : collection === 'important' ? { priority: 1 } : {}
		try { replace(await createTask(into, title, { ...auto, ...extra })) } catch (e) { toast.error(`Could not add: ${errText(e)}`) }
	}
	const remove = async (t: Task) => {
		const kids = tasks.filter((x) => x.parent === t.uid)
		if (kids.length && !await confirmDialog(`Delete "${t.title}" and its ${kids.length} subtask${kids.length === 1 ? '' : 's'}?`, { title: 'Delete task', confirm: 'Delete', danger: true })) return
		try {
			for (const k of kids) await deleteTask(k)
			await deleteTask(t)
			setTasks((ts) => ts.filter((x) => x !== t && !kids.includes(x)))
			if (selectedUid === t.uid) navigate(here)
			toast(`Deleted ${t.title || 'task'}`, { action: { label: 'Undo', onClick: async () => {
				try { const r = await restoreTask(t); replace(r); for (const k of kids) replace(await restoreTask(k)) } catch (e) { toast.error(errText(e)) }
			} } })
		} catch (e) { toast.error(`Could not delete: ${errText(e)}`) }
	}

	async function submitList() {
		if (!listDialog?.name.trim()) return
		try {
			if (listDialog.list) await updateList(listDialog.list, listDialog.name.trim(), listDialog.color)
			else await createList(user, listDialog.name.trim(), listDialog.color)
			setListDialog(null)
			load()
		} catch (e) { toast.error(errText(e)) }
	}
	async function removeList(l: TaskList) {
		if (!await confirmDialog(`Delete the list "${l.name}" and all its tasks?`, { title: 'Delete list', confirm: 'Delete', danger: true })) return
		try { await deleteList(l); if (listId === l.id) navigate(`${basePath}/all`); load() } catch (e) { toast.error(errText(e)) }
	}

	// Manual order inside one list (drag and drop, or Move up / down): siblings = same list, same parent, open.
	const siblingsOf = (t: Task) => tasks.filter((x) => x.list.url === t.list.url && x.parent === t.parent && !x.done).sort(manual)
	const placeBefore = async (t: Task, before: Task | null) => {
		for (const { task, sortOrder } of reorder(siblingsOf(t), t, before)) await patch(task, { sortOrder })
	}
	const move = (t: Task, dir: -1 | 1) => {
		const sib = siblingsOf(t)
		const i = sib.findIndex((x) => x.url === t.url)
		if (i < 0 || (dir < 0 && i === 0) || (dir > 0 && i === sib.length - 1)) return
		void placeBefore(t, dir < 0 ? sib[i - 1] : sib[i + 2] ?? null)
	}

	const selected = selectedUid ? tasks.find((t) => t.uid === selectedUid) ?? null : null
	const openTask = (t: Task | null) => navigate(t ? `${here}/${encodeURIComponent(t.uid)}` : here)

	const nav = (
		<>
			<NavSection>
				{COLLECTIONS.map((c) => <NavItem key={c.id} icon={c.icon} label={c.label} count={counts[c.id]} active={collection === c.id} href={`${basePath}/${c.id}`} onClick={() => navigate(`${basePath}/${c.id}`)} />)}
			</NavSection>
			<NavSection title="Lists">
				{(lists ?? []).map((l) => (
					<NavItem key={l.url} icon="task" label={l.name} count={counts[`list:${l.url}`]} active={listId === l.id}
						href={`${basePath}/list/${encodeURIComponent(l.id)}`} onClick={() => navigate(`${basePath}/list/${encodeURIComponent(l.id)}`)}
						actions={
							<span className="tk-nav-menu" style={{ ['--c' as string]: l.color }} onClick={(e) => { e.stopPropagation(); e.preventDefault() }}>
								<Menu trigger={(o, x) => <IconButton icon="moreVert" label={`${l.name} actions`} aria-expanded={x} onClick={o} />} items={[
									!l.shared && !l.readOnly && { label: 'Edit', icon: 'edit', onClick: () => setListDialog({ list: l, name: l.name, color: l.color }) },
									!l.shared && !l.readOnly && { label: 'Share', icon: 'share', onClick: () => setSharing(l) },
									{ label: 'Download', icon: 'download', href: `${l.url}?export` },
									!l.shared && { label: 'Delete', icon: 'delete', danger: true, onClick: () => removeList(l) },
								]} />
							</span>
						} />
				))}
				<NavItem icon="add" label="New list" onClick={() => setListDialog({ list: null, name: '', color: COLORS[(lists?.length ?? 0) % COLORS.length] })} />
			</NavSection>
		</>
	)

	return (
		<AppLayout nav={nav}>
			<div className={'tk' + (selected ? ' tk--detail' : '')}>
				<section className="tk-main">
					<header className="tk-head">
						<NavToggle />
						<h1 className="tk-title">{currentList && <span className="tk-title__dot" style={{ background: currentList.color }} />}{title}</h1>
					</header>
					{collection !== 'completed' && targetList && !(currentList?.readOnly) && (
						<form className="tk-add" onSubmit={(e) => { e.preventDefault(); add(draft); setDraft('') }}>
							<Icon name="add" />
							<input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Add a task${currentList ? '' : ` to ${targetList.name}`}…`} aria-label="New task" />
							{draft.trim() && <Button type="submit" size="s">Add</Button>}
						</form>
					)}
					{lists === null ? <div className="tk-center"><Spinner /></div>
						: open.length === 0 && done.length === 0 ? <EmptyState icon={collection === 'completed' ? 'check' : 'task'} title={collection === 'completed' ? 'Nothing completed yet' : 'All done'} />
						: (
							<>
								<TaskTree tasks={open} all={tasks} selected={selected} showList={!listId} onOpen={openTask} onPatch={patch} manualOrder={!!listId && !currentList?.readOnly} onDropBefore={placeBefore} />
								{done.length > 0 && (
									<div className="tk-done">
										<button type="button" className="tk-done__toggle" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
											<Icon name={showDone ? 'expandMore' : 'chevronRight'} /> Completed ({done.length})
										</button>
										{showDone && <TaskTree tasks={done} all={tasks} selected={selected} showList={false} onOpen={openTask} onPatch={patch} />}
									</div>
								)}
							</>
						)}
				</section>
				<aside className="tk-side">
					{selected
						? <TaskDetail key={selected.url} task={selected} lists={writable} children_={tasks.filter((t) => t.parent === selected.uid)} onPatch={patch} onReplace={replace} onAddSub={(title) => add(title, { parent: selected.uid }, selected.list)} onDelete={remove} onClose={() => openTask(null)} onOpen={openTask} onMove={listId && !selected.done ? move : undefined} />
						: <EmptyState icon="task" title="Select a task to see its details" />}
				</aside>
			</div>
			{sharing && <ShareDialog list={sharing} onClose={() => setSharing(null)} />}
			<Dialog open={!!listDialog} title={listDialog?.list ? 'Edit list' : 'New list'} onClose={() => setListDialog(null)}
				actions={<><Button variant="text" onClick={() => setListDialog(null)}>Cancel</Button><Button disabled={!listDialog?.name.trim()} onClick={submitList}>{listDialog?.list ? 'Save' : 'Create'}</Button></>}>
				<form className="tk-listdlg" onSubmit={(e) => { e.preventDefault(); submitList() }}>
					<TextField label="Name" autoFocus value={listDialog?.name ?? ''} onChange={(e) => setListDialog((d) => d && { ...d, name: e.target.value })} />
					<div className="tk-swatches" role="radiogroup" aria-label="Colour">
						{COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={listDialog?.color === c} aria-label={c} className="tk-swatch" style={{ background: c }} onClick={() => setListDialog((d) => d && { ...d, color: c })} />)}
					</div>
				</form>
			</Dialog>
		</AppLayout>
	)
}

/** Sort: due first (soonest), then important, then newest. */
function order(a: Task, b: Task): number {
	const ad = (a.due ?? a.start)?.date.getTime() ?? Infinity
	const bd = (b.due ?? b.start)?.date.getTime() ?? Infinity
	if (a.done && b.done) return (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0)
	return ad - bd || Number(isImportant(b)) - Number(isImportant(a)) || (b.created?.getTime() ?? 0) - (a.created?.getTime() ?? 0)
}

/** Manual order first (X-APPLE-SORT-ORDER), then the usual order. */
export function manual(a: Task, b: Task): number {
	return sortKey(a.sortOrder) - sortKey(b.sortOrder) || order(a, b)
}

function TaskTree({ tasks, all, selected, showList, onOpen, onPatch, manualOrder = false, onDropBefore }: { tasks: Task[], all: Task[], selected: Task | null, showList: boolean, onOpen: (t: Task) => void, onPatch: (t: Task, p: Patch) => void, manualOrder?: boolean, onDropBefore?: (t: Task, before: Task | null) => void }) {
	const uids = new Set(tasks.map((t) => t.uid))
	const cmp = manualOrder ? manual : order
	const roots = tasks.filter((t) => !t.parent || !uids.has(t.parent)).sort(cmp)
	const kids = (t: Task) => tasks.filter((c) => c.parent === t.uid).sort(cmp)
	const [dragging, setDragging] = useState<Task | null>(null)
	const drag = manualOrder && onDropBefore ? {
		start: (t: Task) => setDragging(t),
		end: () => setDragging(null),
		// Dropped on a sibling: placed just before it.
		drop: (target: Task) => { if (dragging && dragging !== target && dragging.parent === target.parent) onDropBefore(dragging, target); setDragging(null) },
	} : undefined
	const row = (t: Task, depth: number): React.ReactNode => {
		const sub = all.filter((c) => c.parent === t.uid)
		return [
			<TaskRow key={t.url} task={t} depth={depth} selected={t === selected} showList={showList} subCount={sub.length} subDone={sub.filter((s) => s.done).length} onOpen={onOpen} onPatch={onPatch} drag={drag} />,
			...kids(t).map((c) => row(c, depth + 1)),
		]
	}
	return <ul className="tk-list">{roots.map((t) => row(t, 0))}</ul>
}

export function dueLabel(t: Task): { text: string, late: boolean } | null {
	const d = t.due
	if (!d) return null
	const today = startOfDay(new Date())
	const day = startOfDay(d.date)
	const diff = Math.round((day.getTime() - today.getTime()) / 86400000)
	const time = d.allDay ? '' : ` ${d.date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
	const text = diff === 0 ? `Today${time}` : diff === 1 ? `Tomorrow${time}` : diff === -1 ? `Yesterday${time}`
		: `${d.date.toLocaleDateString(undefined, { weekday: Math.abs(diff) < 7 ? 'short' : undefined, day: 'numeric', month: 'short', year: day.getFullYear() !== today.getFullYear() ? 'numeric' : undefined })}${time}`
	return { text, late: !t.done && (d.allDay ? diff < 0 : d.date.getTime() < Date.now()) }
}

function TaskRow({ task: t, depth, selected, showList, subCount, subDone, onOpen, onPatch, drag }: { task: Task, depth: number, selected: boolean, showList: boolean, subCount: number, subDone: number, onOpen: (t: Task) => void, onPatch: (t: Task, p: Patch) => void, drag?: { start: (t: Task) => void, end: () => void, drop: (t: Task) => void } }) {
	const due = dueLabel(t)
	const ro = t.list.readOnly
	const [over, setOver] = useState(false)
	const dnd = drag && !ro && !t.done ? {
		draggable: true,
		onDragStart: (e: React.DragEvent) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.uid); drag.start(t) },
		onDragEnd: () => { setOver(false); drag.end() },
		onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(true) },
		onDragLeave: () => setOver(false),
		onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(false); drag.drop(t) },
	} : {}
	return (
		<li className={'tk-row' + (selected ? ' tk-row--sel' : '') + (t.done ? ' tk-row--done' : '') + (over ? ' tk-row--over' : '')} data-task={t.uid} style={{ ['--depth' as string]: depth, ['--c' as string]: t.list.color }} {...dnd}>
			{drag && !ro && !t.done && <span className="tk-grip" aria-hidden="true"><Icon name="drag" size="s" /></span>}
			<Checkbox round className={'tk-check' + (isImportant(t) ? ' tk-check--imp' : '')} checked={t.done} disabled={ro} onChange={(e) => onPatch(t, { done: e.target.checked })} aria-label={t.done ? `Reopen ${t.title}` : `Complete ${t.title}`} />
			<button type="button" className="tk-row__main" onClick={() => onOpen(t)}>
				<span className="tk-row__title">{t.title || 'Untitled task'}</span>
				<span className="tk-row__meta">
					{due && <span className={'tk-due' + (due.late ? ' tk-due--late' : '')}><Icon name="event" size="s" />{due.text}</span>}
					{t.repeat !== 'none' && <span className="tk-meta" title="Repeats"><Icon name="refresh" size="s" /></span>}
					{subCount > 0 && <span className="tk-meta"><Icon name="indentMore" size="s" />{subDone}/{subCount}</span>}
					{t.notes && <span className="tk-meta"><Icon name="notes" size="s" /></span>}
					{t.tags.map((g) => <span key={g} className="tk-tag">{g}</span>)}
					{showList && <span className="tk-meta tk-listname"><span className="tk-dot" />{t.list.name}</span>}
				</span>
			</button>
			<IconButton className={'tk-star' + (isImportant(t) ? ' tk-star--on' : '')} icon={isImportant(t) ? 'star' : 'starBorder'} label={isImportant(t) ? 'Not important' : 'Mark important'} disabled={ro} onClick={() => onPatch(t, { priority: isImportant(t) ? 0 : 1 })} />
		</li>
	)
}

export default defineApp({ Component: Tasks })
