// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Task detail pane: every field saves on change/blur (If-Match), no Save button.
import { useState } from 'react'
import { dateKey, parseKey, timeOfDay, type IcsTime } from '@atrium/sdk'
import { Checkbox, Icon, IconButton, Menu, Select, TextArea, toast } from '@atrium/ui'
import { moveTask, type Patch, type Task, type TaskList } from './api'

const PRIORITIES = [{ v: 0, label: 'None' }, { v: 1, label: 'High' }, { v: 5, label: 'Medium' }, { v: 9, label: 'Low' }]
const prioBucket = (p: number) => (p >= 1 && p <= 4 ? 1 : p === 5 ? 5 : p >= 6 ? 9 : 0)

function DateField({ label, value, onChange, disabled }: { label: string, value: IcsTime | null, onChange: (v: IcsTime | null) => void, disabled?: boolean }) {
	const day = value ? dateKey(value.date) : ''
	const time = value && !value.allDay ? timeOfDay(value.date) : ''
	const emit = (d: string, t: string) => {
		const base = parseKey(d)
		if (!base) return onChange(null)
		if (!t) return onChange({ date: base, allDay: true })
		const [h, m] = t.split(':').map(Number)
		onChange({ date: new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m), allDay: false })
	}
	return (
		<div className="tk-datefield">
			<span className="tk-datefield__label">{label}</span>
			<input type="date" aria-label={label} value={day} disabled={disabled} onChange={(e) => emit(e.target.value, time)} />
			{value && <input type="time" aria-label={`${label} time`} value={time} disabled={disabled} onChange={(e) => emit(day, e.target.value)} />}
			{value && !disabled && <IconButton icon="close" label={`Clear ${label.toLowerCase()}`} onClick={() => onChange(null)} />}
		</div>
	)
}

export function TaskDetail({ task: t, lists, children_, onPatch, onReplace, onAddSub, onDelete, onClose, onOpen }: {
	task: Task, lists: TaskList[], children_: Task[]
	onPatch: (t: Task, p: Patch) => Promise<Task | null>
	onReplace: (next: Task, prev?: Task) => void
	onAddSub: (title: string) => void
	onDelete: (t: Task) => void
	onClose: () => void
	onOpen: (t: Task | null) => void
}) {
	const ro = t.list.readOnly
	const [title, setTitle] = useState(t.title)
	const [notes, setNotes] = useState(t.notes)
	const [tag, setTag] = useState('')
	const [sub, setSub] = useState('')

	const move = async (id: string) => {
		const to = lists.find((l) => l.id === id)
		if (!to || to.url === t.list.url) return
		try {
			onReplace(await moveTask(t, to), t)
			for (const c of children_) onReplace(await moveTask(c, to), c)
		} catch (e) { toast.error(`Could not move: ${e instanceof Error ? e.message : e}`) }
	}
	const addTag = () => {
		const v = tag.trim()
		setTag('')
		if (v && !t.tags.includes(v)) onPatch(t, { tags: [...t.tags, v] })
	}

	return (
		<div className="tk-detail" style={{ ['--c' as string]: t.list.color }}>
			<header className="tk-detail__head">
				<Checkbox round className="tk-check" checked={t.done} disabled={ro} onChange={(e) => onPatch(t, { done: e.target.checked })} aria-label={t.done ? 'Reopen' : 'Complete'} />
				<input className="tk-detail__title" value={title} disabled={ro} aria-label="Title" onChange={(e) => setTitle(e.target.value)}
					onBlur={() => title.trim() !== t.title && onPatch(t, { title })} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
				<Menu trigger={(o, x) => <IconButton icon="moreVert" label="Task actions" aria-expanded={x} onClick={o} />} items={[
					{ label: 'Download', icon: 'download', href: t.url },
					!ro && { label: 'Delete', icon: 'delete', danger: true, onClick: () => onDelete(t) },
				]} />
				<IconButton icon="close" label="Close" onClick={onClose} />
			</header>

			<div className="tk-detail__body">
				<DateField label="Due" value={t.due} disabled={ro} onChange={(due) => onPatch(t, { due })} />
				<DateField label="Start" value={t.start} disabled={ro} onChange={(start) => onPatch(t, { start })} />
				<div className="tk-grid2">
					<Select label="Priority" value={prioBucket(t.priority)} disabled={ro} onChange={(e) => onPatch(t, { priority: Number(e.target.value) })}>
						{PRIORITIES.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
					</Select>
					<Select label="List" value={t.list.id} disabled={ro || !!t.parent} onChange={(e) => move(e.target.value)}>
						{(lists.some((l) => l.url === t.list.url) ? lists : [t.list, ...lists]).map((l) => <option key={l.url} value={l.id}>{l.name}</option>)}
					</Select>
				</div>

				<div className="tk-tags">
					{t.tags.map((g) => (
						<span key={g} className="tk-tag tk-tag--edit">{g}{!ro && <button type="button" aria-label={`Remove tag ${g}`} onClick={() => onPatch(t, { tags: t.tags.filter((x) => x !== g) })}><Icon name="close" size="s" /></button>}</span>
					))}
					{!ro && <input className="tk-tags__input" value={tag} placeholder="Add tag…" aria-label="Add tag" onChange={(e) => setTag(e.target.value)}
						onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag() } }} onBlur={addTag} />}
				</div>

				<TextArea label="Notes" rows={5} value={notes} disabled={ro} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== t.notes && onPatch(t, { notes })} />

				<section className="tk-subs">
					<h2 className="tk-subs__title">Subtasks{children_.length > 0 && ` · ${children_.filter((c) => c.done).length}/${children_.length}`}</h2>
					<ul className="tk-subs__list">
						{children_.map((c) => (
							<li key={c.url} className={'tk-sub' + (c.done ? ' tk-sub--done' : '')}>
								<Checkbox round className="tk-check" checked={c.done} disabled={ro} onChange={(e) => onPatch(c, { done: e.target.checked })} aria-label={`Complete ${c.title}`} />
								<button type="button" className="tk-sub__title" onClick={() => onOpen(c)}>{c.title || 'Untitled task'}</button>
							</li>
						))}
					</ul>
					{!ro && (
						<form className="tk-add tk-add--sub" onSubmit={(e) => { e.preventDefault(); if (sub.trim()) { onAddSub(sub); setSub('') } }}>
							<Icon name="add" />
							<input value={sub} onChange={(e) => setSub(e.target.value)} placeholder="Add subtask…" aria-label="New subtask" />
						</form>
					)}
				</section>

				<p className="tk-detail__foot at-muted">
					{t.created && `Created ${t.created.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`}
					{t.done && t.completedAt && ` · Completed ${t.completedAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`}
				</p>
			</div>
		</div>
	)
}
