// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Notes for the Atrium shell, over the unchanged Notes backend (notes are
// Markdown/text files in the user's Notes folder). Routes below /apps/notes:
//   /                 list (?category=<path> | ?category= for uncategorized | ?favorites=1, &q=search)
//   /note/<id>        a note (same URL as the classic app, so old links work)
//   /new, /welcome    classic entry points: create a note / the list
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defineApp, navigate, useApp, useAppPath, useQuery } from '@atrium/sdk'
import { AppLayout, Button, Dialog, EmptyState, Icon, IconButton, Menu, NavItem, NavSection, NavToggle, SearchBar, Select, Spinner, TextField, confirmDialog, toast, useDebounced } from '@atrium/ui'
import { createNote, deleteCategory, deleteNote, getSettings, listNotes, renameCategory, setSettings, undoDelete, updateNote, type Note, type NotesSettings } from './api'
import { NoteEditor } from './Editor'
import { excerpt, shortTime, timeGroup } from './util'
import './style.css'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function Notes() {
	const { basePath, setTitle } = useApp()
	const path = useAppPath()
	const query = useQuery()
	const [notes, setNotes] = useState<Note[] | null>(null)
	const [settings, setSettingsState] = useState<NotesSettings | null>(null)
	const [search, setSearch] = useState(query.get('q') ?? '')
	const q = useDebounced(search.trim().toLowerCase(), 150)
	const [settingsOpen, setSettingsOpen] = useState(false)
	const [catDialog, setCatDialog] = useState<{ old: string, name: string } | null>(null)
	/** Notes whose title follows their first line (new ones, until renamed by hand). */
	const autoTitle = useRef(new Set<number>())
	/** The open note has edits not yet on the server: a reload must not overwrite them. */
	const dirty = useRef<number | null>(null)

	const seg = path.split('/').filter(Boolean)
	const noteId = seg[0] === 'note' && /^\d+$/.test(seg[1] ?? '') ? Number(seg[1]) : null
	const category = query.has('category') ? query.get('category') ?? '' : null
	const favorites = query.get('favorites') === '1'
	const filterQs = category !== null ? `?category=${encodeURIComponent(category)}` : favorites ? '?favorites=1' : ''

	const load = useCallback(async () => {
		try {
			const fresh = await listNotes()
			setNotes((old) => {
				if (!old || dirty.current === null) return fresh
				// Keep the local copy of the note being edited.
				const mine = old.find((n) => n.id === dirty.current)
				return mine ? fresh.map((n) => (n.id === mine.id ? mine : n)) : fresh
			})
		} catch (e) {
			toast.error(`Could not load notes: ${errText(e)}`)
			setNotes((n) => n ?? [])
		}
	}, [])
	useEffect(() => { load(); getSettings().then(setSettingsState, () => {}) }, [load])
	useEffect(() => {
		const onVis = () => { if (!document.hidden) load() }
		document.addEventListener('visibilitychange', onVis)
		return () => document.removeEventListener('visibilitychange', onVis)
	}, [load])

	const replace = useCallback((n: Note) => setNotes((ns) => (ns ?? []).map((x) => (x.id === n.id ? n : x))), [])

	const newNote = useCallback(async (cat = category ?? '') => {
		try {
			const n = await createNote({ category: cat })
			autoTitle.current.add(n.id)
			setNotes((ns) => [n, ...(ns ?? [])])
			navigate(`${basePath}/note/${n.id}${cat ? `?category=${encodeURIComponent(cat)}` : ''}`)
		} catch (e) { toast.error(`Could not create a note: ${errText(e)}`) }
	}, [basePath, category])

	// Classic entry points.
	useEffect(() => {
		if (seg[0] === 'new') newNote(query.get('category') ?? '')
		else if (seg[0] === 'welcome') navigate(basePath, { replace: true })
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [seg[0]])

	const remove = async (n: Note) => {
		try {
			await deleteNote(n.id)
			setNotes((ns) => (ns ?? []).filter((x) => x.id !== n.id))
			if (noteId === n.id) navigate(`${basePath}${filterQs}`)
			toast(`Deleted ${n.title}`, { action: { label: 'Undo', onClick: async () => {
				try { const r = await undoDelete(n); setNotes((ns) => [r, ...(ns ?? []).filter((x) => x.id !== r.id)]) } catch (e) { toast.error(errText(e)) }
			} } })
		} catch (e) { toast.error(`Could not delete: ${errText(e)}`) }
	}
	const toggleFavorite = async (n: Note) => {
		replace({ ...n, favorite: !n.favorite })
		try { replace(await updateNote(n.id, { favorite: !n.favorite })) } catch (e) { replace(n); toast.error(errText(e)) }
	}

	// Categories with counts; a sub-category also counts towards its parents.
	const categories = useMemo(() => {
		const c = new Map<string, number>()
		for (const n of notes ?? []) {
			if (!n.category) continue
			const parts = n.category.split('/')
			for (let i = 1; i <= parts.length; i++) {
				const k = parts.slice(0, i).join('/')
				c.set(k, (c.get(k) ?? 0) + 1)
			}
		}
		return [...c.entries()].sort((a, b) => a[0].localeCompare(b[0]))
	}, [notes])
	const uncategorized = (notes ?? []).filter((n) => !n.category).length

	const visible = useMemo(() => {
		let ns = notes ?? []
		if (favorites) ns = ns.filter((n) => n.favorite)
		else if (category === '') ns = ns.filter((n) => !n.category)
		else if (category !== null) ns = ns.filter((n) => n.category === category || n.category.startsWith(category + '/'))
		if (q) ns = ns.filter((n) => `${n.title}\n${n.category}\n${n.content ?? ''}`.toLowerCase().includes(q))
		// Favourites first, then newest (like the classic app).
		return [...ns].sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.modified - a.modified)
	}, [notes, favorites, category, q])

	const heading = favorites ? 'Favorites' : category === '' ? 'Uncategorized' : category ?? 'All notes'
	const selected = noteId !== null ? notes?.find((n) => n.id === noteId) ?? null : null
	useEffect(() => { setTitle(selected ? `${selected.title} - Notes` : heading === 'All notes' ? 'Notes' : `${heading} - Notes`) }, [selected?.title, heading, setTitle])

	const go = (qs: string) => navigate(`${basePath}${qs}`)
	async function submitCategory() {
		if (!catDialog) return
		const name = catDialog.name.trim().replace(/^\/+|\/+$/g, '')
		if (!name || name === catDialog.old) { setCatDialog(null); return }
		try {
			await renameCategory(catDialog.old, name)
			setCatDialog(null)
			if (category === catDialog.old) go(`?category=${encodeURIComponent(name)}`)
			load()
		} catch (e) { toast.error(`Could not rename: ${errText(e)}`) }
	}
	async function removeCategory(c: string, count: number) {
		if (!await confirmDialog(`Delete the category "${c}" and its ${count} note${count === 1 ? '' : 's'}? They go to Deleted files.`, { title: 'Delete category', confirm: 'Delete', danger: true })) return
		try { await deleteCategory(c); if (category === c) go(''); load() } catch (e) { toast.error(errText(e)) }
	}

	const nav = (
		<>
			<div className="nt-nav-new"><Button icon="add" block onClick={() => newNote()}>New note</Button></div>
			<NavSection>
				<NavItem icon="notes" label="All notes" count={notes?.length} active={category === null && !favorites} href={basePath} onClick={() => go('')} />
				<NavItem icon="star" label="Favorites" count={(notes ?? []).filter((n) => n.favorite).length} active={favorites} href={`${basePath}?favorites=1`} onClick={() => go('?favorites=1')} />
			</NavSection>
			<NavSection title="Categories" id="notes-categories" collapsible>
				{categories.map(([c, count]) => {
					const depth = c.split('/').length - 1
					return (
						<div key={c} className="nt-cat" style={{ ['--depth' as string]: depth }}>
							<NavItem icon="folder" label={c.split('/').pop()!} count={count} active={category === c}
								href={`${basePath}?category=${encodeURIComponent(c)}`} onClick={() => go(`?category=${encodeURIComponent(c)}`)}
								actions={
									<span className="nt-nav-menu" onClick={(e) => { e.stopPropagation(); e.preventDefault() }}>
										<Menu trigger={(o, x) => <IconButton icon="moreVert" label={`${c} actions`} aria-expanded={x} onClick={o} />} items={[
											{ label: 'New note here', icon: 'add', onClick: () => newNote(c) },
											{ label: 'Rename', icon: 'edit', onClick: () => setCatDialog({ old: c, name: c }) },
											{ label: 'Delete', icon: 'delete', danger: true, onClick: () => removeCategory(c, count) },
										]} />
									</span>
								} />
						</div>
					)
				})}
				{uncategorized > 0 && categories.length > 0 && <NavItem icon="description" label="Uncategorized" count={uncategorized} active={category === ''} href={`${basePath}?category=`} onClick={() => go('?category=')} />}
				{categories.length === 0 && <p className="nt-nav-hint">Give a note a category to group it here.</p>}
			</NavSection>
			<NavSection>
				<NavItem icon="settings" label="Notes settings" onClick={() => setSettingsOpen(true)} />
			</NavSection>
		</>
	)

	return (
		<AppLayout nav={nav}>
			<div className={'nt' + (noteId !== null ? ' nt--note' : '')}>
				<section className="nt-list" aria-label="Notes">
					<header className="nt-head">
						<NavToggle />
						<h1 className="nt-title">{heading}</h1>
						<IconButton icon="add" label="New note" onClick={() => newNote()} />
					</header>
					<div className="nt-search"><SearchBar value={search} onChange={setSearch} placeholder="Search notes" /></div>
					{notes === null ? <div className="nt-center"><Spinner /></div>
						: visible.length === 0 ? (
							<EmptyState icon={q ? 'search' : 'notes'} title={q ? 'No notes match your search' : favorites ? 'No favorites yet' : 'No notes yet'}>
								{!q && !favorites && <Button variant="tonal" onClick={() => newNote()}>New note</Button>}
							</EmptyState>
						) : <NoteList notes={visible} grouped={!q} selected={noteId} showCategory={category === null} basePath={basePath} qs={filterQs} onFavorite={toggleFavorite} onDelete={remove} />}
				</section>
				<section className="nt-pane">
					{noteId === null ? <EmptyState icon="notes" title={notes?.length ? 'Select a note' : 'Write your first note'}><Button variant="tonal" onClick={() => newNote()}>New note</Button></EmptyState>
						: !notes ? <div className="nt-center"><Spinner /></div>
						: !selected ? <EmptyState icon="warning" title="This note does not exist (any more)"><Button variant="tonal" onClick={() => go(filterQs)}>Back to the list</Button></EmptyState>
						: <NoteEditor key={selected.id} note={selected} categories={categories.map(([c]) => c)} autoTitle={autoTitle.current}
							previewDefault={settings?.noteMode === 'preview'}
							onChange={replace} onDirty={(d) => { dirty.current = d ? selected.id : null }}
							onBack={() => go(filterQs)} onFavorite={() => toggleFavorite(selected)} onDelete={() => remove(selected)} />}
				</section>
			</div>

			<Dialog open={!!catDialog} title="Rename category" onClose={() => setCatDialog(null)}
				actions={<><Button variant="text" onClick={() => setCatDialog(null)}>Cancel</Button><Button disabled={!catDialog?.name.trim()} onClick={submitCategory}>Rename</Button></>}>
				<form className="nt-dlg" onSubmit={(e) => { e.preventDefault(); submitCategory() }}>
					<TextField label="Name" hint="Use / for a sub-category, e.g. Work/Meetings" autoFocus value={catDialog?.name ?? ''} onChange={(e) => setCatDialog((d) => d && { ...d, name: e.target.value })} />
				</form>
			</Dialog>
			{settingsOpen && settings && <SettingsDialog settings={settings} onClose={() => setSettingsOpen(false)} onSaved={(s) => { setSettingsState(s); setSettingsOpen(false); load() }} />}
		</AppLayout>
	)
}

function NoteList({ notes, grouped, selected, showCategory, basePath, qs, onFavorite, onDelete }: {
	notes: Note[], grouped: boolean, selected: number | null, showCategory: boolean, basePath: string, qs: string
	onFavorite: (n: Note) => void, onDelete: (n: Note) => void
}) {
	const groups: { label: string, notes: Note[] }[] = []
	for (const n of notes) {
		const label = !grouped ? '' : n.favorite ? 'Favorites' : timeGroup(n.modified)
		const last = groups[groups.length - 1]
		if (last && last.label === label) last.notes.push(n)
		else groups.push({ label, notes: [n] })
	}
	return (
		<div className="nt-groups">
			{groups.map((g, i) => (
				<div key={g.label + i} className="nt-group">
					{g.label && <h2 className="nt-group__label">{g.label}</h2>}
					<ul className="nt-rows">
						{g.notes.map((n) => {
							const href = `${basePath}/note/${n.id}${qs}`
							return (
								<li key={n.id} className={'nt-row' + (n.id === selected ? ' nt-row--sel' : '')}>
									<a className="nt-row__main" href={href} aria-current={n.id === selected ? 'page' : undefined} onClick={(e) => { if (e.button || e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(href) }}>
										<span className="nt-row__top">
											<span className="nt-row__title">{n.title}</span>
											<span className="nt-row__time">{shortTime(n.modified)}</span>
										</span>
										<span className="nt-row__excerpt">{excerpt(n) || <span className="nt-muted">No additional text</span>}</span>
										{showCategory && n.category && <span className="nt-chip"><Icon name="folder" size="s" />{n.category}</span>}
									</a>
									<span className="nt-row__actions">
										<IconButton className={'nt-star' + (n.favorite ? ' nt-star--on' : '')} icon={n.favorite ? 'star' : 'starBorder'} label={n.favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={() => onFavorite(n)} />
										{!n.readonly && <Menu trigger={(o, x) => <IconButton icon="moreVert" label={`${n.title} actions`} aria-expanded={x} onClick={o} />} items={[
											{ label: 'Delete', icon: 'delete', danger: true, onClick: () => onDelete(n) },
										]} />}
									</span>
								</li>
							)
						})}
					</ul>
				</div>
			))}
		</div>
	)
}

function SettingsDialog({ settings, onClose, onSaved }: { settings: NotesSettings, onClose: () => void, onSaved: (s: NotesSettings) => void }) {
	const [s, setS] = useState(settings)
	const [busy, setBusy] = useState(false)
	const save = async () => {
		setBusy(true)
		try { onSaved(await setSettings({ notesPath: s.notesPath, fileSuffix: s.fileSuffix, customSuffix: s.customSuffix, noteMode: s.noteMode === 'rich' ? 'edit' : s.noteMode })) } catch (e) { toast.error(`Could not save: ${errText(e)}`) } finally { setBusy(false) }
	}
	return (
		<Dialog open title="Notes settings" onClose={onClose}
			actions={<><Button variant="text" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={save}>Save</Button></>}>
			<form className="nt-dlg" onSubmit={(e) => { e.preventDefault(); save() }}>
				<TextField label="Folder" hint="Where your notes are stored in Files" value={s.notesPath} onChange={(e) => setS({ ...s, notesPath: e.target.value })} />
				<Select label="File type for new notes" value={s.fileSuffix} onChange={(e) => setS({ ...s, fileSuffix: e.target.value })}>
					<option value=".md">Markdown (.md)</option>
					<option value=".txt">Plain text (.txt)</option>
					<option value="custom">Other…</option>
				</Select>
				{s.fileSuffix === 'custom' && <TextField label="Extension" value={s.customSuffix ?? '.md'} onChange={(e) => setS({ ...s, customSuffix: e.target.value })} />}
				<Select label="Open notes in" value={s.noteMode === 'preview' ? 'preview' : 'edit'} onChange={(e) => setS({ ...s, noteMode: e.target.value as NotesSettings['noteMode'] })}>
					<option value="edit">Edit mode</option>
					<option value="preview">Preview mode</option>
				</Select>
			</form>
		</Dialog>
	)
}

export default defineApp({ Component: Notes })
