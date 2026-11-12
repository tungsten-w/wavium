// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Notes backend (apps/notes/appinfo/routes.php), unchanged: the REST API v1 for
// notes and settings (the same one the phone apps use, with If-Match), plus the
// web routes the classic UI uses for autotitle, undo and categories.
import { HttpError, request } from '@atrium/sdk'

export interface Note {
	id: number
	etag: string
	title: string
	category: string
	content: string
	favorite: boolean
	/** unix seconds */
	modified: number
	readonly: boolean
	error: boolean
	errorType: string
	internalPath?: string
}
export interface NotesSettings { notesPath: string, fileSuffix: string, customSuffix?: string, noteMode: 'edit' | 'preview' | 'rich' }

const v1 = '/apps/notes/api/v1'
const web = '/apps/notes'

export async function listNotes(): Promise<Note[]> {
	const all = await request<Note[]>(`${v1}/notes`)
	return all.filter((n) => n.title !== undefined)
}
export const getNote = (id: number) => request<Note>(`${v1}/notes/${id}`)
export const getSettings = () => request<NotesSettings>(`${v1}/settings`)
export const setSettings = (s: Partial<NotesSettings>) => request<NotesSettings>(`${v1}/settings`, { method: 'PUT', body: s })

export const createNote = (p: { category?: string, title?: string, content?: string, favorite?: boolean }) =>
	request<Note>(`${v1}/notes`, { method: 'POST', body: { category: '', title: '', content: '', ...p } })

/** Thrown when the note changed elsewhere since `etag`; `current` is the server version. */
export class Conflict extends Error {
	constructor(public current: Note | null) { super('The note was changed somewhere else') }
}

/** Save fields; with an etag the server refuses (412) if the note changed meanwhile. */
export async function updateNote(id: number, p: Partial<Pick<Note, 'content' | 'title' | 'category' | 'favorite' | 'modified'>>, etag?: string): Promise<Note> {
	try {
		return await request<Note>(`${v1}/notes/${id}`, { method: 'PUT', body: p, headers: etag ? { 'If-Match': `"${etag}"` } : {} })
	} catch (e) {
		if (e instanceof HttpError && e.status === 412) {
			const body = e.body as Partial<Note> | null
			throw new Conflict(body && typeof body === 'object' && 'id' in body ? body as Note : await getNote(id).catch(() => null))
		}
		throw e
	}
}

/** Title from the first line of the content, the way the classic app does it (server side). */
export const autotitle = (id: number) => request<string>(`${web}/notes/${id}/autotitle`, { method: 'PUT' })

export const deleteNote = (id: number) => request(`${v1}/notes/${id}`, { method: 'DELETE' })

/** Re-create a deleted note (the classic Undo). */
export const undoDelete = (n: Note) => request<Note>(`${web}/notes/undo`, { method: 'POST', body: { id: n.id, title: n.title, content: n.content, category: n.category, modified: n.modified, favorite: n.favorite } })

export const renameCategory = (oldCategory: string, newCategory: string) => request(`${web}/notes/category`, { method: 'PATCH', body: { oldCategory, newCategory } })
export const deleteCategory = (category: string) => request(`${web}/notes/category`, { method: 'DELETE', body: { category } })

export async function uploadAttachment(id: number, file: File): Promise<string> {
	const fd = new FormData()
	fd.append('file', file)
	const r = await request<{ filename: string }>(`${web}/notes/${id}/attachment`, { method: 'POST', body: fd })
	return r.filename
}
export const attachmentUrl = (id: number, path: string) => `${web}/notes/${id}/attachment?path=${encodeURIComponent(path)}`
