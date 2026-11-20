// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Files for the Atrium shell, over WebDAV. Routes below /apps/files (upstream-compatible):
//   /files?dir=/a/b               folder          /files/<fileid>?dir=..&openfile=true   viewer
//   /favorites /recent /sharingin /sharingout /trashbin /search?q=
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defineApp, formatBytes, formatDate, navigate, relativeTime, splitBySize, useApp, useAppPath, useQuery } from '@atrium/sdk'
import { AppLayout, Button, Checkbox, Dialog, EmptyState, Icon, IconButton, Menu, NavItem, NavSection, NavToggle, Progress, SearchBar, Spinner, TextField, confirmDialog, toast, type MenuEntry } from '@atrium/ui'
import {
	copy, downloadUrl, emptyTrash, favorites, freeName, join, listDir, listTrash, mkdir, move, parentOf, purgeTrash, quota, recent, remove, restoreTrash,
	searchName, setFavorite, sharedByMe, sharedWithMe, stat, uploadFile, zipUrl, type Node, type TrashItem,
} from './api'
import { Crumbs, FolderPicker, ShareDialog, Thumb, Viewer, errText, viewable } from './parts'
import './style.css'

type View = 'files' | 'favorites' | 'recent' | 'sharingin' | 'sharingout' | 'trashbin' | 'search'
const VIEWS: { id: View, label: string, icon: string }[] = [
	{ id: 'files', label: 'All files', icon: 'folder' }, { id: 'recent', label: 'Recent', icon: 'schedule' }, { id: 'favorites', label: 'Favorites', icon: 'star' },
	{ id: 'sharingin', label: 'Shared with you', icon: 'share' }, { id: 'sharingout', label: 'Shared by you', icon: 'link' },
]
type SortKey = 'name' | 'size' | 'mtime'
interface Upload { id: number, name: string, progress: number, error?: string, done?: boolean }
const DRAG_TYPE = 'application/x-atrium-files'

function load<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } }
function save(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } }

function Files() {
	const { basePath, session, setTitle } = useApp()
	const user = session.user.id
	const path = useAppPath()
	const query = useQuery()
	const seg = path.split('/').filter(Boolean)
	const view: View = (['favorites', 'recent', 'sharingin', 'sharingout', 'trashbin', 'search'] as View[]).includes(seg[0] as View) ? seg[0] as View : 'files'
	const openId = seg[1] && /^\d+$/.test(seg[1]) && (query.get('openfile') ?? 'true') !== 'false' ? Number(seg[1]) : null
	const dir = (query.get('dir') || '/').replace(/\/+$/, '') || '/'
	const q = query.get('q') ?? ''

	const [nodes, setNodes] = useState<Node[] | null>(null)
	const [self, setSelf] = useState<Node | null>(null)
	const [trash, setTrash] = useState<TrashItem[] | null>(null)
	const [selected, setSelected] = useState<Set<string>>(new Set())
	const [sort, setSort] = useState<{ key: SortKey, asc: boolean }>(() => load('atrium.files.sort', { key: 'name', asc: true }))
	const [grid, setGrid] = useState<boolean>(() => load('atrium.files.grid', false))
	const [filter, setFilter] = useState('')
	const [nameDialog, setNameDialog] = useState<{ kind: 'folder' | 'file' | 'rename', node?: Node, value: string } | null>(null)
	const [picker, setPicker] = useState<Node[] | null>(null)
	const [sharing, setSharing] = useState<Node | null>(null)
	const [uploads, setUploads] = useState<Upload[]>([])
	const [conflict, setConflict] = useState<{ name: string, resolve: (r: { choice: 'replace' | 'keep' | 'skip', all: boolean }) => void } | null>(null)
	const [dragging, setDragging] = useState(false)
	const [usage, setUsage] = useState<{ used: number, free: number } | null>(null)
	const lastClicked = useRef<number>(-1)
	const fileInput = useRef<HTMLInputElement>(null)

	const go = (to: string) => navigate(`${basePath}${to}`)
	const openDir = (d: string) => go(`/files?dir=${encodeURIComponent(d)}`)

	// Old links: /apps/files/?dir=..&fileid=.. and the /apps/files/ root.
	useEffect(() => {
		if (seg.length === 0) navigate(`${basePath}/files${location.search}`, { replace: true })
		else if (seg[0] === 'files' && !seg[1] && query.get('fileid') && query.get('openfile')) navigate(`${basePath}/files/${query.get('fileid')}${location.search}`, { replace: true })
	}, [seg.length]) // eslint-disable-line react-hooks/exhaustive-deps

	const reload = useCallback(async () => {
		try {
			if (view === 'trashbin') { setTrash(await listTrash(user)); return }
			let list: Node[]
			let me: Node | null = null
			if (view === 'files') ({ self: me, children: list } = await listDir(user, dir))
			else if (view === 'favorites') list = await favorites(user)
			else if (view === 'recent') list = await recent(user)
			else if (view === 'search') list = q.trim() ? await searchName(user, q.trim()) : []
			else {
				const shares = await (view === 'sharingin' ? sharedWithMe() : sharedByMe())
				const paths = [...new Set(shares.map((s) => (view === 'sharingin' ? s.file_target : s.path)))]
				list = (await Promise.all(paths.map((p) => stat(user, p).catch(() => null)))).filter((n): n is Node => !!n)
			}
			setSelf(me)
			setNodes(list)
		} catch (e) {
			toast.error(`Could not load: ${errText(e)}`)
			setNodes((n) => n ?? [])
			setTrash((t) => t ?? [])
		}
	}, [user, view, dir, q])
	useEffect(() => { setNodes(null); setTrash(null); setSelected(new Set()); setFilter(''); reload() }, [reload])
	useEffect(() => { quota(user).then(setUsage, () => {}) }, [user, nodes])

	// The selected file was opened by id but lives elsewhere (e.g. a /f/<id> link from search).
	useEffect(() => {
		if (!openId || !nodes || nodes.some((n) => n.id === openId) || view !== 'files') return
		toast.error('That file is not in this folder any more')
	}, [openId, nodes, view])

	const title = view === 'files' ? (dir === '/' ? 'All files' : dir.split('/').pop()!) : view === 'trashbin' ? 'Deleted files' : view === 'search' ? `Search: ${q}` : VIEWS.find((v) => v.id === view)!.label
	useEffect(() => { setTitle(`${title} - Files`) }, [title, setTitle])

	const sorted = useMemo(() => {
		const f = filter.trim().toLowerCase()
		const list = (nodes ?? []).filter((n) => !f || n.name.toLowerCase().includes(f))
		const dirFirst = (a: Node, b: Node) => Number(b.dir) - Number(a.dir)
		const by = (a: Node, b: Node) => sort.key === 'size' ? a.size - b.size : sort.key === 'mtime' ? a.mtime.getTime() - b.mtime.getTime() : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
		return [...list].sort((a, b) => (view === 'recent' && sort.key === 'name' && !filter ? b.mtime.getTime() - a.mtime.getTime() : dirFirst(a, b) || (sort.asc ? by(a, b) : by(b, a))))
	}, [nodes, filter, sort, view])

	const canCreate = view === 'files' && (!self || /[CK]/.test(self.perms) || dir === '/')
	const viewing = openId ? sorted.find((n) => n.id === openId) ?? null : null
	const sel = sorted.filter((n) => selected.has(n.path))
	const setSortKey = (key: SortKey) => setSort((s) => { const n = { key, asc: s.key === key ? !s.asc : key === 'name' }; save('atrium.files.sort', n); return n })
	const qs = () => location.search.replace(/[?&]openfile=[^&]*/, '').replace(/^&/, '?')

	function open(n: Node) {
		if (n.dir) return openDir(n.path)
		if (viewable(n)) {
			const params = new URLSearchParams(location.search)
			if (view === 'files') params.set('dir', dir)
			params.set('openfile', 'true')
			navigate(`${basePath}/${view}/${n.id}?${params}`)
		} else location.href = downloadUrl(n)
	}
	const closeViewer = () => navigate(`${basePath}/${view}${qs().replace(/[?&]openfile=true/, '')}`)

	// ---------------------------------------------------------------- actions
	const run = async <T,>(p: Promise<T>, ok?: string): Promise<T | undefined> => {
		try { const r = await p; if (ok) toast(ok); return r } catch (e) { toast.error(errText(e)); return undefined } finally { reload() }
	}

	async function submitName() {
		if (!nameDialog) return
		const name = nameDialog.value.trim()
		if (!name || /[/\\]/.test(name) || name === '.' || name === '..') return toast.error('That name is not allowed')
		const d = nameDialog
		setNameDialog(null)
		if (d.kind === 'rename' && d.node) {
			if (name === d.node.name) return
			await run(move(user, d.node.path, join(parentOf(d.node.path), name)))
		} else if (d.kind === 'folder') {
			await run(mkdir(user, join(dir, name)))
		} else {
			const f = new File([''], name, { type: 'text/plain' })
			await run(uploadFile(user, join(dir, name), f))
			const n = await stat(user, join(dir, name)).catch(() => null)
			if (n) open(n)
		}
	}

	async function del(list: Node[]) {
		if (!list.length) return
		if (list.length > 1 && !await confirmDialog(`Delete ${list.length} items?`, { title: 'Delete', confirm: 'Delete', danger: true })) return
		const done: Node[] = []
		for (const n of list) { try { await remove(user, n.path); done.push(n) } catch (e) { toast.error(`${n.name}: ${errText(e)}`) } }
		setSelected(new Set())
		reload()
		if (!done.length) return
		toast(done.length === 1 ? `Deleted ${done[0].name}` : `Deleted ${done.length} items`, { action: { label: 'Undo', onClick: async () => {
			try {
				const items = await listTrash(user)
				for (const n of done) {
					const t = items.find((i) => '/' + i.original === n.path)
					if (t) await restoreTrash(user, t)
				}
			} catch (e) { toast.error(errText(e)) }
			reload()
		} } })
	}

	async function transfer(list: Node[], target: string, mode: 'move' | 'copy') {
		setPicker(null)
		let taken: Set<string> | null = null
		for (const n of list) {
			let name = n.name
			if (mode === 'copy' && parentOf(n.path) === target) {
				taken ??= new Set((await listDir(user, target)).children.map((c) => c.name))
				name = freeName(n.name, taken)
				taken.add(name)
			}
			try { await (mode === 'move' ? move : copy)(user, n.path, join(target, name)) } catch (e) {
				toast.error(/412|exists/i.test(errText(e)) ? `${n.name} already exists in that folder` : `${n.name}: ${errText(e)}`)
			}
		}
		setSelected(new Set())
		toast(`${mode === 'move' ? 'Moved' : 'Copied'} ${list.length === 1 ? list[0].name : `${list.length} items`} to ${target === '/' ? 'All files' : target.split('/').pop()}`)
		reload()
	}

	const toggleFav = (n: Node) => run(setFavorite(n, !n.favorite))

	// ---------------------------------------------------------------- uploads
	const askConflict = (name: string) => new Promise<{ choice: 'replace' | 'keep' | 'skip', all: boolean }>((resolve) => setConflict({ name, resolve }))

	/** Upload files (with relative paths for dropped folders) into `target`. */
	async function uploadAll(items: { file: File, rel: string }[], target = dir) {
		if (!items.length) return
		// Refuse what cannot fit before sending it (V4-1): bigger than the free space left.
		const free = usage && usage.free >= 0 ? usage.free : null
		const { ok, tooBig } = splitBySize(items.map((i) => ({ ...i, size: i.file.size })), free)
		if (tooBig.length) {
			toast.error(`${tooBig.length === 1 ? `"${tooBig[0].file.name}" (${formatBytes(tooBig[0].size)})` : `${tooBig.length} files`} would not fit: ${formatBytes(free ?? 0)} left in your storage.`)
			items = ok
			if (!items.length) return
		}
		const existing = new Set((nodes ?? []).map((n) => n.name))
		let policy: 'replace' | 'keep' | 'skip' | null = null
		const madeDirs = new Set<string>()
		const queue: { file: File, dest: string, id: number }[] = []
		for (const { file, rel } of items) {
			const parts = rel.split('/').filter(Boolean)
			let top = parts[0]
			if (target === dir && existing.has(top) && !(parts.length > 1 && nodes?.find((n) => n.name === top)?.dir)) {
				let choice = policy
				if (!choice) { const r = await askConflict(top); choice = r.choice; if (r.all) policy = r.choice }
				setConflict(null)
				if (choice === 'skip') continue
				if (choice === 'keep') { top = freeName(top, existing); existing.add(top) }
			}
			parts[0] = top
			// Folders of a dropped tree.
			for (let i = 1; i < parts.length; i++) {
				const d = join(target, parts.slice(0, i).join('/'))
				if (!madeDirs.has(d)) { madeDirs.add(d); await mkdir(user, d).catch(() => {}) }
			}
			queue.push({ file, dest: join(target, parts.join('/')), id: Math.random() })
		}
		setUploads((u) => [...u.filter((x) => !x.done), ...queue.map((q) => ({ id: q.id, name: q.file.name, progress: 0 }))])
		const upd = (id: number, p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...p } : x)))
		let next = 0
		const worker = async () => {
			while (next < queue.length) {
				const job = queue[next++]
				try { await uploadFile(user, job.dest, job.file, (f) => upd(job.id, { progress: f })); upd(job.id, { progress: 1, done: true }) } catch (e) { upd(job.id, { error: errText(e), done: true }) }
			}
		}
		await Promise.all([worker(), worker(), worker()])
		reload()
		setTimeout(() => setUploads((u) => u.filter((x) => !x.done || x.error)), 4000)
	}

	async function filesFromDrop(dt: DataTransfer): Promise<{ file: File, rel: string }[]> {
		const out: { file: File, rel: string }[] = []
		const entries = Array.from(dt.items).map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e)
		const walk = async (e: FileSystemEntry, prefix: string): Promise<void> => {
			if (e.isFile) out.push({ file: await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)), rel: prefix + e.name })
			else if (e.isDirectory) {
				const reader = (e as FileSystemDirectoryEntry).createReader()
				let batch: FileSystemEntry[]
				do {
					batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
					for (const c of batch) await walk(c, `${prefix}${e.name}/`)
				} while (batch.length)
			}
		}
		if (entries.length) for (const e of entries) await walk(e, '')
		else for (const f of Array.from(dt.files)) out.push({ file: f, rel: f.name })
		return out
	}

	const onDropZone = async (e: React.DragEvent) => {
		e.preventDefault()
		setDragging(false)
		if (e.dataTransfer.types.includes(DRAG_TYPE) || !canCreate) return
		uploadAll(await filesFromDrop(e.dataTransfer))
	}
	const dropOnFolder = (target: string) => async (e: React.DragEvent) => {
		e.preventDefault()
		e.stopPropagation()
		setDragging(false)
		const raw = e.dataTransfer.getData(DRAG_TYPE)
		if (raw) {
			const paths: string[] = JSON.parse(raw)
			const list = (nodes ?? []).filter((n) => paths.includes(n.path) && n.path !== target && !target.startsWith(n.path + '/'))
			if (list.length) transfer(list, target, 'move')
		} else uploadAll(await filesFromDrop(e.dataTransfer), target)
	}

	// ---------------------------------------------------------------- selection
	const toggle = (n: Node, i: number, shift: boolean) => setSelected((s) => {
		const next = new Set(s)
		if (shift && lastClicked.current >= 0) {
			const [a, b] = [Math.min(lastClicked.current, i), Math.max(lastClicked.current, i)]
			for (let k = a; k <= b; k++) next.add(sorted[k].path)
		} else if (next.has(n.path)) next.delete(n.path)
		else next.add(n.path)
		lastClicked.current = i
		return next
	})

	const actions = (n: Node): (MenuEntry | false)[] => [
		!n.dir && viewable(n) && { label: 'Open', icon: 'openInNew', onClick: () => open(n) },
		{ label: n.dir ? 'Download as zip' : 'Download', icon: 'download', href: downloadUrl(n) },
		view !== 'files' && { label: 'Show in folder', icon: 'folder', onClick: () => openDir(n.dir ? n.path : parentOf(n.path)) },
		{ label: n.favorite ? 'Remove from favorites' : 'Add to favorites', icon: n.favorite ? 'starBorder' : 'star', onClick: () => toggleFav(n) },
		n.perms.includes('R') && { label: 'Share', icon: 'share', onClick: () => setSharing(n) },
		n.perms.includes('N') && { label: 'Rename', icon: 'edit', onClick: () => setNameDialog({ kind: 'rename', node: n, value: n.name }) },
		{ label: 'Move or copy', icon: 'driveFileMove', onClick: () => setPicker([n]) },
		n.perms.includes('D') && { label: 'Delete', icon: 'delete', danger: true, onClick: () => del([n]) },
	]

	// ---------------------------------------------------------------- render
	const nav = (
		<>
			<NavSection>
				{VIEWS.map((v) => <NavItem key={v.id} icon={v.icon} label={v.label} active={view === v.id} href={`${basePath}/${v.id}`} onClick={() => go(`/${v.id}`)} />)}
			</NavSection>
			<div className="fl-nav-fill" />
			<NavSection>
				<NavItem icon="delete" label="Deleted files" active={view === 'trashbin'} href={`${basePath}/trashbin`} onClick={() => go('/trashbin')} />
				{usage && (
					<div className="fl-quota">
						{usage.free >= 0 && <Progress value={usage.used / Math.max(1, usage.used + usage.free)} />}
						<span>{formatBytes(usage.used)} used{usage.free >= 0 ? ` of ${formatBytes(usage.used + usage.free)}` : ''}</span>
					</div>
				)}
			</NavSection>
		</>
	)

	const sortHead = (key: SortKey, label: string, cls: string) => (
		<button type="button" className={`fl-th ${cls}` + (sort.key === key ? ' fl-th--on' : '')} onClick={() => setSortKey(key)} aria-sort={sort.key === key ? (sort.asc ? 'ascending' : 'descending') : undefined}>
			{label}{sort.key === key && <Icon name={sort.asc ? 'arrowUp' : 'arrowDown'} size="s" />}
		</button>
	)

	return (
		<AppLayout nav={nav}>
			<div className={'fl' + (dragging ? ' fl--drag' : '')}
				onDragOver={(e) => { if (canCreate && !e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setDragging(true) } }}
				onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node)) setDragging(false) }}
				onDrop={onDropZone}>
				<header className="fl-head">
					<NavToggle />
					{sel.length > 0 ? (
						<div className="fl-selbar">
							<IconButton icon="close" label="Clear selection" onClick={() => setSelected(new Set())} />
							<span className="fl-selbar__count">{sel.length} selected</span>
							{view === 'files' && <a className="at-btn at-btn--text" href={zipUrl(user, dir, sel.map((n) => n.name))}><Icon name="download" />Download</a>}
							<Button variant="text" icon="driveFileMove" onClick={() => setPicker(sel)}>Move or copy</Button>
							{sel.every((n) => n.perms.includes('D')) && <Button variant="text" icon="delete" onClick={() => del(sel)}>Delete</Button>}
						</div>
					) : view === 'files' ? <Crumbs dir={dir} onGo={openDir} onDropTo={(d, e) => dropOnFolder(d)(e)} />
						: <h1 className="fl-title">{title}</h1>}
					<span className="fl-head__fill" />
					{view !== 'trashbin' && sel.length === 0 && (
						<>
							<form className="fl-search" onSubmit={(e) => { e.preventDefault(); if (filter.trim()) go(`/search?q=${encodeURIComponent(filter.trim())}`) }}>
								<SearchBar value={filter} onChange={setFilter} placeholder={view === 'search' ? 'Filter results' : 'Filter, Enter searches everywhere'} />
							</form>
							<IconButton icon={grid ? 'listView' : 'gridView'} label={grid ? 'List view' : 'Grid view'} onClick={() => { setGrid(!grid); save('atrium.files.grid', !grid) }} />
						</>
					)}
					{canCreate && sel.length === 0 && (
						<Menu trigger={(o) => <Button icon="add" onClick={o}>New</Button>} items={[
							{ label: 'Upload files', icon: 'upload', onClick: () => fileInput.current?.click() },
							{ label: 'New folder', icon: 'newFolder', onClick: () => setNameDialog({ kind: 'folder', value: freeName('New folder', new Set((nodes ?? []).map((n) => n.name))) }) },
							{ label: 'New text file', icon: 'description', onClick: () => setNameDialog({ kind: 'file', value: freeName('New text file.md', new Set((nodes ?? []).map((n) => n.name))) }) },
						]} />
					)}
					{view === 'trashbin' && (trash?.length ?? 0) > 0 && (
						<Button variant="text" icon="delete" onClick={async () => { if (await confirmDialog('Permanently delete everything in the trash?', { title: 'Empty trash', confirm: 'Empty trash', danger: true })) run(emptyTrash(user), 'Trash emptied') }}>Empty trash</Button>
					)}
					<input ref={fileInput} type="file" multiple hidden onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; uploadAll(fs.map((f) => ({ file: f, rel: f.name }))) }} />
				</header>

				<div className="fl-body">
					{view === 'trashbin' ? <TrashList items={trash} onRestore={(t) => run(restoreTrash(user, t), `Restored ${t.name}`)} onPurge={(t) => run(purgeTrash(t))} />
						: nodes === null ? <div className="fl-center"><Spinner /></div>
						: sorted.length === 0 ? (
							<EmptyState icon={view === 'favorites' ? 'star' : view === 'search' ? 'search' : view.startsWith('sharing') ? 'share' : 'folder'}
								title={filter ? 'No matches' : view === 'files' ? 'This folder is empty' : view === 'favorites' ? 'No favorites yet' : view === 'search' ? (q ? 'Nothing found' : 'Type to search') : 'Nothing here yet'}>
								{canCreate && !filter && 'Drop files here or use New.'}
							</EmptyState>
						) : grid ? (
							<ul className="fl-grid">
								{sorted.map((n, i) => (
									<li key={n.path} className={'fl-card' + (selected.has(n.path) ? ' fl-card--sel' : '')} draggable
										onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(selected.has(n.path) ? [...selected] : [n.path]))}
										onDragOver={n.dir ? (e) => { e.preventDefault(); e.currentTarget.classList.add('fl-drop') } : undefined}
										onDragLeave={(e) => e.currentTarget.classList.remove('fl-drop')}
										onDrop={n.dir ? (e) => { e.currentTarget.classList.remove('fl-drop'); dropOnFolder(n.path)(e) } : undefined}>
										<Checkbox className="fl-card__check" checked={selected.has(n.path)} onChange={() => {}} onClick={(e) => toggle(n, i, e.shiftKey)} aria-label={`Select ${n.name}`} />
										<button type="button" className="fl-card__open" onClick={() => open(n)}><Thumb node={n} size={120} /></button>
										<div className="fl-card__foot">
											<button type="button" className="fl-card__name" onClick={() => open(n)} title={n.name}>{n.favorite && <Icon name="star" size="s" className="fl-fav" />}{n.name}</button>
											<Menu trigger={(o, x) => <IconButton icon="moreVert" label={`${n.name} actions`} aria-expanded={x} onClick={o} />} items={actions(n)} />
										</div>
									</li>
								))}
							</ul>
						) : (
							<div className="fl-table" role="table">
								<div className="fl-tr fl-tr--head" role="row">
									<span className="fl-td fl-td--check"><Checkbox checked={sel.length > 0 && sel.length === sorted.length} onChange={(e) => setSelected(e.target.checked ? new Set(sorted.map((n) => n.path)) : new Set())} aria-label="Select all" /></span>
									{sortHead('name', 'Name', 'fl-td--name')}
									{sortHead('size', 'Size', 'fl-td--size')}
									{sortHead('mtime', 'Modified', 'fl-td--mtime')}
									<span className="fl-td fl-td--menu" />
								</div>
								{sorted.map((n, i) => (
									<div key={n.path} role="row" className={'fl-tr' + (selected.has(n.path) ? ' fl-tr--sel' : '') + (viewing?.path === n.path ? ' fl-tr--open' : '')} draggable
										onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(selected.has(n.path) ? [...selected] : [n.path]))}
										onDragOver={n.dir ? (e) => { e.preventDefault(); e.currentTarget.classList.add('fl-drop') } : undefined}
										onDragLeave={(e) => e.currentTarget.classList.remove('fl-drop')}
										onDrop={n.dir ? (e) => { e.currentTarget.classList.remove('fl-drop'); dropOnFolder(n.path)(e) } : undefined}>
										<span className="fl-td fl-td--check"><Checkbox checked={selected.has(n.path)} onChange={() => {}} onClick={(e) => toggle(n, i, e.shiftKey)} aria-label={`Select ${n.name}`} /></span>
										<button type="button" className="fl-td fl-td--name fl-name" onClick={() => open(n)}>
											<Thumb node={n} />
											<span className="fl-name__text">
												<span className="fl-name__title">{n.name}</span>
												{view !== 'files' && <span className="fl-name__sub">{parentOf(n.path) === '/' ? 'All files' : parentOf(n.path).slice(1)}</span>}
											</span>
											{n.favorite && <Icon name="star" size="s" className="fl-fav" />}
										</button>
										<span className="fl-td fl-td--size">{formatBytes(n.size)}</span>
										<span className="fl-td fl-td--mtime" title={formatDate(n.mtime, { dateStyle: 'full', timeStyle: 'short' })}>{relativeTime(n.mtime)}</span>
										<span className="fl-td fl-td--menu">
											{n.perms.includes('R') && <IconButton className="fl-quick" icon="share" label={`Share ${n.name}`} onClick={() => setSharing(n)} />}
											<Menu trigger={(o, x) => <IconButton icon="moreVert" label={`${n.name} actions`} aria-expanded={x} onClick={o} />} items={actions(n)} />
										</span>
									</div>
								))}
							</div>
						)}
				</div>
				{dragging && <div className="fl-dropzone"><Icon name="cloudUpload" size="l" /><span>Drop to upload to {dir === '/' ? 'All files' : dir.split('/').pop()}</span></div>}
			</div>

			{uploads.length > 0 && (
				<div className="fl-uploads" role="status">
					<div className="fl-uploads__head">
						<span>{uploads.every((u) => u.done) ? 'Uploads finished' : `Uploading ${uploads.filter((u) => !u.done).length} of ${uploads.length}`}</span>
						{uploads.every((u) => u.done) && <IconButton icon="close" label="Dismiss" onClick={() => setUploads([])} />}
					</div>
					{uploads.slice(-6).map((u) => (
						<div key={u.id} className={'fl-upload' + (u.error ? ' fl-upload--err' : '')}>
							<span className="fl-upload__name" title={u.error ?? u.name}>{u.name}{u.error && ` — ${u.error}`}</span>
							{!u.done ? <Progress value={u.progress} /> : <Icon name={u.error ? 'warning' : 'check'} size="s" />}
						</div>
					))}
				</div>
			)}

			{viewing && <Viewer node={viewing} list={sorted} onNavigate={open} onClose={closeViewer} canWrite={viewing.perms.includes('W')} onSaved={reload} />}

			<Dialog open={!!nameDialog} title={nameDialog?.kind === 'rename' ? 'Rename' : nameDialog?.kind === 'folder' ? 'New folder' : 'New text file'} onClose={() => setNameDialog(null)}
				actions={<><Button variant="text" onClick={() => setNameDialog(null)}>Cancel</Button><Button disabled={!nameDialog?.value.trim()} onClick={submitName}>{nameDialog?.kind === 'rename' ? 'Rename' : 'Create'}</Button></>}>
				<form onSubmit={(e) => { e.preventDefault(); submitName() }}>
					<TextField label="Name" autoFocus value={nameDialog?.value ?? ''} onChange={(e) => setNameDialog((d) => d && { ...d, value: e.target.value })}
						onFocus={(e) => { const v = e.target.value; const dot = nameDialog?.node?.dir || nameDialog?.kind === 'folder' ? -1 : v.lastIndexOf('.'); e.target.setSelectionRange(0, dot > 0 ? dot : v.length) }} />
				</form>
			</Dialog>

			<Dialog open={!!conflict} title="File already exists" onClose={() => conflict?.resolve({ choice: 'skip', all: false })}
				actions={<>
					<Button variant="text" onClick={() => conflict?.resolve({ choice: 'skip', all: (document.getElementById('fl-all') as HTMLInputElement)?.checked })}>Skip</Button>
					<Button variant="tonal" onClick={() => conflict?.resolve({ choice: 'keep', all: (document.getElementById('fl-all') as HTMLInputElement)?.checked })}>Keep both</Button>
					<Button onClick={() => conflict?.resolve({ choice: 'replace', all: (document.getElementById('fl-all') as HTMLInputElement)?.checked })}>Replace</Button>
				</>}>
				<p className="fl-conflict">“{conflict?.name}” is already in this folder.</p>
				<Checkbox id="fl-all" label="Do this for every conflict" />
			</Dialog>

			<FolderPicker open={!!picker} title={picker?.length === 1 ? `Move or copy “${picker[0].name}”` : `Move or copy ${picker?.length ?? 0} items`} start={view === 'files' ? dir : '/'}
				exclude={(picker ?? []).map((n) => n.path)} onClose={() => setPicker(null)} onPick={(d, mode) => picker && transfer(picker, d, mode)} />
			<ShareDialog node={sharing} onClose={() => setSharing(null)} onChanged={reload} />
		</AppLayout>
	)
}

function TrashList({ items, onRestore, onPurge }: { items: TrashItem[] | null, onRestore: (t: TrashItem) => void, onPurge: (t: TrashItem) => void }) {
	if (items === null) return <div className="fl-center"><Spinner /></div>
	if (items.length === 0) return <EmptyState icon="delete" title="No deleted files">Deleted files show up here and can be restored.</EmptyState>
	return (
		<div className="fl-table" role="table">
			<div className="fl-tr fl-tr--head fl-tr--trash" role="row"><span className="fl-th fl-td--name">Name</span><span className="fl-th fl-td--orig">Original location</span><span className="fl-th fl-td--mtime">Deleted</span><span className="fl-td fl-td--menu" /></div>
			{items.map((t) => (
				<div key={t.url} className="fl-tr fl-tr--trash" role="row">
					<span className="fl-td fl-td--name fl-name">
						<span className="fl-thumb" style={{ width: 40, height: 40 }}><Icon name={t.dir ? 'folder' : 'file'} /></span>
						<span className="fl-name__text"><span className="fl-name__title">{t.name}</span><span className="fl-name__sub">{formatBytes(t.size)}</span></span>
					</span>
					<span className="fl-td fl-td--orig">{parentOf('/' + t.original) === '/' ? 'All files' : parentOf('/' + t.original).slice(1)}</span>
					<span className="fl-td fl-td--mtime" title={formatDate(t.deleted, { dateStyle: 'full', timeStyle: 'short' })}>{relativeTime(t.deleted)}</span>
					<span className="fl-td fl-td--menu">
						<IconButton icon="restore" label={`Restore ${t.name}`} onClick={() => onRestore(t)} />
						<Menu trigger={(o, x) => <IconButton icon="moreVert" label={`${t.name} actions`} aria-expanded={x} onClick={o} />} items={[
							{ label: 'Restore', icon: 'restore', onClick: () => onRestore(t) },
							{ label: 'Delete permanently', icon: 'delete', danger: true, onClick: async () => { if (await confirmDialog(`Permanently delete “${t.name}”? This can't be undone.`, { title: 'Delete permanently', confirm: 'Delete', danger: true })) onPurge(t) } },
						]} />
					</span>
				</div>
			))}
		</div>
	)
}

export default defineApp({ Component: Files })
