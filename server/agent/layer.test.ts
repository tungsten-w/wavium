// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { normalizeModes, presetAccess, setAccess, tokenScopes, updateSettings } from './access'
import { Approvals } from './approvals'
import { parseConfigPhp, toNcConfig } from './config'
import { type Db, migrate, wrap } from './db'
import { Doorbell, enqueue, EventLog, eventsSince, formatCursor, parseCursor } from './events'
import { handleMcp } from './mcp'
import { validate, obj, str, int, arr } from './schema'
import { callTool, Registry, type Tool, type ToolCtx } from './tools'
import { AgentError, hmacHex, stableJson, ulid } from './util'

let db: Db

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
})

test('config.php parsing', () => {
	const src = `<?php\n$CONFIG = array (\n  'secret' => 'ab\\'c',\n  'dbtype' => 'pgsql',\n  'dbhost' => 'db:5433',\n  'overwrite.cli.url' => 'https://nc.example/',\n  'trusted_domains' => \n  array (\n    0 => 'x',\n  ),\n  'debug' => true,\n);`
	const cfg = toNcConfig(parseConfigPhp(src), '/var/www/html')
	expect(cfg.secret).toBe("ab'c")
	expect(cfg.dbhost).toBe('db')
	expect(cfg.dbport).toBe('5433')
	expect(cfg.baseUrl).toBe('https://nc.example')
	expect(cfg.dbtableprefix).toBe('oc_')
})

test('migrations are idempotent', async () => {
	await migrate(db)
	const rows = await db.q<{ v: string }>(`SELECT v FROM oc_atrium_agent_meta WHERE k = 'schema'`)
	expect(rows[0].v).toBe('2')
})

test('schema validation', () => {
	const s = obj({ a: str(undefined, { maxLength: 3 }), n: int(undefined, { maximum: 5 }), l: arr(str()), c: { type: ['string', 'array'], items: str() } }, ['a'])
	expect(validate(s, { a: 'x' })).toEqual([])
	expect(validate(s, {})).toEqual(['input.a: required'])
	expect(validate(s, { a: 'long' })[0]).toContain('too long')
	expect(validate(s, { a: 'x', n: 9 })[0]).toContain('above 5')
	expect(validate(s, { a: 'x', zz: 1 })[0]).toContain('unknown field')
	expect(validate(s, { a: 'x', l: [1] })[0]).toContain('input.l[0]')
	expect(validate(s, { a: 'x', c: ['a'] })).toEqual([])
	expect(validate(s, { a: 'x', c: 3 })[0]).toContain('expected string or array')
})

test('modes: write implies read, gated actions default to approval, no read = nothing', () => {
	const all = ['read', 'write', 'delete', 'send', 'share'] as const
	expect(normalizeModes({ write: 'allowed' }, [...all])).toEqual({ read: 'allowed', write: 'allowed', delete: 'approval', send: 'approval', share: 'approval' })
	expect(normalizeModes({ read: 'approval' }, [...all]).read).toBe('allowed')
	expect(normalizeModes({ read: 'off', send: 'allowed' }, [...all]).send).toBe('off')
	expect(normalizeModes({ read: 'allowed', delete: 'off' }, ['read', 'delete'])).toEqual({ read: 'allowed', delete: 'off' })
	expect(tokenScopes({ mail: { read: 'allowed', write: 'allowed', send: 'approval' } })).toEqual(['mail:read', 'mail:write'])
	expect(Object.keys(presetAccess('mail', { mail: [...all], files: ['read'] }))).toEqual(['mail'])
})

test('ids and stable json', () => {
	const a = ulid(1000)
	const b = ulid(2000)
	expect(a.length).toBe(26)
	expect(a < b).toBe(true)
	expect(stableJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}')
	expect(formatCursor(123)).toBe('c_000123')
	expect(parseCursor('c_000123')).toBe(123)
	expect(() => parseCursor('x')).toThrow(AgentError)
})

test('events: queue -> log in order, per-grant visibility, cursor paging, wake at delivery', async () => {
	const log = new EventLog(db, null, (async () => new Response('ok')) as never)
	await setAccess(db, 'bot', 'alice', 'mail', { read: 'allowed' })
	const start = await eventsSince(db, 'bot', {})
	expect(start.events).toEqual([])
	await enqueue(db, { app: 'mail', area: 'mail', type: 'mail.received', grantor: 'alice', wakeHint: true, data: { n: 1 }, dedupeKey: 'm1' })
	await enqueue(db, { app: 'mail', area: 'mail', type: 'mail.received', grantor: 'alice', wakeHint: true, data: { n: 1 }, dedupeKey: 'm1' })
	await enqueue(db, { app: 'mail', area: 'mail', type: 'mail.received', grantor: 'bob', wakeHint: true, data: { n: 2 } })
	await enqueue(db, { app: 'agent', area: 'mail', type: 'approval.approved', grantor: 'alice', agent: 'other', wakeHint: true, data: {} })
	await enqueue(db, { app: 'agent', area: 'mail', type: 'approval.rejected', grantor: 'alice', agent: 'bot', wakeHint: true, data: { n: 3 } })
	await log.tick()
	const got = await eventsSince(db, 'bot', { cursor: start.next_cursor })
	expect(got.events.map((e) => e.data)).toEqual([{ n: 1 }, { n: 3 }])
	expect(got.events[0].wake).toBe(false)
	expect(got.events[0].id).toMatch(/^evt_/)
	expect(got.has_more).toBe(false)
	// next_cursor jumps to the end of the log, past events this agent cannot see
	expect(got.next_cursor).toBe(formatCursor(4))
	await updateSettings(db, 'bot', { wakes: true })
	const again = await eventsSince(db, 'bot', { cursor: start.next_cursor, limit: 1 })
	expect(again.events.length).toBe(1)
	expect(again.events[0].wake).toBe(true)
	expect(again.has_more).toBe(true)
	const typed = await eventsSince(db, 'bot', { cursor: start.next_cursor, types: ['approval.*'] })
	expect(typed.events.map((e) => e.type)).toEqual(['approval.rejected'])
})

test('events: purge makes old cursors expire', async () => {
	const log = new EventLog(db, null)
	await setAccess(db, 'bot', 'alice', 'mail', { read: 'allowed' })
	await enqueue(db, { app: 'mail', area: 'mail', type: 't', grantor: 'alice', wakeHint: false, data: {} })
	await log.tick()
	await db.q(`UPDATE oc_atrium_agent_events SET occurred_at = 1`)
	await log.purge()
	await expect(eventsSince(db, 'bot', { cursor: 'c_000000' })).rejects.toMatchObject({ reason: 'cursor_expired' })
	expect((await eventsSince(db, 'bot', { cursor: 'c_000001' })).events).toEqual([])
})

test('doorbell: signed body, coalesced, 401 recorded and not retried', async () => {
	const calls: Array<{ url: string, body: string, ts: string, sig: string }> = []
	let status = 200
	const fetcher = (async (url: string, init: RequestInit) => {
		const h = init.headers as Record<string, string>
		calls.push({ url, body: String(init.body), ts: h['X-Atrium-Timestamp'], sig: h['X-Atrium-Signature'] })
		return new Response(null, { status })
	}) as never
	const notes: string[] = []
	const bell = new Doorbell(db, { notify: async (t) => { notes.push(t) } }, fetcher)
	await updateSettings(db, 'bot', { wakes: true, webhookUrl: 'http://hook.test/x', webhookSecret: 'sec' })
	await bell.ring('bot', 'c_000005', true)
	expect(calls.length).toBe(1)
	expect(JSON.parse(calls[0].body)).toEqual({ agent: 'bot', cursor: 'c_000005', wake: true })
	expect(calls[0].sig).toBe('sha256=' + hmacHex('sec', `${calls[0].ts}.${calls[0].body}`))
	status = 401
	await bell.ring('bot', 'c_000006', false)
	await bell.ring('bot', 'c_000007', false)
	expect(notes.length).toBe(1)
	const s = await db.q<{ doorbell_error: string }>(`SELECT doorbell_error FROM oc_atrium_agent_settings WHERE uid = 'bot'`)
	expect(s[0].doorbell_error).toContain('401')
	// paused: no doorbell
	await updateSettings(db, 'bot', { paused: true })
	const before = calls.length
	await bell.ring('bot', 'c_000008', true)
	expect(calls.length).toBe(before)
})

function fakeCtxBase(approvals: Approvals) {
	return { db, php: null as never, agent: { uid: 'bot', displayName: 'Bot', owner: 'alice' }, baseUrl: 'https://x', approvals }
}

test('tool calls: grants, approval queue, approve executes the frozen payload, void on change', async () => {
	const approvals = new Approvals(db, null, 'https://x/settings/agents')
	const executed: unknown[] = []
	let valid = true
	const send: Tool = {
		name: 'mail_send', description: '', area: 'mail', action: 'send',
		input: obj({ draft_key: str() }, ['draft_key']),
		prepare: async (_ctx, input) => ({ payload: { draft: input.draft_key, to: ['a@b'] }, summary: 'Send it', ref: String(input.draft_key) }),
		execute: async (_ctx, payload) => { executed.push(payload); return { ok: true } },
		stillValid: async () => valid,
	}
	const read: Tool = { name: 'mail_accounts', description: '', area: 'mail', input: obj({}), run: async () => ({ accounts: [] }) }
	const registry = new Registry()
	registry.add(send, read)
	approvals.registry = registry
	approvals.ctxFor = async (agent, grantor) => ({ ...fakeCtxBase(approvals), grantor, access: {} } as ToolCtx)
	const base = fakeCtxBase(approvals)

	await expect(callTool(registry, base, 'mail_accounts', {})).rejects.toMatchObject({ code: 'forbidden' })
	await setAccess(db, 'bot', 'alice', 'mail', normalizeModes({ read: 'allowed', write: 'allowed' }, ['read', 'write', 'send']))
	expect(await callTool(registry, base, 'mail.accounts', {})).toEqual({ accounts: [] })
	await expect(callTool(registry, base, 'mail_send', {})).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(callTool(registry, base, 'mail_accounts', { grantor: 'bob' })).rejects.toMatchObject({ code: 'forbidden' })

	const pending = await callTool(registry, base, 'mail_send', { draft_key: 'd1' }) as { status: string, request_id: string }
	expect(pending.status).toBe('pending_approval')
	expect(executed).toEqual([])
	await expect(approvals.approve('mallory', pending.request_id, null)).rejects.toMatchObject({ code: 'not_found' })
	const done = await approvals.approve('alice', pending.request_id, 'ok')
	expect(done.status).toBe('executed')
	expect(done.result).toEqual({ ok: true })
	expect(done.note).toBe('ok')
	expect(executed).toEqual([{ draft: 'd1', to: ['a@b'] }])
	await expect(approvals.approve('alice', pending.request_id, null)).rejects.toMatchObject({ code: 'conflict' })

	const p2 = await callTool(registry, base, 'mail_send', { draft_key: 'd2' }) as { request_id: string }
	await approvals.voidRef('bot', 'd2', 'draft changed')
	expect((await approvals.get(p2.request_id))!.status).toBe('void')

	const p3 = await callTool(registry, base, 'mail_send', { draft_key: 'd3' }) as { request_id: string }
	valid = false
	expect((await approvals.approve('alice', p3.request_id, null)).status).toBe('void')

	const p4 = await callTool(registry, base, 'mail_send', { draft_key: 'd4' }) as { request_id: string }
	expect((await approvals.cancel('bot', p4.request_id)).status).toBe('cancelled')
	const list = await approvals.list({ agent: 'bot' }, undefined, 2)
	expect(list.requests.length).toBe(2)
	expect(list.next_cursor).not.toBeNull()

	// approval events went to the queue for this agent only
	const q = await db.q<{ type: string, agent_uid: string }>(`SELECT type, agent_uid FROM oc_atrium_agent_event_queue ORDER BY id`)
	expect(q.map((r) => r.type)).toEqual(['approval.approved', 'approval.executed', 'approval.void', 'approval.approved', 'approval.void'])
	expect(new Set(q.map((r) => r.agent_uid))).toEqual(new Set(['bot']))

	// allowed mode runs directly
	await setAccess(db, 'bot', 'alice', 'mail', { read: 'allowed', write: 'allowed', send: 'allowed' })
	valid = true
	expect(await callTool(registry, base, 'mail_send', { draft_key: 'd5' })).toEqual({ ok: true })

	// paused agents are refused
	await updateSettings(db, 'bot', { paused: true })
	await expect(callTool(registry, base, 'mail_accounts', {})).rejects.toMatchObject({ reason: 'paused' })
})

test('mcp: initialize, notifications, tool errors', async () => {
	const backend = {
		list: async () => [{ name: 't', description: 'd', area: null, input: obj({}) } as Tool],
		call: async (name: string) => { if (name === 'bad') throw new AgentError('not_found', 'nope'); return { ok: 1 } },
	}
	const post = (body: unknown) => handleMcp(new Request('http://x/agent/mcp', { method: 'POST', body: JSON.stringify(body) }), backend)
	const init = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).json()
	expect(init.result.protocolVersion).toBe('2025-03-26')
	expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
	const list = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()
	expect(list.result.tools[0].inputSchema.properties.grantor.type).toBe('string')
	const ok = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 't', arguments: {} } })).json()
	expect(ok.result.structuredContent).toEqual({ ok: 1 })
	const bad = await (await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bad' } })).json()
	expect(bad.result.isError).toBe(true)
	expect(bad.result.structuredContent.error.code).toBe('not_found')
	const unknown = await (await post({ jsonrpc: '2.0', id: 5, method: 'nope' })).json()
	expect(unknown.error.code).toBe(-32601)
	expect((await handleMcp(new Request('http://x/agent/mcp'), backend)).status).toBe(405)
})
