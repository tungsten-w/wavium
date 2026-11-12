// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Files building blocks: icons/thumbnails, folder picker, share dialog, viewer.
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatBytes, formatDate, useApp } from '@atrium/sdk'
import { Button, Dialog, EmptyState, Icon, IconButton, Spinner, Switch, TextField, toast, useDebounced, type IconName } from '@atrium/ui'
import {
	SHARE_GROUP, SHARE_LINK, createShare, deleteShare, findSharees, isImage, isMedia, isPdf, isText, listDir, parentOf, previewUrl, readText, saveText, sharesOf, updateShare,
	downloadUrl, type Node, type Share, type Sharee,
} from './api'

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function mimeIcon(n: { dir: boolean, mime: string, name: string }): IconName {
	if (n.dir) return 'folder'
	const m = n.mime
	if (m.startsWith('image/')) return 'image'
	if (m.startsWith('video/')) return 'movie'
	if (m.startsWith('audio/')) return 'music'
	if (m === 'application/pdf') return 'pdf'
	if (/zip|tar|rar|7z|gzip|compressed/.test(m)) return 'archive'
	if (m.startsWith('text/') || /document|word|opendocument|markdown|json/.test(m)) return 'description'
	return 'file'
}

/** Preview image when the server has one, else the type icon. Shared folders get a badge. */
export function Thumb({ node, size = 40 }: { node: Node, size?: number }) {
	const [failed, setFailed] = useState(false)
	const shared = node.shareTypes.length > 0 || node.mountType === 'shared'
	return (
		<span className={'fl-thumb' + (node.dir ? ' fl-thumb--dir' : '')} style={{ width: size, height: size }}>
			{node.hasPreview && !failed
				? <img src={previewUrl(node, size > 64 ? 512 : 128)} alt="" loading="lazy" onError={() => setFailed(true)} />
				: <Icon name={mimeIcon(node)} />}
			{shared && <span className="fl-thumb__badge"><Icon name={node.shareTypes.includes(SHARE_LINK) ? 'link' : 'share'} size="s" /></span>}
		</span>
	)
}

export function Crumbs({ dir, onGo, onDropTo }: { dir: string, onGo: (dir: string) => void, onDropTo?: (dir: string, e: React.DragEvent) => void }) {
	const parts = dir.split('/').filter(Boolean)
	const crumb = (path: string, label: React.ReactNode, key: string, last: boolean) => (
		<button key={key} type="button" className={'fl-crumb' + (last ? ' fl-crumb--last' : '')} onClick={() => onGo(path)} aria-current={last ? 'page' : undefined}
			onDragOver={onDropTo && !last ? (e) => { e.preventDefault(); e.currentTarget.classList.add('fl-drop') } : undefined}
			onDragLeave={(e) => e.currentTarget.classList.remove('fl-drop')}
			onDrop={onDropTo && !last ? (e) => { e.currentTarget.classList.remove('fl-drop'); onDropTo(path, e) } : undefined}>{label}</button>
	)
	return (
		<nav className="fl-crumbs" aria-label="Folder path">
			{crumb('/', <><Icon name="home" /><span className="fl-crumb__home">All files</span></>, '/', parts.length === 0)}
			{parts.map((p, i) => [<Icon key={`s${i}`} name="chevronRight" size="s" className="fl-crumb__sep" />, crumb('/' + parts.slice(0, i + 1).join('/'), p, String(i), i === parts.length - 1)])}
		</nav>
	)
}

/** Pick a target folder for move/copy. */
export function FolderPicker({ open, title, start, exclude, onClose, onPick }: { open: boolean, title: string, start: string, exclude: string[], onClose: () => void, onPick: (dir: string, mode: 'move' | 'copy') => void }) {
	const { session } = useApp()
	const [dir, setDir] = useState(start)
	const [dirs, setDirs] = useState<Node[] | null>(null)
	const [writable, setWritable] = useState(true)
	useEffect(() => { if (open) setDir(start) }, [open, start])
	useEffect(() => {
		if (!open) return
		setDirs(null)
		listDir(session.user.id, dir).then(({ self, children }) => {
			setWritable(/[CK]/.test(self.perms) || dir === '/')
			setDirs(children.filter((c) => c.dir).sort((a, b) => a.name.localeCompare(b.name)))
		}, (e) => { toast.error(errText(e)); setDirs([]) })
	}, [open, dir, session.user.id])
	const blocked = !writable || exclude.some((p) => dir === p || dir.startsWith(p + '/'))
	const sameDir = exclude.every((p) => parentOf(p) === dir)
	return (
		<Dialog open={open} title={title} onClose={onClose}
			actions={<>
				<Button variant="text" onClick={onClose}>Cancel</Button>
				<Button variant="tonal" disabled={blocked} onClick={() => onPick(dir, 'copy')}>Copy here</Button>
				<Button disabled={blocked || sameDir} onClick={() => onPick(dir, 'move')}>Move here</Button>
			</>}>
			<div className="fl-picker">
				<Crumbs dir={dir} onGo={setDir} />
				<ul className="fl-picker__list">
					{dirs === null ? <li className="fl-center"><Spinner small /></li>
						: dirs.length === 0 ? <li className="fl-picker__empty at-muted">No folders here</li>
						: dirs.map((d) => {
							const off = exclude.includes(d.path)
							return <li key={d.path}><button type="button" className="fl-picker__item" disabled={off} onClick={() => setDir(d.path)}><Icon name="folder" /><span>{d.name}</span><Icon name="chevronRight" size="s" /></button></li>
						})}
				</ul>
			</div>
		</Dialog>
	)
}

// ---------------------------------------------------------------- sharing

const PERM_READ = 1, PERM_UPDATE = 2, PERM_CREATE = 4, PERM_DELETE = 8
const linkUrl = (s: Share) => s.url ?? `${location.origin}/s/${s.token}`
async function copyText(text: string) {
	try { await navigator.clipboard.writeText(text); toast('Link copied') } catch { window.prompt('Copy the link', text) }
}

export function ShareDialog({ node, onClose, onChanged }: { node: Node | null, onClose: () => void, onChanged: () => void }) {
	const [shares, setShares] = useState<Share[] | null>(null)
	const [q, setQ] = useState('')
	const [found, setFound] = useState<Sharee[]>([])
	const dq = useDebounced(q, 250)
	const load = useCallback(() => {
		if (!node) return
		sharesOf(node.path).then(setShares, (e) => { toast.error(errText(e)); setShares([]) })
	}, [node])
	useEffect(() => { setShares(null); setQ(''); load() }, [load])
	useEffect(() => {
		if (!node || dq.trim().length < 1) { setFound([]); return }
		findSharees(dq.trim(), node.dir ? 'folder' : 'file').then(setFound, () => setFound([]))
	}, [dq, node])
	if (!node) return null

	const run = async (p: Promise<unknown>) => { try { await p; load(); onChanged() } catch (e) { toast.error(errText(e)) } }
	const links = (shares ?? []).filter((s) => s.share_type === SHARE_LINK)
	const people = (shares ?? []).filter((s) => s.share_type !== SHARE_LINK)
	const canEdit = (s: Share) => (s.permissions & PERM_UPDATE) !== 0
	const editPerms = node.dir ? PERM_READ | PERM_UPDATE | PERM_CREATE | PERM_DELETE : PERM_READ | PERM_UPDATE

	return (
		<Dialog open title={`Share ${node.name || 'All files'}`} onClose={onClose} actions={<Button onClick={onClose}>Done</Button>}>
			<div className="fl-share">
				<section>
					<h3 className="fl-share__h">People</h3>
					<div className="fl-share__search">
						<TextField label="Name or group" icon="personAdd" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
						{found.length > 0 && (
							<ul className="fl-share__found" role="listbox">
								{found.map((f) => (
									<li key={`${f.value.shareType}:${f.value.shareWith}`}>
										<button type="button" onClick={() => { setQ(''); setFound([]); run(createShare({ path: node.path, shareType: f.value.shareType, shareWith: f.value.shareWith })) }}>
											<Icon name={f.value.shareType === SHARE_GROUP ? 'group' : 'person'} />{f.label}
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
					{people.map((s) => (
						<div key={s.id} className="fl-share__row">
							<Icon name={s.share_type === SHARE_GROUP ? 'group' : 'person'} />
							<span className="fl-share__who">{s.share_with_displayname || s.share_with}</span>
							<Switch label="Can edit" checked={canEdit(s)} onChange={(e) => run(updateShare(s.id, { permissions: e.target.checked ? (s.permissions | editPerms) : PERM_READ | (s.permissions & 16) }))} />
							<IconButton icon="close" label="Stop sharing" onClick={() => run(deleteShare(s.id))} />
						</div>
					))}
				</section>
				<section>
					<h3 className="fl-share__h">Public links</h3>
					{shares === null && <Spinner small />}
					{links.map((s) => (
						<div key={s.id} className="fl-share__link">
							<div className="fl-share__row">
								<Icon name="link" />
								<input className="fl-share__url" readOnly value={linkUrl(s)} aria-label="Link" onFocus={(e) => e.target.select()} />
								<IconButton icon="contentCopy" label="Copy link" onClick={() => copyText(linkUrl(s))} />
								<IconButton icon="delete" label="Delete link" onClick={() => run(deleteShare(s.id))} />
							</div>
							<div className="fl-share__opts">
								{node.dir && <Switch label="Allow upload and editing" checked={canEdit(s)} onChange={(e) => run(updateShare(s.id, { permissions: e.target.checked ? 15 : 1 }))} />}
								<label className="fl-share__exp">Expires
									<input type="date" value={s.expiration?.slice(0, 10) ?? ''} onChange={(e) => run(updateShare(s.id, { expireDate: e.target.value }))} />
								</label>
							</div>
						</div>
					))}
					<Button variant="tonal" icon="add" onClick={() => run(createShare({ path: node.path, shareType: SHARE_LINK, permissions: PERM_READ }).then((s) => copyText(linkUrl(s))))}>Create public link</Button>
				</section>
			</div>
		</Dialog>
	)
}

// ---------------------------------------------------------------- viewer

export const viewable = (n: Node) => isImage(n) || isMedia(n) || isPdf(n) || isText(n)

export function Viewer({ node, list, onNavigate, onClose, canWrite, onSaved }: { node: Node, list: Node[], onNavigate: (n: Node) => void, onClose: () => void, canWrite: boolean, onSaved: () => void }) {
	const gallery = list.filter((n) => isImage(n) || isMedia(n) || isPdf(n))
	const i = gallery.findIndex((n) => n.path === node.path)
	const prev = i > 0 ? gallery[i - 1] : null
	const next = i >= 0 && i < gallery.length - 1 ? gallery[i + 1] : null
	useEffect(() => {
		const key = (e: KeyboardEvent) => {
			if ((e.target as HTMLElement).closest('textarea, input')) return
			if (e.key === 'Escape') onClose()
			else if (e.key === 'ArrowLeft' && prev) onNavigate(prev)
			else if (e.key === 'ArrowRight' && next) onNavigate(next)
		}
		window.addEventListener('keydown', key)
		return () => window.removeEventListener('keydown', key)
	}, [prev, next, onNavigate, onClose])
	const heic = /hei[cf]$/.test(node.mime)
	return (
		<div className="fl-viewer" role="dialog" aria-label={node.name}>
			<header className="fl-viewer__bar">
				<IconButton icon="arrowBack" label="Close" onClick={onClose} />
				<span className="fl-viewer__name">{node.name}</span>
				<span className="fl-viewer__meta">{formatBytes(node.size)} · {formatDate(node.mtime, { dateStyle: 'medium', timeStyle: 'short' })}</span>
				<a className="at-icon-btn" href={downloadUrl(node)} download={node.name} aria-label="Download" title="Download"><Icon name="download" /></a>
			</header>
			<div className={'fl-viewer__stage' + (isText(node) ? ' fl-viewer__stage--text' : '')}>
				{isImage(node) && <img key={node.path} src={heic ? previewUrl(node, 2048) : node.url} alt={node.name} />}
				{node.mime.startsWith('video/') && <video key={node.path} src={node.url} controls autoPlay />}
				{node.mime.startsWith('audio/') && <div className="fl-viewer__audio"><Icon name="music" size="l" /><audio key={node.path} src={node.url} controls autoPlay /></div>}
				{isPdf(node) && <iframe key={node.path} src={node.url} title={node.name} />}
				{isText(node) && <TextEditor key={node.path} node={node} canWrite={canWrite} onSaved={onSaved} />}
				{prev && <IconButton className="fl-viewer__nav fl-viewer__nav--prev" icon="chevronLeft" label="Previous" onClick={() => onNavigate(prev)} />}
				{next && <IconButton className="fl-viewer__nav fl-viewer__nav--next" icon="chevronRight" label="Next" onClick={() => onNavigate(next)} />}
			</div>
		</div>
	)
}

function TextEditor({ node, canWrite, onSaved }: { node: Node, canWrite: boolean, onSaved: () => void }) {
	const [text, setText] = useState<string | null>(null)
	const [saved, setSaved] = useState('')
	const etag = useRef<string | null>(null)
	const [busy, setBusy] = useState(false)
	useEffect(() => {
		if (node.size > 2_000_000) { setText(''); return }
		readText(node).then((r) => { setText(r.text); setSaved(r.text); etag.current = r.etag }, (e) => toast.error(errText(e)))
	}, [node])
	const dirty = text !== null && text !== saved
	const save = async () => {
		if (!dirty || text === null) return
		setBusy(true)
		try {
			etag.current = await saveText(node, text, etag.current)
			setSaved(text)
			toast('Saved')
			onSaved()
		} catch (e) {
			toast.error(/412/.test(errText(e)) || (e as { status?: number }).status === 412 ? 'The file changed somewhere else. Copy your text and reopen it.' : `Could not save: ${errText(e)}`)
		} finally { setBusy(false) }
	}
	if (node.size > 2_000_000) return <EmptyState icon="description" title="This file is too big to open here">Download it instead.</EmptyState>
	if (text === null) return <Spinner />
	return (
		<div className="fl-text">
			<textarea value={text} readOnly={!canWrite} spellCheck={false} aria-label={`Contents of ${node.name}`} onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save() } }} />
			{canWrite && <div className="fl-text__bar"><span className="at-muted">{dirty ? 'Unsaved changes' : 'Saved'}</span><Button size="s" disabled={!dirty} busy={busy} onClick={save}>Save</Button></div>}
		</div>
	)
}

