// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Agent activity timeline (P2-8): actions and requests merged newest first,
// an executed request shown once (as its action), owner and agent filters,
// paging across both sources with same-second ties, and the request link in
// approval notifications.
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { Approvals } from './approvals'
import { type Db, migrate, wrap } from './db'
import { migrateJournal, resetJournalCache } from './journal'
import { obj, str } from './schema'
import type { Tool, ToolCtx } from './tools'
import { decodeCursor, timeline } from './timeline'
import { nowSec } from './util'

let db: Db
let n = 0
const T0 = nowSec() - 1000

beforeEach(async () => {
	resetJournalCache()
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	await migrateJournal(db)
	n = 0
})

async function action(at: number, f: { agent?: string, owner?: string, rid?: string | null, summary?: string } = {}) {
	n++
	await db.q(`INSERT INTO ${db.t('atrium_agent_actions')} (action_id, agent_uid, grantor_uid, area, tool, summary, request_id, undo, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		[`act_${n}`, f.agent ?? 'bot', f.owner ?? 'alice', 'files', 'files_mkdir', f.summary ?? `action ${n}`, f.rid ?? null, null, at])
}

async function request(at: number, status: string, f: { agent?: string, owner?: string, rid?: string, summary?: string } = {}) {
	n++
	const rid = f.rid ?? `apr_${n}`
	await db.q(`INSERT INTO ${db.t('atrium_agent_approvals')} (request_id, agent_uid, grantor_uid, tool, input, payload, payload_hash, summary, status, requested_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [rid, f.agent ?? 'bot', f.owner ?? 'alice', 'files_delete', '{}', '{}', 'h', f.summary ?? `request ${n}`, status, at, at + 3600])
	return rid
}

const summaries = (items: Array<{ summary: string }>) => items.map((i) => i.summary)

test('actions and requests merged, newest first; executed requests appear once, as their action', async () => {
	await action(T0 + 1, { summary: 'mkdir' })
	await request(T0 + 2, 'rejected', { summary: 'delete A (rejected)' })
	const rid = await request(T0 + 3, 'executed', { summary: 'delete B' })
	await action(T0 + 4, { rid, summary: 'delete B' })
	await request(T0 + 5, 'executed', { summary: 'old executed, no journal row' })
	await request(T0 + 6, 'pending', { summary: 'share C' })
	await action(T0 + 7, { owner: 'bob', summary: 'bob stuff' })
	const r = await timeline(db, 'alice')
	expect(summaries(r.items)).toEqual(['share C', 'old executed, no journal row', 'delete B', 'delete A (rejected)', 'mkdir'])
	expect(r.items[0]).toMatchObject({ kind: 'request', status: 'pending', agent: 'bot', tool: 'files_delete' })
	expect(r.items[2]).toMatchObject({ kind: 'action', request_id: rid })
	expect(r.next_cursor).toBeNull()
})

test('agent filter on both sources', async () => {
	await action(T0 + 1, { agent: 'a1', summary: 'a1 act' })
	await action(T0 + 2, { agent: 'a2', summary: 'a2 act' })
	await request(T0 + 3, 'pending', { agent: 'a1', summary: 'a1 req' })
	await request(T0 + 4, 'pending', { agent: 'a2', summary: 'a2 req' })
	expect(summaries((await timeline(db, 'alice', { agent: 'a1' })).items)).toEqual(['a1 req', 'a1 act'])
})

test('paging walks everything once, ties in the same second included', async () => {
	const want: string[] = []
	// Seconds inserted out of order: ids do not follow time.
	for (const s of [2, 0, 3, 1]) {
		for (let i = 0; i < 3; i++) await action(T0 + s, { summary: `a${s}.${i}` })
		for (let i = 0; i < 2; i++) await request(T0 + s, 'rejected', { summary: `r${s}.${i}` })
	}
	const all = summaries((await timeline(db, 'alice', { limit: 200 })).items)
	expect(all).toHaveLength(20)
	want.push(...all)
	// Newest second first; requests before actions in a second; newer ids first.
	expect(all.slice(0, 5)).toEqual(['r3.1', 'r3.0', 'a3.2', 'a3.1', 'a3.0'])
	for (const size of [1, 2, 3, 7]) {
		const seen: string[] = []
		let cursor: string | undefined
		for (let guard = 0; guard < 50; guard++) {
			const p = await timeline(db, 'alice', { limit: size, cursor })
			seen.push(...summaries(p.items))
			if (!p.next_cursor) break
			cursor = p.next_cursor
		}
		expect(seen).toEqual(want)
	}
})

test('bad cursor refused; old actions out of the window', async () => {
	await expect(timeline(db, 'alice', { cursor: 'nope' })).rejects.toMatchObject({ code: 'invalid_input' })
	expect(decodeCursor('12.1.3')).toEqual({ t: 12, k: 1, id: 3 })
	await action(nowSec() - 31 * 86400, { summary: 'too old' })
	expect((await timeline(db, 'alice')).items).toEqual([])
})

test('an approval notification links to the request on the activity page', async () => {
	const notes: Array<{ click?: string }> = []
	const approvals = new Approvals(db, { notify: async (_t, _b, o) => { notes.push(o ?? {}) } }, 'https://atrium.test/settings/user/agent-activity')
	const tool: Tool = { name: 'files_delete', description: '', area: 'files', input: obj({ path: str() }) }
	const ctx = { db, agent: { uid: 'bot', displayName: 'Bot', owner: 'alice' }, grantor: 'alice' } as unknown as ToolCtx
	const r = await approvals.request(ctx, tool, { path: '/x' }, { payload: { path: '/x' }, summary: 'Delete /x' })
	expect(notes).toEqual([expect.objectContaining({ click: `https://atrium.test/settings/user/agent-activity?request=${r.request_id}` })])
})
