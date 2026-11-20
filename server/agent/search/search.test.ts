// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cross-app search (P3-6) over stub app tools with real grants: only readable
// apps are queried, hits are mapped with an `open` call, one failing app does
// not hide the others, inputs passed to each app are what its tool expects.
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { normalizeModes, setAccess } from '../access'
import { Approvals } from '../approvals'
import { type Db, migrate, wrap } from '../db'
import { obj } from '../schema'
import { callTool, Registry, type Tool, type ToolCtx } from '../tools'
import { AgentError } from '../util'
import { searchTool } from './index'

let db: Db
let registry: Registry
let calls: Array<[string, string, Record<string, unknown>]>
let base: Omit<ToolCtx, 'grantor' | 'access'>
let fail: Record<string, Error> = {}

const NOW = new Date('2026-11-13T12:00:00Z')

const outputs: Record<string, unknown> = {
	mail_message_list: { messages: [
		{ message_key: 'm1', subject: 'Budget 2027', from: { name: 'Bob', email: 'bob@example.org' }, snippet: 'see attached', date: '2026-11-10T08:00:00Z' },
		{ message_key: 'm2', subject: 'Re: Budget 2027', from: null, snippet: 'ok', date: '2026-11-11T08:00:00Z' },
	], next_cursor: null },
	files_search: { results: [
		{ file_id: 7, path: '/Docs/budget.ods', name: 'budget.ods', type: 'file', mime: 'application/vnd.oasis.opendocument.spreadsheet', modified: '2026-11-01T00:00:00Z' },
		{ file_id: 8, path: '/Budget', name: 'Budget', type: 'folder', mime: null, modified: '2026-10-01T00:00:00Z' },
	] },
	contacts_contact_list: { contacts: [{ contact_id: '3/abc.vcf', name: 'Budget Office', org: 'City', emails: [{ value: 'budget@city.example', type: 'work' }], phones: [] }], total: 1, next_cursor: null },
	notes_note_list: { notes: [{ id: 12, title: 'Budget ideas', excerpt: 'cut costs', modified: '2026-11-12T00:00:00Z' }], total: 1, next_cursor: null, categories: [] },
	calendar_event_list: { events: [{ event_id: 'personal/e1.ics', title: 'Budget review', location: 'Room 2', start: '2026-11-20T09:00:00Z' }], truncated: false },
	task_list: { tasks: [{ task_id: 'personal/t1.ics', title: 'Send budget', status: 'needs-action', due: '2026-11-15', start: null }], truncated: false },
	messages_search: { results: [{ message_id: 'x1', conversation_id: 'c1', conversation_name: 'Léa', from: 'Léa', text: 'Le budget du voyage ?', at: '2026-11-14T10:00:00.000Z' }] },
}

const stub = (name: string, area: string): Tool => ({
	name, description: name, area, input: obj({}),
	run: async (ctx, input) => {
		calls.push([name, ctx.grantor, input])
		if (fail[name]) throw fail[name]
		return outputs[name]
	},
})

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	calls = []
	fail = {}
	registry = new Registry()
	registry.add(
		stub('mail_message_list', 'mail'), stub('files_search', 'files'), stub('contacts_contact_list', 'contacts'),
		stub('notes_note_list', 'notes'), stub('calendar_event_list', 'calendar'), stub('task_list', 'calendar'), stub('messages_search', 'messages'),
		searchTool(() => registry, undefined, () => NOW),
	)
	const approvals = new Approvals(db, null, 'https://x/settings/agents')
	approvals.registry = registry
	base = { db, php: null as never, agent: { uid: 'bot', displayName: 'Bot', owner: 'alice' }, baseUrl: 'https://atrium.test', approvals }
})

const grant = (area: string, grantor = 'alice') => setAccess(db, 'bot', grantor, area, normalizeModes({ read: 'allowed' }, ['read', 'write']))
const search = (input: Record<string, unknown>) => callTool(registry, base, 'search', input) as Promise<any>

test('no grant: nothing queried, every app skipped', async () => {
	const r = await search({ query: 'budget' })
	expect(r.results).toEqual([])
	expect(r.skipped.map((s: { app: string, reason: string }) => `${s.app}:${s.reason}`)).toEqual(['mail:no read access', 'files:no read access', 'contacts:no read access', 'notes:no read access', 'calendar:no read access', 'tasks:no read access', 'messages:no read access'])
	expect(calls).toEqual([])
})

test('only readable apps are queried; hits carry the call that opens them', async () => {
	await grant('mail')
	await grant('notes')
	await setAccess(db, 'bot', 'alice', 'files', normalizeModes({ read: 'off', write: 'off' }, ['read', 'write']))
	const r = await search({ query: '  budget ', limit: 1 })
	expect(r.query).toBe('budget')
	expect(calls.map(([n]) => n).sort()).toEqual(['mail_message_list', 'notes_note_list'])
	expect(calls.find(([n]) => n === 'mail_message_list')).toEqual(['mail_message_list', 'alice', { text: 'budget', limit: 1 }])
	expect(r.results).toEqual([
		{ app: 'mail', kind: 'message', id: 'm1', title: 'Budget 2027', snippet: 'Bob bob@example.org: see attached', date: '2026-11-10T08:00:00Z', open: { tool: 'mail_message_get', input: { message_key: 'm1' } } },
		{ app: 'notes', kind: 'note', id: 12, title: 'Budget ideas', snippet: 'cut costs', date: '2026-11-12T00:00:00Z', open: { tool: 'notes_note_get', input: { id: 12 } } },
	])
	expect(r.skipped.map((s: { app: string }) => s.app)).toEqual(['files', 'contacts', 'calendar', 'tasks', 'messages'])
	expect(r.errors).toEqual([])
})

test('every app mapped; inputs fit each tool; calendar window is one year around now', async () => {
	for (const a of ['mail', 'files', 'contacts', 'notes', 'calendar', 'messages']) await grant(a)
	const r = await search({ query: 'budget' })
	expect(r.skipped).toEqual([])
	const byApp = (app: string) => r.results.filter((h: { app: string }) => h.app === app)
	expect(byApp('files').map((h: { kind: string, open: unknown }) => [h.kind, h.open])).toEqual([
		['file', { tool: 'files_read', input: { file_id: 7 } }],
		['folder', { tool: 'files_list', input: { file_id: 8 } }],
	])
	expect(byApp('contacts')[0]).toMatchObject({ id: '3/abc.vcf', title: 'Budget Office', snippet: 'City · budget@city.example', open: { tool: 'contacts_contact_get', input: { contact_id: '3/abc.vcf' } } })
	expect(byApp('calendar')[0]).toMatchObject({ kind: 'event', snippet: 'Room 2', date: '2026-11-20T09:00:00Z', open: { tool: 'calendar_event_get', input: { event_id: 'personal/e1.ics' } } })
	expect(byApp('tasks')[0]).toMatchObject({ kind: 'task', date: '2026-11-15', open: { tool: 'task_get', input: { task_id: 'personal/t1.ics' } } })
	const input = (n: string) => calls.find(([x]) => x === n)![2]
	expect(input('calendar_event_list')).toEqual({ query: 'budget', limit: 5, from: '2026-05-15T12:00:00.000Z', to: '2027-05-14T12:00:00.000Z' })
	expect(input('task_list')).toEqual({ query: 'budget', limit: 5, status: 'all' })
	expect(input('files_search')).toEqual({ query: 'budget', limit: 5 })
	expect(input('contacts_contact_list')).toEqual({ query: 'budget', limit: 5 })
	expect(byApp('messages')[0]).toMatchObject({ kind: 'text', id: 'x1', title: 'Léa', snippet: 'Le budget du voyage ?', open: { tool: 'messages_message_list', input: { conversation_id: 'c1' } } })
})

test('apps filter, per-app limit, failing app reported without hiding the others', async () => {
	for (const a of ['mail', 'files', 'contacts']) await grant(a)
	const only = await search({ query: 'budget', apps: ['files'] })
	expect(calls.map(([n]) => n)).toEqual(['files_search'])
	expect(only.skipped).toEqual([])
	expect(only.results).toHaveLength(2)

	calls = []
	fail = { files_search: new AgentError('unavailable', 'Files is down'), contacts_contact_list: new Error('secret stack trace') }
	const r = await search({ query: 'budget', limit: 1 })
	expect(r.results.map((h: { id: string }) => h.id)).toEqual(['m1'])
	expect(r.errors).toEqual([
		{ app: 'files', code: 'unavailable', message: 'Files is down' },
		{ app: 'contacts', code: 'internal', message: 'The app search failed' },
	])
})

test('another grantor: their grants, not the owner\'s; bad input refused', async () => {
	await grant('notes', 'alice')
	await grant('mail', 'carol')
	const r = await search({ query: 'budget', grantor: 'carol' })
	expect(calls).toEqual([['mail_message_list', 'carol', { text: 'budget', limit: 5 }]])
	expect(r.results.every((h: { app: string }) => h.app === 'mail')).toBe(true)
	await expect(search({ query: ' a ' })).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(search({ query: 'budget', apps: ['wiki'] })).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(search({ query: 'budget', apps: [] })).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(search({ query: 'budget', limit: 50 })).rejects.toMatchObject({ code: 'invalid_input' })
})

test('an app not installed is skipped as such', async () => {
	const reg = new Registry()
	reg.add(stub('notes_note_list', 'notes'), searchTool(() => reg, undefined, () => NOW))
	await grant('notes')
	const r = await callTool(reg, base, 'search', { query: 'budget' }) as any
	expect(r.skipped.find((s: { app: string }) => s.app === 'mail')).toEqual({ app: 'mail', reason: 'not installed' })
	expect(r.results.map((h: { app: string }) => h.app)).toEqual(['notes'])
})
