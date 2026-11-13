// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Journal of agent actions and undo (P3-7), over stub app tools with real
// grants, approvals and callTool: what is logged (changes only, direct or
// approved), what Undo runs (the inverse, as the agent, for the grantor, once),
// failures, ownership, paging and the 30-day window.
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { normalizeModes, setAccess } from './access'
import { Approvals } from './approvals'
import { type Db, migrate, wrap } from './db'
import { Journal, JOURNAL_DAYS, resetJournalCache, summarize, UNDO } from './journal'
import { int, obj, str } from './schema'
import { buildCtx, callTool, Registry, type Tool, type ToolCtx } from './tools'
import { AgentError, nowSec } from './util'

let db: Db
let registry: Registry
let approvals: Approvals
let journal: Journal
let base: Omit<ToolCtx, 'grantor' | 'access'>
let contacts: Map<string, string>
let trash: Map<string, [string, string]>
let ran: Array<[string, string, string, Record<string, unknown>]>
let restoreFails: Error | null

const tools: Tool[] = [
	{ name: 'contacts_contact_list', description: '', area: 'contacts', input: obj({}), run: async () => ({ contacts: [...contacts.keys()] }) },
	{
		name: 'contacts_contact_create', description: '', area: 'contacts', action: 'write', input: obj({ name: str() }, ['name']),
		run: async (ctx, i) => {
			ran.push(['create', ctx.agent.uid, ctx.grantor, i])
			const id = `1/c${contacts.size + trash.size + 1}.vcf`
			contacts.set(id, String(i.name))
			return { contact_id: id, name: i.name }
		},
	},
	{
		name: 'contacts_contact_delete', description: '', area: 'contacts', action: 'delete', input: obj({ contact_id: str() }, ['contact_id']),
		prepare: async (_ctx, i) => {
			const name = contacts.get(String(i.contact_id))
			if (!name) throw new AgentError('not_found', 'No such contact')
			return { payload: { contact_id: i.contact_id }, summary: `Delete contact: ${name}` }
		},
		execute: async (ctx, p) => {
			const id = String((p as { contact_id: string }).contact_id)
			ran.push(['delete', ctx.agent.uid, ctx.grantor, { contact_id: id }])
			const rid = `r${trash.size + 1}`
			trash.set(rid, [id, contacts.get(id)!])
			contacts.delete(id)
			return { contact_id: id, deleted: true, restore_id: rid }
		},
	},
	{
		name: 'contacts_contact_restore', description: '', area: 'contacts', action: 'write', input: obj({ restore_id: str() }, ['restore_id']),
		run: async (ctx, i) => {
			ran.push(['restore', ctx.agent.uid, ctx.grantor, i])
			if (restoreFails) throw restoreFails
			const t = trash.get(String(i.restore_id))
			if (!t) throw new AgentError('not_found', 'Nothing to restore')
			trash.delete(String(i.restore_id))
			contacts.set(t[0], t[1])
			return { restored: true }
		},
	},
	{ name: 'files_mkdir', description: '', area: 'files', action: 'write', input: obj({ path: str() }, ['path']), run: async (_c, i) => ({ path: i.path, file_id: 9 }) },
	{ name: 'nothing_null', description: '', area: null, input: obj({ n: int() }), run: async () => ({ ok: true }) },
]

const modes = (m: Record<string, string>) => normalizeModes(m, ['read', 'write', 'delete'])

beforeEach(async () => {
	resetJournalCache()
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	contacts = new Map()
	trash = new Map()
	ran = []
	restoreFails = null
	registry = new Registry()
	registry.add(...tools)
	approvals = new Approvals(db, null, 'https://x/settings/agents')
	approvals.registry = registry
	base = { db, php: null as never, agent: { uid: 'bot', displayName: 'Bot', owner: 'alice' }, baseUrl: 'https://atrium.test', approvals }
	approvals.ctxFor = async (agent, grantor) => buildCtx({ ...base, agent: { uid: agent, displayName: agent, owner: 'alice' } }, grantor)
	journal = new Journal(db, registry)
	journal.ctxFor = approvals.ctxFor
	await setAccess(db, 'bot', 'alice', 'contacts', modes({ read: 'allowed', write: 'allowed', delete: 'allowed' }))
	await setAccess(db, 'bot', 'alice', 'files', modes({ read: 'allowed', write: 'allowed' }))
})

const call = (name: string, input: Record<string, unknown> = {}) => callTool(registry, base, name, input) as Promise<any>
const events = async () => (await db.q<{ type: string, agent_uid: string, data: string }>(`SELECT type, agent_uid, data FROM ${db.t('atrium_agent_event_queue')} WHERE type LIKE 'action.%'`))

test('changes are logged with a summary and an undo; reads and base tools are not', async () => {
	await call('contacts_contact_create', { name: 'Ada' })
	await call('contacts_contact_list')
	await call('files_mkdir', { path: '/Projects' })
	await call('nothing_null', { n: 1 })
	await call('contacts_contact_delete', { contact_id: '1/c1.vcf' })
	const { actions } = await journal.list('alice')
	expect(actions.map((a) => [a.tool, a.summary, a.undo])).toEqual([
		['contacts_contact_delete', 'Delete contact: Ada', 'Restore the contact'],
		['files_mkdir', 'New folder: /Projects', null],
		['contacts_contact_create', 'New contact: Ada', 'Delete the contact (a copy is kept 30 days)'],
	])
	expect(actions[0]).toMatchObject({ agent: 'bot', area: 'contacts', request_id: null, undone_at: null })
	expect((await journal.list('bob')).actions).toEqual([])
})

test('an approved action is logged with the request summary and id', async () => {
	await setAccess(db, 'bot', 'alice', 'contacts', modes({ read: 'allowed', write: 'allowed', delete: 'approval' }))
	contacts.set('1/x.vcf', 'Grace')
	const p = await call('contacts_contact_delete', { contact_id: '1/x.vcf' })
	expect((await journal.list('alice')).actions).toEqual([])
	await approvals.approve('alice', p.request_id, null)
	const [a] = (await journal.list('alice')).actions
	expect(a).toMatchObject({ tool: 'contacts_contact_delete', summary: 'Delete contact: Grace', request_id: p.request_id, undo: 'Restore the contact' })
})

test('undo runs the inverse as the agent for the grantor, once; gated inverse needs no new approval', async () => {
	await call('contacts_contact_create', { name: 'Ada' })
	await setAccess(db, 'bot', 'alice', 'contacts', modes({ read: 'allowed', write: 'allowed', delete: 'approval' }))
	const [a] = (await journal.list('alice')).actions
	const r = await journal.undo('alice', a.action_id)
	expect(ran.at(-1)).toEqual(['delete', 'bot', 'alice', { contact_id: '1/c1.vcf' }])
	expect(contacts.size).toBe(0)
	expect(r).toMatchObject({ action_id: a.action_id, undo: null, result: { deleted: true, restore_id: 'r1' } })
	expect(r.undone_at).not.toBeNull()
	await expect(journal.undo('alice', a.action_id)).rejects.toMatchObject({ code: 'conflict' })
	expect(ran.filter(([op]) => op === 'delete')).toHaveLength(1)
	const ev = await events()
	expect(ev.map((e) => [e.type, e.agent_uid])).toEqual([['action.undone', 'bot']])
	expect(JSON.parse(ev[0].data)).toMatchObject({ action_id: a.action_id, tool: 'contacts_contact_create', undo_tool: 'contacts_contact_delete' })
	// The undo itself is the owner's act: not logged as an agent action.
	expect((await journal.list('alice')).actions).toHaveLength(1)
})

test('two undo clicks at once run the inverse once', async () => {
	await call('contacts_contact_create', { name: 'Ada' })
	await call('contacts_contact_delete', { contact_id: '1/c1.vcf' })
	const [del] = (await journal.list('alice')).actions
	const both = await Promise.allSettled([journal.undo('alice', del.action_id), journal.undo('alice', del.action_id)])
	expect(both.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected'])
	expect(ran.filter(([op]) => op === 'restore')).toHaveLength(1)
	expect(contacts.get('1/c1.vcf')).toBe('Ada')
})

test('ownership, nothing to undo, failure kept for a retry', async () => {
	await call('contacts_contact_create', { name: 'Ada' })
	await call('contacts_contact_delete', { contact_id: '1/c1.vcf' })
	await call('files_mkdir', { path: '/P' })
	const [mk, del] = (await journal.list('alice')).actions
	await expect(journal.undo('bob', del.action_id)).rejects.toMatchObject({ code: 'not_found' })
	await expect(journal.undo('alice', 'act_nope')).rejects.toMatchObject({ code: 'not_found' })
	await expect(journal.undo('alice', mk.action_id)).rejects.toMatchObject({ code: 'conflict' })

	restoreFails = new Error('db down, secret detail')
	const e = await journal.undo('alice', del.action_id).catch((x) => x)
	expect(e).not.toBeInstanceOf(AgentError)
	expect(e.message).toBe('Could not undo')
	const failed = (await journal.list('alice')).actions[1]
	expect(failed).toMatchObject({ undone_at: null, undo_error: 'The undo failed', undo: 'Restore the contact' })
	restoreFails = null
	expect((await journal.undo('alice', del.action_id)).undo_error).toBeNull()
	expect(contacts.get('1/c1.vcf')).toBe('Ada')

	// An inverse that finds nothing (already restored elsewhere): conflict, explained.
	await call('contacts_contact_delete', { contact_id: '1/c1.vcf' })
	const [again] = (await journal.list('alice')).actions
	trash.clear()
	await expect(journal.undo('alice', again.action_id)).rejects.toMatchObject({ code: 'conflict', message: 'Could not undo: Nothing to restore' })
})

test('paging, agent filter, 30-day window', async () => {
	for (const n of ['A', 'B', 'C']) await call('contacts_contact_create', { name: n })
	await setAccess(db, 'bot2', 'alice', 'contacts', modes({ read: 'allowed', write: 'allowed' }))
	await callTool(registry, { ...base, agent: { uid: 'bot2', displayName: 'B2', owner: 'alice' } }, 'contacts_contact_create', { name: 'D' })
	const p1 = await journal.list('alice', { limit: 2 })
	expect(p1.actions.map((a) => a.summary)).toEqual(['New contact: D', 'New contact: C'])
	const p2 = await journal.list('alice', { limit: 2, cursor: p1.next_cursor! })
	expect(p2.actions.map((a) => a.summary)).toEqual(['New contact: B', 'New contact: A'])
	expect(p2.next_cursor).toBeNull()
	expect((await journal.list('alice', { agent: 'bot2' })).actions).toHaveLength(1)
	await expect(journal.list('alice', { cursor: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })

	const old = nowSec() - JOURNAL_DAYS * 86400 - 10
	const [a] = (await journal.list('alice', { agent: 'bot' })).actions
	await db.q(`UPDATE ${db.t('atrium_agent_actions')} SET created_at = $1 WHERE action_id = $2`, [old, a.action_id])
	await expect(journal.undo('alice', a.action_id)).rejects.toMatchObject({ code: 'conflict' })
	expect((await journal.list('alice')).actions.map((x) => x.action_id)).not.toContain(a.action_id)
})

test('a journal failure never fails the action', async () => {
	await journal.list('alice')
	await db.q(`DROP TABLE ${db.t('atrium_agent_actions')}`)
	expect(await call('contacts_contact_create', { name: 'Ada' })).toMatchObject({ contact_id: '1/c1.vcf' })
})

test('undo rules: built from the result only, null when unsure', () => {
	const u = (t: string, i: Record<string, unknown>, r: Record<string, unknown>) => UNDO[t](i, r)
	expect(u('todo_item_create', {}, { item_id: 5 })).toMatchObject({ tool: 'todo_item_delete', input: { item_id: 5 } })
	expect(u('todo_item_delete', {}, { trash_id: 3 })).toMatchObject({ tool: 'todo_item_restore', input: { trash_id: 3 } })
	expect(u('todo_item_postpone', {}, { trash_id: 4 })).toMatchObject({ tool: 'todo_item_restore', input: { trash_id: 4 } })
	expect(u('todo_item_complete', {}, { item_id: 5, done: true })).toMatchObject({ input: { item_id: 5, done: false }, label: 'Untick it' })
	expect(u('task_complete', {}, { task_id: 't', done: false })).toMatchObject({ input: { task_id: 't', done: true } })
	expect(u('notes_note_create', {}, { id: 7 })).toMatchObject({ tool: 'notes_note_delete', input: { id: 7 } })
	expect(u('calendar_event_create', {}, { event_id: 'c/e' })).toMatchObject({ tool: 'calendar_event_delete', input: { event_id: 'c/e' } })
	expect(u('task_create', {}, { task_id: 'c/t' })).toMatchObject({ tool: 'task_delete', input: { task_id: 'c/t' } })
	expect(u('files_share', {}, { share_id: 'ocinternal:2' })).toMatchObject({ tool: 'files_unshare', input: { share_id: 'ocinternal:2' } })
	expect(u('files_move', { path: '/a.md', to: '/b.md' }, { file_id: 3 })).toMatchObject({ tool: 'files_move', input: { file_id: 3, to: '/a.md' } })
	expect(u('files_move', { file_id: 3, to: '/b.md' }, { file_id: 3 })).toBeNull()
	expect(u('files_write', { path: '/n.md', create_only: true }, { file_id: 8 })).toMatchObject({ tool: 'files_delete', input: { file_id: 8 } })
	expect(u('files_write', { path: '/n.md' }, { file_id: 8 })).toBeNull()
	expect(u('mail_draft_create', {}, { draft_key: 'd1' })).toMatchObject({ tool: 'mail_draft_delete', input: { draft_key: 'd1' } })
	expect(u('contacts_contact_create', {}, {})).toBeNull()
	expect(UNDO.mail_send).toBeUndefined()
	expect(summarize('notes_note_create', { content: 'x' }, { id: 7, title: 'Shopping' })).toBe('New note: Shopping')
	expect(summarize('files_mkdir', { path: '/P' }, { title: 'ignored' })).toBe('New folder: /P')
	expect(summarize('x_y', {}, {})).toBe('x_y')
})
