// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Notes and Activity tools (P3-5) over fake PHP bridges, with real grants and
// approvals. The PHP side is exercised on the dev stack (reports/P3-5.md).
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { normalizeModes, setAccess } from '../access'
import { activityTools, type ActivityBridge, type PhpActivity } from '../activity'
import { Approvals } from '../approvals'
import { type Db, migrate, wrap } from '../db'
import { callTool, Registry, type ToolCtx } from '../tools'
import { AgentError } from '../util'
import { type NotesBridge, notesTools, type PhpNote } from './index'

let db: Db
let notes: Map<number, PhpNote>
let calls: string[]
let nextId = 100

const note = (id: number, f: Partial<PhpNote>): PhpNote => ({
	id, title: '', category: '', favorite: false, read_only: false, modified: 1_700_000_000, etag: `e${id}-0`, content: '', ...f,
})

const fakeNotes: NotesBridge = {
	async list(_uid, q) {
		calls.push(`list ${JSON.stringify(q)}`)
		const all = [...notes.values()]
			.filter((n) => !q.category || n.category === q.category || n.category.startsWith(q.category + '/'))
			.filter((n) => !q.query || `${n.title} ${n.content}`.toLowerCase().includes(q.query.toLowerCase()))
			.sort((a, b) => b.modified - a.modified)
			.map(({ content, ...m }) => ({ ...m, excerpt: (content ?? '').slice(0, 200) }))
		return { notes: all, categories: [...new Set([...notes.values()].map((n) => n.category).filter(Boolean))] }
	},
	async get(_uid, id) {
		const n = notes.get(id)
		if (!n) throw new AgentError('not_found', 'No such note')
		return n
	},
	async create(uid, n) {
		calls.push(`create ${uid} ${JSON.stringify(n)}`)
		const id = nextId++
		const created = note(id, { title: n.title ?? (n.content ?? '').split('\n')[0], content: n.content ?? '', category: n.category ?? '', favorite: !!n.favorite })
		notes.set(id, created)
		return created
	},
	async update(uid, id, p) {
		calls.push(`update ${uid} ${id} ${JSON.stringify(p)}`)
		const n = await fakeNotes.get(uid, id)
		if (p.etag && p.etag !== n.etag) throw new AgentError('conflict', 'The note changed since it was read')
		let content = (p.content as string | undefined) ?? n.content ?? ''
		if (p.append !== undefined) content = content ? `${content}\n${String(p.append)}` : String(p.append)
		const next = { ...n, content, title: (p.title as string) ?? n.title, etag: `e${id}-${Number(n.etag.split('-')[1]) + 1}` }
		notes.set(id, next)
		return next
	},
	async delete(uid, id) {
		calls.push(`delete ${uid} ${id}`)
		const n = await fakeNotes.get(uid, id)
		notes.delete(id)
		return { deleted: true, title: n.title }
	},
}

const acts: PhpActivity[] = [3, 2, 1].map((i) => ({
	activity_id: i, time: 1_700_000_000 + i, app: 'files', type: 'file_changed', by: i === 2 ? 'bob' : 'alice', subject: `You changed f${i}.md`,
	message: null, object_type: 'files', object_id: 40 + i, object_name: `/f${i}.md`, link: `/apps/files/?fileid=${40 + i}`,
}))
const fakeActivity: ActivityBridge = {
	async list(uid, q) {
		calls.push(`activity ${uid} ${JSON.stringify(q)}`)
		const from = q.since ? acts.filter((a) => a.activity_id < q.since!) : acts
		return { activities: from.slice(0, q.limit), has_more: from.length > q.limit }
	},
	async filters() { return [{ id: 'all', name: 'All' }, { id: 'files', name: 'Files' }] },
}

let registry: Registry
let approvals: Approvals
let base: Omit<ToolCtx, 'grantor' | 'access'>

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	calls = []
	notes = new Map([
		[1, note(1, { title: 'Courses', content: 'lait\npain', modified: 1_700_000_300, favorite: true })],
		[2, note(2, { title: 'Réunion lundi', category: 'Work/Meetings', content: '# Réunion\nOrdre du jour', modified: 1_700_000_200 })],
		[3, note(3, { title: 'Idées', category: 'Work', content: 'x'.repeat(30000), modified: 1_700_000_100 })],
	])
	approvals = new Approvals(db, null, 'https://x/settings/agents')
	registry = new Registry()
	registry.add(...notesTools(fakeNotes), ...activityTools(fakeActivity))
	approvals.registry = registry
	base = { db, php: null as never, agent: { uid: 'bot', displayName: 'Bot', owner: 'alice' }, baseUrl: 'https://atrium.test', approvals }
	approvals.ctxFor = async (_agent, grantor) => ({ ...base, grantor, access: {} } as ToolCtx)
})

const grant = (area: string, modes: Record<string, string>) => setAccess(db, 'bot', 'alice', area, normalizeModes(modes, ['read', 'write', 'delete']))
const call = (name: string, input: Record<string, unknown> = {}) => callTool(registry, base, name, input) as Promise<any>

test('notes: no grant, nothing; read grant cannot write', async () => {
	await expect(call('notes_note_list')).rejects.toMatchObject({ code: 'forbidden' })
	await grant('notes', { read: 'allowed' })
	expect((await call('notes_note_list')).total).toBe(3)
	await expect(call('notes_note_create', { title: 'x' })).rejects.toMatchObject({ code: 'forbidden' })
	expect(calls.some((c) => c.startsWith('create'))).toBe(false)
	// The notes grant does not open activity.
	await expect(call('activity_list')).rejects.toMatchObject({ code: 'forbidden' })
})

test('notes list: newest first, no content, filters, paging', async () => {
	await grant('notes', { read: 'allowed' })
	const p = await call('notes_note_list', { limit: 2 })
	expect(p.notes.map((n: { title: string }) => n.title)).toEqual(['Courses', 'Réunion lundi'])
	expect(p.notes[0].content).toBeUndefined()
	expect(p.notes[0].excerpt).toBe('lait\npain')
	expect(p.notes[0].modified).toBe('2023-11-14T22:18:20Z')
	expect(p.next_cursor).toBe('2')
	expect(p.categories).toEqual(['Work/Meetings', 'Work'])
	expect((await call('notes_note_list', { cursor: '2' })).notes.map((n: { id: number }) => n.id)).toEqual([3])
	expect((await call('notes_note_list', { category: 'Work' })).total).toBe(2)
	expect((await call('notes_note_list', { favorite: true })).notes.map((n: { id: number }) => n.id)).toEqual([1])
	expect((await call('notes_note_list', { query: 'ordre' })).notes.map((n: { id: number }) => n.id)).toEqual([2])
	await expect(call('notes_note_list', { cursor: '-1' })).rejects.toMatchObject({ code: 'invalid_input' })
})

test('notes get: content sliced for long notes', async () => {
	await grant('notes', { read: 'allowed' })
	const g = await call('notes_note_get', { id: 3 })
	expect(g.content.length).toBe(20000)
	expect(g).toMatchObject({ content_length: 30000, truncated: true })
	const rest = await call('notes_note_get', { id: 3, offset: 20000 })
	expect(rest.content.length).toBe(10000)
	expect(rest.truncated).toBe(false)
	await expect(call('notes_note_get', { id: 999 })).rejects.toMatchObject({ code: 'not_found' })
	await expect(call('notes_note_get', { id: 0 })).rejects.toMatchObject({ code: 'invalid_input' })
})

test('notes create / update / append; etag guards', async () => {
	await grant('notes', { read: 'allowed', write: 'allowed' })
	await expect(call('notes_note_create', {})).rejects.toMatchObject({ code: 'invalid_input' })
	const c = await call('notes_note_create', { content: 'Liste\n- a', category: 'Perso' })
	expect(calls.at(-1)).toBe('create alice {"content":"Liste\\n- a","category":"Perso"}')
	expect(c.title).toBe('Liste')
	await expect(call('notes_note_update', { id: c.id })).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(call('notes_note_update', { id: c.id, etag: c.etag })).rejects.toMatchObject({ code: 'invalid_input' })
	const u = await call('notes_note_update', { id: c.id, append: '- b', etag: c.etag })
	expect(u.content).toBe('Liste\n- a\n- b')
	await expect(call('notes_note_update', { id: c.id, append: '- c', etag: c.etag })).rejects.toMatchObject({ code: 'conflict' })
})

test('notes delete: approval by default, void if edited, executes otherwise', async () => {
	await grant('notes', { read: 'allowed', write: 'allowed' })
	const p1 = await call('notes_note_delete', { id: 2 })
	expect(p1.status).toBe('pending_approval')
	expect((await approvals.get(p1.request_id))!.summary).toBe('Delete note "Réunion lundi" (Work/Meetings)')
	await call('notes_note_update', { id: 2, append: 'edited' })
	expect((await approvals.approve('alice', p1.request_id, null)).status).toBe('void')
	expect(notes.has(2)).toBe(true)

	const p2 = await call('notes_note_delete', { id: 2 })
	const done = await approvals.approve('alice', p2.request_id, null)
	expect(done.status).toBe('executed')
	expect(done.result).toEqual({ id: 2, deleted: true, title: 'Réunion lundi', in_trash_bin: true })
	expect(notes.has(2)).toBe(false)

	await grant('notes', { read: 'allowed', write: 'allowed', delete: 'off' })
	await expect(call('notes_note_delete', { id: 1 })).rejects.toMatchObject({ code: 'forbidden' })
})

test('activity: read only, absolute links, cursor paging, filters passed through', async () => {
	await grant('activity', { read: 'allowed' })
	const p1 = await call('activity_list', { limit: 2 })
	expect(p1.activities.map((a: { activity_id: number }) => a.activity_id)).toEqual([3, 2])
	expect(p1.activities[0]).toMatchObject({ time: '2023-11-14T22:13:23Z', link: 'https://atrium.test/apps/files/?fileid=43', by: 'alice' })
	expect(p1.next_cursor).toBe('2')
	const p2 = await call('activity_list', { limit: 2, cursor: p1.next_cursor })
	expect(p2.activities.map((a: { activity_id: number }) => a.activity_id)).toEqual([1])
	expect(p2.next_cursor).toBeNull()
	await call('activity_list', { filter: 'by', object_type: 'files', object_id: 42 })
	expect(calls.at(-1)).toBe('activity alice {"since":0,"limit":30,"filter":"by","object_type":"files","object_id":42}')
	expect((await call('activity_filters')).filters.map((f: { id: string }) => f.id)).toEqual(['all', 'files'])
	await expect(call('activity_list', { cursor: 'abc' })).rejects.toMatchObject({ code: 'invalid_input' })
	expect(registry.all().filter((t) => t.area === 'activity').every((t) => (t.action ?? 'read') === 'read')).toBe(true)
})
