// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Agent activity" (PLAN P2-8): one timeline of what the owner's agents did on
// their data, newest first. Two sources:
// - actions from the journal (journal.ts): what was changed, with Undo;
// - approval requests that did not become an action (pending, rejected,
//   expired, cancelled, void, failed; and executed ones logged before the
//   journal existed), each linking to its request.
// Ordered by (time, kind, id), all descending; the cursor is that triple, so
// paging across both sources never skips or repeats an item.
import { type ApprovalRow, view as approvalView } from './approvals'
import type { Db } from './db'
import { num } from './db'
import { type ActionRow, type ActionView, actionView, JOURNAL_DAYS, migrateJournal } from './journal'
import { AgentError, nowSec } from './util'

export type TimelineItem =
	| ({ kind: 'action' } & ActionView)
	| { kind: 'request', at: string | null, agent: string, tool: string, summary: string, request_id: string, status: string, decided_by: string | null, decided_at: string | null, error: string | null }

// Inside one second, requests (1) come before actions (0) in descending order.
const KIND = { action: 0, request: 1 } as const
export interface Key { t: number, k: number, id: number }

export const encodeCursor = (k: Key): string => `${k.t}.${k.k}.${k.id}`
export function decodeCursor(s: string): Key {
	const m = /^(\d+)\.([01])\.(\d+)$/.exec(s)
	if (!m) throw new AgentError('invalid_input', 'Bad cursor')
	return { t: Number(m[1]), k: Number(m[2]), id: Number(m[3]) }
}

/** SQL for "strictly after the cursor" in descending (t, k, id) order, for a source of kind k. */
function afterCursor(c: Key | null, k: number, tCol: string, args: unknown[]): string {
	if (!c) return ''
	args.push(c.t)
	const t = `$${args.length}`
	if (k < c.k) return ` AND ${tCol} <= ${t}`
	if (k > c.k) return ` AND ${tCol} < ${t}`
	args.push(c.id)
	return ` AND (${tCol} < ${t} OR (${tCol} = ${t} AND id < $${args.length}))`
}

export async function timeline(db: Db, owner: string, q: { agent?: string, cursor?: string, limit?: number } = {}): Promise<{ items: TimelineItem[], next_cursor: string | null }> {
	await migrateJournal(db)
	const limit = Math.min(Math.max(q.limit ?? 50, 1), 200)
	const c = q.cursor ? decodeCursor(q.cursor) : null
	const A = db.t('atrium_agent_actions')
	const R = db.t('atrium_agent_approvals')

	const aArgs: unknown[] = [owner, nowSec() - JOURNAL_DAYS * 86400]
	let aSql = `SELECT * FROM ${A} WHERE grantor_uid = $1 AND created_at >= $2`
	if (q.agent) { aArgs.push(q.agent); aSql += ` AND agent_uid = $${aArgs.length}` }
	aSql += afterCursor(c, KIND.action, 'created_at', aArgs)
	aArgs.push(limit + 1)
	aSql += ` ORDER BY created_at DESC, id DESC LIMIT $${aArgs.length}`

	const rArgs: unknown[] = [owner]
	let rSql = `SELECT * FROM ${R} r WHERE grantor_uid = $1
		AND (status <> 'executed' OR NOT EXISTS (SELECT 1 FROM ${A} a WHERE a.request_id = r.request_id))`
	if (q.agent) { rArgs.push(q.agent); rSql += ` AND agent_uid = $${rArgs.length}` }
	rSql += afterCursor(c, KIND.request, 'requested_at', rArgs)
	rArgs.push(limit + 1)
	rSql += ` ORDER BY requested_at DESC, id DESC LIMIT $${rArgs.length}`

	const [actions, requests] = await Promise.all([db.q<ActionRow>(aSql, aArgs), db.q<ApprovalRow>(rSql, rArgs)])
	const keyed: Array<{ key: Key, item: TimelineItem }> = [
		...actions.map((r) => ({ key: { t: num(r.created_at), k: KIND.action, id: num(r.id) }, item: { kind: 'action' as const, ...actionView(r) } })),
		...requests.map((r) => {
			const v = approvalView(r)
			return {
				key: { t: num(r.requested_at), k: KIND.request, id: num(r.id) },
				item: { kind: 'request' as const, at: v.requested_at, agent: v.agent, tool: v.tool, summary: v.summary, request_id: v.request_id, status: v.status, decided_by: v.decided_by, decided_at: v.decided_at, error: v.error },
			}
		}),
	]
	keyed.sort((x, y) => y.key.t - x.key.t || y.key.k - x.key.k || y.key.id - x.key.id)
	const page = keyed.slice(0, limit)
	return { items: page.map((x) => x.item), next_cursor: keyed.length > limit ? encodeCursor(page[page.length - 1].key) : null }
}
