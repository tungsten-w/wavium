// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One note: live Markdown editor (or a read-only preview), autosaved a second after typing stops,
// on blur and when leaving. Saves send If-Match; if the note changed on another
// device the user picks which version to keep.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Icon, IconButton, Menu, toast } from '@atrium/ui'
import { Conflict, attachmentUrl, autotitle, getNote, updateNote, uploadAttachment, type Note } from './api'
import { LiveEditor } from './LiveEditor'
import { renderMarkdown, toggleTask } from './markdown'
import { shortTime } from './util'

type Status = 'saved' | 'dirty' | 'saving' | 'error'
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const PREVIEW_KEY = 'nt-preview'

export function NoteEditor({ note, categories, autoTitle, previewDefault, onChange, onDirty, onBack, onFavorite, onDelete }: {
	note: Note
	categories: string[]
	autoTitle: Set<number>
	previewDefault: boolean
	onChange: (n: Note) => void
	onDirty: (dirty: boolean) => void
	onBack: () => void
	onFavorite: () => void
	onDelete: () => void
}) {
	const ro = note.readonly
	const [content, setContent] = useState(note.content ?? '')
	const [title, setTitle] = useState(note.title)
	const [category, setCategory] = useState(note.category)
	const [status, setStatus] = useState<Status>('saved')
	const [conflict, setConflict] = useState<Note | null>(null)
	const [preview, setPreview] = useState(() => {
		try { const v = localStorage.getItem(PREVIEW_KEY); if (v !== null) return v === '1' } catch { /* not remembered */ }
		return previewDefault || ro
	})
	const latest = useRef(content)
	const saved = useRef(note.content ?? '')
	const etag = useRef(note.etag)
	const busy = useRef(false)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const noteRef = useRef(note)
	noteRef.current = note

	// The list reloaded or a favourite toggled: take the new etag, and the new
	// content when nothing local is pending.
	useEffect(() => {
		if (busy.current) return
		etag.current = note.etag
		if (latest.current === saved.current && note.content !== undefined && note.content !== saved.current) {
			saved.current = latest.current = note.content
			setContent(note.content)
		}
		setTitle(note.title)
		setCategory(note.category)
	}, [note.etag, note.title, note.category, note.content])

	const flush = useCallback(async (): Promise<void> => {
		if (timer.current) { clearTimeout(timer.current); timer.current = null }
		if (busy.current || ro || latest.current === saved.current) return
		busy.current = true
		setStatus('saving')
		try {
			let n: Note = noteRef.current
			while (latest.current !== saved.current) {
				const c = latest.current
				n = await updateNote(noteRef.current.id, { content: c }, etag.current)
				etag.current = n.etag
				saved.current = c
			}
			if (autoTitle.has(n.id)) {
				const t = await autotitle(n.id).catch(() => null)
				if (t && t !== n.title) {
					// The rename changes the etag: fetch the new one so the next save is not refused.
					n = { ...n, title: t }
					const fresh = await getNote(n.id).catch(() => null)
					if (fresh) { etag.current = fresh.etag; n = { ...fresh, content: saved.current } }
				}
			}
			onChange({ ...n, content: saved.current })
			setStatus(latest.current === saved.current ? 'saved' : 'dirty')
			onDirty(latest.current !== saved.current)
		} catch (e) {
			if (e instanceof Conflict) setConflict(e.current)
			else toast.error(`Could not save: ${errText(e)}`)
			setStatus('error')
		} finally {
			busy.current = false
		}
		if (latest.current !== saved.current && !conflictRef.current) schedule()
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ro, autoTitle, onChange, onDirty])
	const conflictRef = useRef(conflict)
	conflictRef.current = conflict
	const schedule = () => {
		if (timer.current) clearTimeout(timer.current)
		timer.current = setTimeout(() => { flush() }, 1000)
	}

	const edit = (c: string) => {
		latest.current = c
		setContent(c)
		setStatus('dirty')
		onDirty(true)
		if (!conflictRef.current) schedule()
	}

	// Save when leaving the note, the page or the tab.
	useEffect(() => {
		const onHide = () => { if (document.hidden) flush() }
		const onUnload = (e: BeforeUnloadEvent) => { if (latest.current !== saved.current) { flush(); e.preventDefault() } }
		document.addEventListener('visibilitychange', onHide)
		window.addEventListener('beforeunload', onUnload)
		return () => {
			document.removeEventListener('visibilitychange', onHide)
			window.removeEventListener('beforeunload', onUnload)
			flush()
			onDirty(false)
		}
	}, [flush, onDirty])

	const resolve = async (keep: 'mine' | 'theirs') => {
		const server = conflict
		setConflict(null)
		if (!server) return
		etag.current = server.etag
		if (keep === 'theirs') {
			saved.current = latest.current = server.content ?? ''
			setContent(saved.current)
			setStatus('saved')
			onDirty(false)
			onChange(server)
		} else {
			saved.current = server.content ?? ''
			await flush()
		}
	}

	const saveMeta = async (p: { title?: string, category?: string }) => {
		const t = p.title?.trim()
		if (p.title !== undefined && (!t || t === note.title)) { setTitle(note.title); return }
		if (p.category !== undefined && p.category.trim() === note.category) return
		if (p.title !== undefined) autoTitle.delete(note.id)
		await flush()
		try {
			const n = await updateNote(note.id, p.title !== undefined ? { title: t } : { category: p.category!.trim().replace(/^\/+|\/+$/g, '') })
			etag.current = n.etag
			onChange({ ...n, content: saved.current })
		} catch (e) {
			toast.error(`Could not save: ${errText(e)}`)
			setTitle(note.title)
			setCategory(note.category)
		}
	}

	const togglePreview = () => {
		const v = !preview
		setPreview(v)
		try { localStorage.setItem(PREVIEW_KEY, v ? '1' : '0') } catch { /* not remembered */ }
		if (!v) setTimeout(() => (document.querySelector('.nt-live .cm-content') as HTMLElement | null)?.focus(), 0)
	}

	const html = useMemo(() => (preview ? renderMarkdown(content, { resolveImage: (src) => attachmentUrl(note.id, src) }) : ''), [preview, content, note.id])
	const onPreviewClick = (e: React.MouseEvent) => {
		const el = e.target as HTMLElement
		if (el instanceof HTMLInputElement && el.type === 'checkbox' && el.dataset.line) {
			e.preventDefault()
			if (!ro) edit(toggleTask(latest.current, Number(el.dataset.line)))
		}
	}

	// Paste or drop an image: upload it next to the note and insert a link.
	const insertImages = async (files: File[]): Promise<string | null> => {
		const imgs = files.filter((f) => f.type.startsWith('image/'))
		if (!imgs.length || ro) return null
		try {
			const links: string[] = []
			for (const f of imgs) {
				const name = await uploadAttachment(note.id, f)
				links.push(`![${f.name.replace(/[[\]]/g, '')}](${name.split('/').map(encodeURIComponent).join('/')})`)
			}
			return links.join('\n')
		} catch (e) { toast.error(`Could not upload: ${errText(e)}`); return null }
	}

	const statusText = status === 'saving' ? 'Saving…' : status === 'dirty' ? 'Editing' : status === 'error' ? 'Not saved' : `Saved · ${shortTime(note.modified)}`
	const wordCount = useMemo(() => (content.match(/\S+/g) ?? []).length, [content])

	return (
		<div className="nt-editor">
			<header className="nt-editor__head">
				<IconButton className="nt-back" icon="arrowBack" label="Back to the list" onClick={() => { flush(); onBack() }} />
				<input className="nt-editor__title" value={title} disabled={ro} aria-label="Title"
					onChange={(e) => setTitle(e.target.value)} onBlur={() => saveMeta({ title })}
					onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } if (e.key === 'Escape') { setTitle(note.title); (e.target as HTMLInputElement).blur() } }} />
				<span className={'nt-status nt-status--' + status} aria-live="polite">{statusText}</span>
				<IconButton className={'nt-star' + (note.favorite ? ' nt-star--on' : '')} icon={note.favorite ? 'star' : 'starBorder'} label={note.favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={onFavorite} />
				<IconButton icon={preview ? 'edit' : 'visibility'} label={preview ? 'Edit' : 'Preview'} aria-pressed={preview} onClick={togglePreview} />
				<Menu trigger={(o, x) => <IconButton icon="moreVert" label="Note actions" aria-expanded={x} onClick={o} />} items={[
					note.internalPath ? { label: 'Show in Files', icon: 'folder', href: `/apps/files/?dir=${encodeURIComponent(note.internalPath.replace(/\/[^/]*$/, '') || '/')}` } : null,
					!ro && { label: 'Delete', icon: 'delete', danger: true, onClick: () => { latest.current = saved.current; onDelete() } },
				]} />
			</header>
			<div className="nt-editor__meta">
				<label className="nt-catfield">
					<Icon name="folder" size="s" />
					<input list="nt-categories" value={category} placeholder="No category" disabled={ro} aria-label="Category"
						onChange={(e) => setCategory(e.target.value)} onBlur={() => saveMeta({ category })}
						onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }} />
					<datalist id="nt-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
				</label>
				{ro && <span className="nt-chip"><Icon name="lock" size="s" />Read only</span>}
				<span className="nt-muted nt-words">{wordCount} word{wordCount === 1 ? '' : 's'}</span>
			</div>
			{conflict && (
				<div className="nt-conflict" role="alert">
					<Icon name="warning" />
					<span>This note was changed on another device while you were editing.</span>
					<Button size="s" variant="text" onClick={() => resolve('theirs')}>Use theirs</Button>
					<Button size="s" variant="tonal" onClick={() => resolve('mine')}>Keep mine</Button>
				</div>
			)}
			{preview
				? <div className="nt-preview" onClick={onPreviewClick} onDoubleClick={() => { if (!ro) togglePreview() }}>
					{content.trim() ? <div className="nt-md" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="nt-muted">Empty note</p>}
				</div>
				: <LiveEditor value={content} readOnly={ro} autoFocus={!content} resolveImage={(src) => attachmentUrl(note.id, src)}
					placeholder="Start writing… (# heading, - list, - [ ] task, **bold**)"
					onChange={edit} onBlur={() => flush()} onSave={() => flush()} onFiles={insertImages} />}
		</div>
	)
}
