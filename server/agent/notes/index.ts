// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Notes tools (PLAN P3-5, area `notes`). The work is done by PHP
// (apps/notes/lib/Controller/AtriumAgentController.php) through the Notes
// app's NotesService: notes stay Markdown files in the user's Notes folder,
// and a deleted note goes to the Files trash bin (restorable there).
import type { AgentModule, LayerCore } from '../index'
import { boolean, int, obj, type Schema, str } from '../schema'
import type { Tool } from '../tools'
import { AgentError, iso } from '../util'

export interface PhpNote {
	id: number
	title: string
	category: string
	favorite: boolean
	read_only: boolean
	modified: number
	etag: string
	excerpt?: string
	content?: string
}

/** The PHP side. Each call acts as `uid` (the grantor). */
export interface NotesBridge {
	list(uid: string, q: { query?: string, category?: string }): Promise<{ notes: PhpNote[], categories: string[] }>
	get(uid: string, id: number): Promise<PhpNote>
	create(uid: string, n: { title?: string, content?: string, category?: string, favorite?: boolean }): Promise<PhpNote>
	update(uid: string, id: number, n: Record<string, unknown>): Promise<PhpNote>
	delete(uid: string, id: number): Promise<{ deleted: boolean, title: string }>
}

export function phpNotes(core: Pick<LayerCore, 'php'>): NotesBridge {
	const call = <T>(path: string, body: Record<string, unknown>) => core.php.app<T>('POST', `apps/notes/api/atrium-agent/${path}`, { body })
	return {
		list: (uid, q) => call('list', { uid, ...q }),
		get: (uid, id) => call('get', { uid, id }),
		create: (uid, n) => call('create', { uid, ...n }),
		update: (uid, id, n) => call('update', { uid, id, ...n }),
		delete: (uid, id) => call('delete', { uid, id }),
	}
}

export const DEFAULT_MAX_CHARS = 20000

/** What agents see; content is sliced (max_chars / offset) so a long note does not flood the context. */
export function noteView(n: PhpNote, slice?: { maxChars: number, offset: number }) {
	const { modified, content, ...rest } = n
	const out: Record<string, unknown> = { ...rest, modified: iso(modified) }
	if (content !== undefined) {
		const s = slice ?? { maxChars: DEFAULT_MAX_CHARS, offset: 0 }
		out.content = content.slice(s.offset, s.offset + s.maxChars)
		out.content_length = content.length
		out.truncated = s.offset + s.maxChars < content.length
	}
	return out
}

const noteId: Schema = int('Note id from notes_note_list', { minimum: 1 })

export function notesTools(bridge: NotesBridge): Tool[] {
	return [
		{
			name: 'notes_note_list',
			description: 'Notes, most recently changed first: id, title, category, favorite, read_only, modified, a 200-character excerpt, etag. `query` searches titles, categories and content (all words must match). Also returns the categories.',
			area: 'notes',
			input: obj({
				query: str(undefined, { maxLength: 200 }),
				category: str('Only this category and its sub-categories ("Work" includes "Work/Meetings")'),
				favorite: boolean('Only favorites (true) or only the others (false)'),
				limit: int('Default 50, max 200', { minimum: 1, maximum: 200 }),
				cursor: str('next_cursor of the previous page'),
			}),
			run: async (ctx, input) => {
				const limit = input.limit === undefined ? 50 : Number(input.limit)
				const offset = input.cursor === undefined ? 0 : Number(input.cursor)
				if (!Number.isInteger(offset) || offset < 0) throw new AgentError('invalid_input', 'Bad cursor')
				const res = await bridge.list(ctx.grantor, {
					query: input.query === undefined ? undefined : String(input.query),
					category: input.category === undefined ? undefined : String(input.category),
				})
				const all = input.favorite === undefined ? res.notes : res.notes.filter((n) => n.favorite === input.favorite)
				const page = all.slice(offset, offset + limit)
				const next = offset + page.length
				return { notes: page.map((n) => noteView(n)), total: all.length, next_cursor: next < all.length ? String(next) : null, categories: res.categories }
			},
		},
		{
			name: 'notes_note_get',
			description: `One note with its Markdown content (up to max_chars, default ${DEFAULT_MAX_CHARS}; use offset for the rest).`,
			area: 'notes',
			input: obj({
				id: noteId,
				max_chars: int(undefined, { minimum: 1, maximum: 200000 }),
				offset: int(undefined, { minimum: 0 }),
			}, ['id']),
			run: async (ctx, input) => noteView(await bridge.get(ctx.grantor, Number(input.id)), {
				maxChars: input.max_chars === undefined ? DEFAULT_MAX_CHARS : Number(input.max_chars),
				offset: input.offset === undefined ? 0 : Number(input.offset),
			}),
		},
		{
			name: 'notes_note_create',
			description: 'Create a note (Markdown). Without a title, the first line of the content becomes the title. Category = folder path inside Notes, e.g. "Work/Meetings".',
			area: 'notes',
			action: 'write',
			input: obj({
				title: str(undefined, { maxLength: 200 }),
				content: str('Markdown', { maxLength: 1048576 }),
				category: str(undefined, { maxLength: 500 }),
				favorite: boolean(),
			}),
			run: async (ctx, input) => {
				if (!input.title && !input.content) throw new AgentError('invalid_input', 'A note needs a title or some content')
				const n: { title?: string, content?: string, category?: string, favorite?: boolean } = {}
				if (input.title !== undefined) n.title = String(input.title)
				if (input.content !== undefined) n.content = String(input.content)
				if (input.category !== undefined) n.category = String(input.category)
				if (input.favorite !== undefined) n.favorite = Boolean(input.favorite)
				return noteView(await bridge.create(ctx.grantor, n))
			},
		},
		{
			name: 'notes_note_update',
			description: 'Change a note: replace `content`, or `append` text at the end (both: append after the new content), rename (`title`), move (`category`), star (`favorite`). Pass the etag you read to refuse the change if the note was edited meanwhile.',
			area: 'notes',
			action: 'write',
			input: obj({
				id: noteId,
				content: str(undefined, { maxLength: 1048576 }),
				append: str('Added on a new line at the end', { maxLength: 1048576 }),
				title: str(undefined, { maxLength: 200 }),
				category: str(undefined, { maxLength: 500 }),
				favorite: boolean(),
				etag: str(),
			}, ['id']),
			run: async (ctx, input) => {
				const patch: Record<string, unknown> = {}
				for (const k of ['content', 'append', 'title', 'category', 'favorite', 'etag']) if (input[k] !== undefined) patch[k] = input[k]
				if (Object.keys(patch).filter((k) => k !== 'etag').length === 0) throw new AgentError('invalid_input', 'Nothing to change')
				return noteView(await bridge.update(ctx.grantor, Number(input.id), patch))
			},
		},
		{
			name: 'notes_note_delete',
			description: 'Delete a note (asks the owner unless allowed). The file goes to the Files trash bin, where the owner can restore it.',
			area: 'notes',
			action: 'delete',
			input: obj({ id: noteId }, ['id']),
			prepare: async (ctx, input) => {
				const n = await bridge.get(ctx.grantor, Number(input.id))
				return { payload: { id: n.id, etag: n.etag }, summary: `Delete note "${n.title}"${n.category ? ` (${n.category})` : ''}`, ref: `note:${n.id}` }
			},
			// Approved later: void if the note was edited (or is gone) since the request.
			stillValid: async (ctx, payload) => {
				const p = payload as { id: number, etag: string }
				try {
					return (await bridge.get(ctx.grantor, p.id)).etag === p.etag
				} catch (e) {
					if (e instanceof AgentError && e.code === 'not_found') return false
					throw e
				}
			},
			execute: async (ctx, payload) => {
				const p = payload as { id: number }
				const r = await bridge.delete(ctx.grantor, p.id)
				return { id: p.id, deleted: r.deleted, title: r.title, in_trash_bin: true }
			},
		},
	]
}

export function notesModule(make: (core: LayerCore) => NotesBridge = phpNotes): AgentModule {
	return { tools: (core) => notesTools(make(core)) }
}
