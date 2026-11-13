// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Files tools (P3-4) over a fake PHP bridge, with real grants and approvals:
// addressing (path xor file_id), paging, writes, delete and share through the
// approval inbox, void when the item changed. PHP is exercised on the dev
// stack (reports/P3-4.md).
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { normalizeModes, setAccess } from '../access'
import { Approvals } from '../approvals'
import { type Db, migrate, wrap } from '../db'
import { callTool, Registry, type ToolCtx } from '../tools'
import { AgentError } from '../util'
import { type FilesBridge, filesTools, type PhpNode, type PhpShare } from './index'

let db: Db
let nodes: Map<number, PhpNode & { content?: string }>
let shares: PhpShare[]
let calls: Array<[string, Record<string, unknown>]>
let nextId = 100

const node = (file_id: number, path: string, f: Partial<PhpNode & { content: string }> = {}): PhpNode & { content?: string } => ({
	file_id, path, name: path.split('/').pop() || '', type: 'file', mime: 'text/markdown', size: 10, modified: 1_700_000_000, etag: `e${file_id}a`,
	can: { write: true, delete: true, share: true }, shared_with_me: false, ...f,
})

function find(t: Record<string, unknown>) {
	const n = t.file_id ? nodes.get(Number(t.file_id)) : [...nodes.values()].find((x) => x.path === (t.path === '/' ? '/' : String(t.path)))
	if (!n) throw new AgentError('not_found', 'Not found')
	return n
}

const fake: FilesBridge = {
	async call<T>(uid: string, op: string, b: Record<string, unknown>): Promise<T> {
		calls.push([op, b])
		expect(uid).toBe('alice')
		const n = (): PhpNode & { content?: string } => find(b)
		switch (op) {
			case 'stat': return n() as T
			case 'list': {
				const dir = n()
				const kids = [...nodes.values()].filter((x) => x.path !== dir.path && x.path.startsWith(dir.path === '/' ? '/' : dir.path + '/') && !x.path.slice(dir.path.length + 1).includes('/'))
				return { folder: dir, entries: kids.slice(Number(b.offset), Number(b.offset) + Number(b.limit)), total: kids.length } as T
			}
			case 'read': return { ...n(), encoding: b.binary ? 'base64' : 'text', content: b.binary ? btoa(n().content ?? '') : n().content } as T
			case 'write': {
				const existing = [...nodes.values()].find((x) => x.path === b.path)
				if (existing && b.etag && existing.etag !== b.etag) throw new AgentError('conflict', 'The file changed since it was read')
				const id = existing?.file_id ?? nextId++
				const w = node(id, String(b.path), { content: String(b.content), etag: `e${id}${Date.now()}` })
				nodes.set(id, w)
				return w as T
			}
			case 'delete': {
				const d = n()
				if (b.etag && d.etag !== b.etag) throw new AgentError('conflict', 'Changed since the request')
				nodes.delete(d.file_id)
				return { deleted: true, in_trash_bin: true, item: d } as T
			}
			case 'shares': return { shares: b.file_id ? shares.filter((s) => s.file_id === b.file_id) : shares } as T
			case 'share': {
				const s: PhpShare = { share_id: `ocinternal:${shares.length + 1}`, type: b.type as PhpShare['type'], with: b.type === 'link' ? null : String(b.with), path: n().path, file_id: Number(b.file_id), permission: b.permission as 'read', expires: (b.expire_date as string) ?? null, has_password: false, url: b.type === 'link' ? 'https://atrium.test/s/abc' : null, note: null }
				shares.push(s)
				return s as T
			}
			case 'unshare': shares = shares.filter((s) => s.share_id !== b.share_id); return { unshared: true } as T
			default: return n() as T
		}
	},
}

let registry: Registry
let approvals: Approvals
let base: Omit<ToolCtx, 'grantor' | 'access'>

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	calls = []
	shares = []
	nodes = new Map([
		[1, node(1, '/', { type: 'folder', mime: null, name: '' })],
		[2, node(2, '/Documents', { type: 'folder', mime: null })],
		[3, node(3, '/Documents/plan.md', { content: '# Plan' })],
		[4, node(4, '/Bienvenue.md', { content: 'Hello' })],
		[5, node(5, '/Shared/theirs.txt', { shared_with_me: true, can: { write: false, delete: true, share: false } })],
	])
	approvals = new Approvals(db, null, 'https://x/settings/agents')
	registry = new Registry()
	registry.add(...filesTools(fake))
	approvals.registry = registry
	base = { db, php: null as never, agent: { uid: 'bot', displayName: 'Bot', owner: 'alice' }, baseUrl: 'https://atrium.test', approvals }
	approvals.ctxFor = async (_agent, grantor) => ({ ...base, grantor, access: {} } as ToolCtx)
})

const grant = (modes: Record<string, string>) => setAccess(db, 'bot', 'alice', 'files', normalizeModes(modes, ['read', 'write', 'delete', 'share']))
const call = (name: string, input: Record<string, unknown> = {}) => callTool(registry, base, name, input) as Promise<any>

test('grants: none, read only', async () => {
	await expect(call('files_list')).rejects.toMatchObject({ code: 'forbidden' })
	await grant({ read: 'allowed' })
	expect((await call('files_list')).entries.map((e: { path: string }) => e.path)).toEqual(['/Documents', '/Bienvenue.md'])
	await expect(call('files_write', { path: '/x.txt', content: 'x' })).rejects.toMatchObject({ code: 'forbidden' })
	await expect(call('files_mkdir', { path: '/x' })).rejects.toMatchObject({ code: 'forbidden' })
	expect(calls.some(([op]) => op === 'write' || op === 'mkdir')).toBe(false)
})

test('addressing: path xor file_id; paging; ISO dates', async () => {
	await grant({ read: 'allowed' })
	await expect(call('files_get', {})).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(call('files_get', { path: '/Bienvenue.md', file_id: 4 })).rejects.toMatchObject({ code: 'invalid_input' })
	const g = await call('files_get', { file_id: 3 })
	expect(g).toMatchObject({ path: '/Documents/plan.md', modified: '2023-11-14T22:13:20Z' })
	const p = await call('files_list', { limit: 1 })
	expect(p.next_cursor).toBe('1')
	expect((await call('files_list', { cursor: p.next_cursor })).entries.map((e: { path: string }) => e.path)).toEqual(['/Bienvenue.md'])
	expect((await call('files_read', { path: '/Documents/plan.md' })).content).toBe('# Plan')
	expect((await call('files_read', { file_id: 4, binary: true })).content).toBe(btoa('Hello'))
	await expect(call('files_search', { query: 'a' })).rejects.toMatchObject({ code: 'invalid_input' })
})

test('write: options passed through, etag conflict', async () => {
	await grant({ read: 'allowed', write: 'allowed' })
	const w = await call('files_write', { path: '/Documents/new.md', content: 'hi', create_parents: true })
	expect(calls.at(-1)).toEqual(['write', { path: '/Documents/new.md', content: 'hi', encoding: 'text', etag: null, create_only: false, create_parents: true }])
	await call('files_write', { path: '/Documents/new.md', content: 'v2', etag: w.etag })
	await expect(call('files_write', { path: '/Documents/new.md', content: 'v3', etag: w.etag })).rejects.toMatchObject({ code: 'conflict' })
	await expect(call('files_write', { path: '/a', content: 'x', encoding: 'hex' })).rejects.toMatchObject({ code: 'invalid_input' })
})

test('delete: approval by default, summary, void if changed, then executed', async () => {
	await grant({ read: 'allowed', write: 'allowed' })
	await expect(call('files_delete', { path: '/' })).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(call('files_share', { path: '/', type: 'link' })).rejects.toMatchObject({ code: 'invalid_input' })
	const p1 = await call('files_delete', { path: '/Documents/plan.md' })
	expect(p1.status).toBe('pending_approval')
	expect((await approvals.get(p1.request_id))!.summary).toBe('Delete /Documents/plan.md (10 bytes)')
	nodes.set(3, { ...nodes.get(3)!, etag: 'changed' })
	expect((await approvals.approve('alice', p1.request_id, null)).status).toBe('void')
	expect(nodes.has(3)).toBe(true)
	const p2 = await call('files_delete', { file_id: 3 })
	const done = await approvals.approve('alice', p2.request_id, null)
	expect(done.status).toBe('executed')
	expect(done.result).toMatchObject({ deleted: true, in_trash_bin: true, item: { path: '/Documents/plan.md' } })
	expect(nodes.has(3)).toBe(false)
})

test('share: approval with a clear summary; link has no with; reshare refused; unshare', async () => {
	await grant({ read: 'allowed', write: 'allowed' })
	await expect(call('files_share', { path: '/Bienvenue.md', type: 'user' })).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(call('files_share', { path: '/Bienvenue.md', type: 'link', with: 'bob' })).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(call('files_share', { path: '/Bienvenue.md', type: 'link', expire_date: '13/11/2026' })).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(call('files_share', { path: '/Shared/theirs.txt', type: 'user', with: 'bob' })).rejects.toMatchObject({ code: 'forbidden' })
	await expect(call('files_share', { path: '/Bienvenue.md', type: 'user', with: 'bob', password: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })

	const p = await call('files_share', { path: '/Bienvenue.md', type: 'link', permission: 'read', expire_date: '2026-12-31' })
	expect((await approvals.get(p.request_id))!.summary).toBe('Share /Bienvenue.md as a public link (read, until 2026-12-31)')
	expect(shares).toEqual([])
	const done = await approvals.approve('alice', p.request_id, null)
	expect(done.result).toMatchObject({ type: 'link', url: 'https://atrium.test/s/abc', expires: '2026-12-31' })
	expect(calls.at(-1)).toEqual(['share', { file_id: 4, type: 'link', with: '', permission: 'read', expire_date: '2026-12-31', note: '' }])

	const p2 = await call('files_share', { file_id: 3, type: 'user', with: 'bob', permission: 'edit' })
	expect((await approvals.get(p2.request_id))!.summary).toBe('Share /Documents/plan.md with user bob (edit)')
	nodes.delete(3)
	expect((await approvals.approve('alice', p2.request_id, null)).status).toBe('void')

	expect((await call('files_share_list', { path: '/Bienvenue.md' })).shares).toHaveLength(1)
	const u = await call('files_unshare', { share_id: 'ocinternal:1' })
	expect((await approvals.get(u.request_id))!.summary).toBe('Stop sharing /Bienvenue.md (public link)')
	await approvals.approve('alice', u.request_id, null)
	expect(shares).toEqual([])
	await expect(call('files_unshare', { share_id: 'nope' })).rejects.toMatchObject({ code: 'not_found' })
})

test('share and delete allowed outright run at once; off refuses', async () => {
	await grant({ read: 'allowed', write: 'allowed', delete: 'allowed', share: 'allowed' })
	expect(await call('files_share', { path: '/Bienvenue.md', type: 'group', with: 'team' })).toMatchObject({ type: 'group', with: 'team' })
	expect(await call('files_delete', { path: '/Bienvenue.md' })).toMatchObject({ deleted: true })
	await grant({ read: 'allowed', write: 'allowed', delete: 'off', share: 'off' })
	await expect(call('files_delete', { file_id: 3 })).rejects.toMatchObject({ code: 'forbidden' })
	await expect(call('files_share', { file_id: 3, type: 'link' })).rejects.toMatchObject({ code: 'forbidden' })
})
