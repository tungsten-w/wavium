// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Approval queue (ADR 0009 "Approval-gated calls"): a gated call stores a
// frozen payload and returns pending_approval; the owner approves or rejects
// in Atrium; an approved request runs the frozen payload through the tool's
// normal execute path. Every status change is an approval.* event for the agent.
import { getSettings } from './access'
import type { Db } from './db'
import { num } from './db'
import { enqueue, type Notifier } from './events'
import type { ApprovalsApi, Prepared, Registry, Tool, ToolCtx } from './tools'
import { AgentError, iso, nowSec, sha256Hex, stableJson, ulid } from './util'

export const APPROVAL_TTL_SEC = 30 * 86400

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'void' | 'executed' | 'failed'

export interface ApprovalRow {
	id: number | string
	request_id: string
	agent_uid: string
	grantor_uid: string
	tool: string
	input: string
	payload: string
	payload_hash: string
	summary: string
	ref: string | null
	status: ApprovalStatus
	requested_at: number | string
	expires_at: number | string
	decided_by: string | null
	decided_at: number | string | null
	note: string | null
	result: string | null
	error: string | null
}

const parse = (s: string | null): unknown => {
	if (s === null) return null
	try { return JSON.parse(s) } catch { return s }
}

/** The public shape (approvals_list/get and the owner API). */
export function view(r: ApprovalRow) {
	return {
		request_id: r.request_id,
		agent: r.agent_uid,
		grantor: r.grantor_uid,
		tool: r.tool,
		status: r.status,
		summary: r.summary,
		input: parse(r.input),
		// Exactly what runs on approve (e.g. the send snapshot: recipients, subject, body).
		payload: parse(r.payload),
		requested_at: iso(r.requested_at),
		expires_at: iso(r.expires_at),
		decided_by: r.decided_by,
		decided_at: iso(r.decided_at),
		note: r.note,
		result: parse(r.result),
		error: r.error,
	}
}

export type CtxFactory = (agent: string, grantor: string) => Promise<ToolCtx>

export class Approvals implements ApprovalsApi {
	/** Set by the layer once tools and contexts exist. */
	registry: Registry | null = null
	ctxFor: CtxFactory | null = null

	constructor(private db: Db, private notifier: Notifier | null, private ownerUrl: string) {}

	private T() { return this.db.t('atrium_agent_approvals') }

	async request(ctx: ToolCtx, tool: Tool, input: Record<string, unknown>, prepared: Prepared) {
		const now = nowSec()
		const rid = 'apr_' + ulid()
		const payload = stableJson(prepared.payload)
		await this.db.q(`INSERT INTO ${this.T()} (request_id, agent_uid, grantor_uid, tool, input, payload, payload_hash, summary, ref, status, requested_at, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11)`,
		[rid, ctx.agent.uid, ctx.grantor, tool.name, JSON.stringify(input), payload, sha256Hex(payload), prepared.summary.slice(0, 1000), prepared.ref ?? null, now, now + APPROVAL_TTL_SEC])
		if (this.notifier) {
			if ((await getSettings(this.db, ctx.agent.uid)).notifyApprovals) {
				await this.notifier.notify(`${ctx.agent.displayName} asks: ${tool.name}`, prepared.summary, { tags: ['robot'], click: this.ownerUrl }).catch(() => {})
			}
		}
		return { status: 'pending_approval' as const, request_id: rid, expires_at: iso(now + APPROVAL_TTL_SEC) }
	}

	async get(rid: string): Promise<ApprovalRow | null> {
		const rows = await this.db.q<ApprovalRow>(`SELECT * FROM ${this.T()} WHERE request_id = $1`, [rid])
		return rows[0] ?? null
	}

	async getForAgent(agent: string, rid: string): Promise<ApprovalRow> {
		const r = await this.get(rid)
		if (!r || r.agent_uid !== agent) throw new AgentError('not_found', `No request ${rid}`)
		return r
	}

	/** Newest first; cursor = the last row's internal id. */
	async list(where: { agent?: string, grantor?: string, status?: string }, cursor: string | undefined, limit: number) {
		const conds: string[] = []
		const params: unknown[] = []
		if (where.agent) { params.push(where.agent); conds.push(`agent_uid = $${params.length}`) }
		if (where.grantor) { params.push(where.grantor); conds.push(`grantor_uid = $${params.length}`) }
		if (where.status) { params.push(where.status); conds.push(`status = $${params.length}`) }
		if (cursor) {
			const n = Number(cursor.replace(/^a_/, ''))
			if (!Number.isFinite(n)) throw new AgentError('invalid_input', 'Bad cursor')
			params.push(n); conds.push(`id < $${params.length}`)
		}
		params.push(limit + 1)
		const rows = await this.db.q<ApprovalRow>(`SELECT * FROM ${this.T()}${conds.length ? ' WHERE ' + conds.join(' AND ') : ''} ORDER BY id DESC LIMIT $${params.length}`, params)
		const page = rows.slice(0, limit)
		return { requests: page.map(view), next_cursor: rows.length > limit ? 'a_' + num(page[page.length - 1].id) : null }
	}

	private async setStatus(r: ApprovalRow, status: ApprovalStatus, fields: { decided_by?: string, note?: string | null, result?: unknown, error?: string | null } = {}, onlyFrom: ApprovalStatus[] = ['pending']): Promise<ApprovalRow | null> {
		const now = nowSec()
		const decided = fields.decided_by !== undefined
		const updated = await this.db.q<ApprovalRow>(`UPDATE ${this.T()} SET status = $1,
				decided_by = COALESCE($2, decided_by), decided_at = CASE WHEN $3 = 1 THEN $4 ELSE decided_at END,
				note = COALESCE($5, note), result = COALESCE($6, result), error = COALESCE($7, error)
			WHERE request_id = $8 AND status IN (${onlyFrom.map((_, i) => `$${9 + i}`).join(', ')}) RETURNING *`,
		[status, fields.decided_by ?? null, decided ? 1 : 0, now, fields.note ?? null, fields.result === undefined ? null : JSON.stringify(fields.result), fields.error ?? null, r.request_id, ...onlyFrom])
		const row = updated[0] ?? null
		if (row) await this.emit(row)
		return row
	}

	async emit(r: ApprovalRow): Promise<void> {
		const v = view(r)
		const tool = this.registry?.get(r.tool)
		await enqueue(this.db, {
			app: 'agent',
			area: tool?.area ?? 'agent',
			type: `approval.${r.status}`,
			grantor: r.grantor_uid,
			agent: r.agent_uid,
			wakeHint: true,
			dedupeKey: `approval:${r.request_id}:${r.status}`,
			data: { request_id: v.request_id, tool: v.tool, input: v.input, requested_at: v.requested_at, decided_by: v.decided_by, decided_at: v.decided_at, note: v.note, result: v.result, error: v.error },
		})
	}

	async cancel(agent: string, rid: string) {
		const r = await this.getForAgent(agent, rid)
		if (r.status !== 'pending') throw new AgentError('conflict', `Request is ${r.status}, not pending`)
		// Cancelled by the agent itself: no event (it knows).
		await this.db.q(`UPDATE ${this.T()} SET status = 'cancelled', decided_by = $1, decided_at = $2 WHERE request_id = $3 AND status = 'pending'`, [agent, nowSec(), rid])
		return view((await this.get(rid))!)
	}

	async voidRef(agent: string, ref: string, why: string): Promise<void> {
		const rows = await this.db.q<ApprovalRow>(`SELECT * FROM ${this.T()} WHERE agent_uid = $1 AND ref = $2 AND status = 'pending'`, [agent, ref])
		for (const r of rows) await this.setStatus(r, 'void', { error: why })
	}

	async reject(owner: string, rid: string, note: string | null) {
		const r = await this.ownedPending(owner, rid)
		return view((await this.setStatus(r, 'rejected', { decided_by: owner, note }))!)
	}

	async approve(owner: string, rid: string, note: string | null) {
		const r = await this.ownedPending(owner, rid)
		const approved = await this.setStatus(r, 'approved', { decided_by: owner, note })
		if (!approved) throw new AgentError('conflict', 'Request changed meanwhile')
		const tool = this.registry?.get(r.tool)
		if (!tool?.execute || !this.ctxFor) {
			return view((await this.setStatus(approved, 'failed', { error: 'The tool is no longer available' }, ['approved']))!)
		}
		let done: ApprovalRow | null
		try {
			const ctx = await this.ctxFor(r.agent_uid, r.grantor_uid)
			const payload = JSON.parse(r.payload)
			if (sha256Hex(r.payload) !== r.payload_hash || (tool.stillValid && !(await tool.stillValid(ctx, payload)))) {
				done = await this.setStatus(approved, 'void', { error: 'What was approved changed after the request' }, ['approved'])
			} else {
				const result = await tool.execute(ctx, payload, { request_id: rid })
				done = await this.setStatus(approved, 'executed', { result: result ?? null }, ['approved'])
			}
		} catch (e) {
			done = await this.setStatus(approved, 'failed', { error: (e as Error).message }, ['approved'])
		}
		return view(done ?? approved)
	}

	private async ownedPending(owner: string, rid: string): Promise<ApprovalRow> {
		const r = await this.get(rid)
		if (!r || r.grantor_uid !== owner) throw new AgentError('not_found', `No request ${rid}`)
		if (r.status !== 'pending') throw new AgentError('conflict', `Request is ${r.status}, not pending`)
		if (num(r.expires_at) < nowSec()) {
			await this.setStatus(r, 'expired')
			throw new AgentError('conflict', 'Request expired')
		}
		return r
	}

	async expireOld(at = nowSec()): Promise<void> {
		const rows = await this.db.q<ApprovalRow>(`SELECT * FROM ${this.T()} WHERE status = 'pending' AND expires_at < $1`, [at])
		for (const r of rows) await this.setStatus(r, 'expired')
	}
}
