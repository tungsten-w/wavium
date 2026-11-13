// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Journal of agent actions (PLAN P3-7). Every change an agent makes (a tool
// call whose action is not read, run at once or after approval) is logged for
// the grantor, with a one-line summary and, when Atrium knows how, the call
// that undoes it. The owner sees the journal in Settings > Agents and can undo
// an action from there: the inverse call runs as the same agent for the same
// grantor, without asking again (the owner's click is the approval).
//
// Undo is built only from what the action returned, so it is exact: restore
// from a trash (Daily Todo, contacts), delete what was created (it goes to the
// trash bin), untick what was ticked, unshare what was shared, move back what
// was moved by path. Other actions are logged with undo = null.
import type { Db } from './db'
import { num } from './db'
import { enqueue } from './events'
import { validate } from './schema'
import type { Registry, Tool, ToolCtx } from './tools'
import { AgentError, iso, nowSec, ulid } from './util'

export const JOURNAL_DAYS = 30

export interface Undo { tool: string, input: Record<string, unknown>, label: string }
type R = Record<string, unknown>
type UndoRule = (input: R, result: R) => Undo | null

const has = (v: unknown): boolean => v !== undefined && v !== null && v !== ''

/** How to undo each tool, from its input and its result. */
export const UNDO: Record<string, UndoRule> = {
	todo_item_create: (_i, r) => has(r.item_id) ? { tool: 'todo_item_delete', input: { item_id: r.item_id }, label: 'Remove the item (kept 7 days in the Daily Todo trash)' } : null,
	todo_item_delete: (_i, r) => has(r.trash_id) ? { tool: 'todo_item_restore', input: { trash_id: r.trash_id }, label: 'Put the item back' } : null,
	todo_item_postpone: (_i, r) => has(r.trash_id) ? { tool: 'todo_item_restore', input: { trash_id: r.trash_id }, label: 'Bring the item back' } : null,
	todo_item_complete: (_i, r) => has(r.item_id) && typeof r.done === 'boolean' ? { tool: 'todo_item_complete', input: { item_id: r.item_id, done: !r.done }, label: r.done ? 'Untick it' : 'Tick it again' } : null,
	contacts_contact_create: (_i, r) => has(r.contact_id) ? { tool: 'contacts_contact_delete', input: { contact_id: r.contact_id }, label: 'Delete the contact (a copy is kept 30 days)' } : null,
	contacts_contact_delete: (_i, r) => has(r.restore_id) ? { tool: 'contacts_contact_restore', input: { restore_id: r.restore_id }, label: 'Restore the contact' } : null,
	notes_note_create: (_i, r) => has(r.id) ? { tool: 'notes_note_delete', input: { id: r.id }, label: 'Delete the note (to the trash bin)' } : null,
	calendar_event_create: (_i, r) => has(r.event_id) ? { tool: 'calendar_event_delete', input: { event_id: r.event_id }, label: 'Delete the event (to the calendar trash bin)' } : null,
	task_create: (_i, r) => has(r.task_id) ? { tool: 'task_delete', input: { task_id: r.task_id }, label: 'Delete the task (to the calendar trash bin)' } : null,
	task_complete: (_i, r) => has(r.task_id) && typeof r.done === 'boolean' ? { tool: 'task_complete', input: { task_id: r.task_id, done: !r.done }, label: r.done ? 'Untick it' : 'Tick it again' } : null,
	files_share: (_i, r) => has(r.share_id) ? { tool: 'files_unshare', input: { share_id: r.share_id }, label: 'Stop the share' } : null,
	files_move: (i, r) => typeof i.path === 'string' && has(r.file_id) ? { tool: 'files_move', input: { file_id: r.file_id, to: i.path }, label: `Move it back to ${i.path}` } : null,
	files_write: (i, r) => i.create_only === true && has(r.file_id) ? { tool: 'files_delete', input: { file_id: r.file_id }, label: 'Delete the new file (to the trash bin)' } : null,
	mail_draft_create: (_i, r) => has(r.draft_key) ? { tool: 'mail_draft_delete', input: { draft_key: r.draft_key }, label: 'Discard the draft' } : null,
}

/** Readable names for the journal ("New contact: Ada" rather than the tool name). */
const LABELS: Record<string, string> = {
	todo_item_create: 'New Daily Todo item', todo_item_complete: 'Ticked a Daily Todo item', todo_item_rename: 'Renamed a Daily Todo item',
	todo_item_move: 'Moved a Daily Todo item', todo_item_postpone: 'Postponed a Daily Todo item', todo_item_restore: 'Restored a Daily Todo item',
	contacts_contact_create: 'New contact', contacts_contact_update: 'Edited contact', contacts_contact_restore: 'Restored a contact',
	notes_note_create: 'New note', notes_note_update: 'Edited note',
	calendar_event_create: 'New event', calendar_event_update: 'Edited event', task_create: 'New task', task_update: 'Edited task', task_complete: 'Ticked a task',
	files_write: 'Wrote file', files_mkdir: 'New folder', files_move: 'Moved', files_unshare: 'Stopped a share',
	mail_message_update: 'Updated mail', mail_draft_create: 'New draft', mail_draft_update: 'Edited draft', mail_draft_delete: 'Discarded draft',
}

const SUMMARY_KEYS = ['title', 'name', 'path', 'subject', 'to', 'message_key', 'contact_id', 'event_id', 'task_id', 'item_id', 'id', 'draft_key', 'share_id']

/** A short line for tools without their own summary ("files_mkdir: /Projects"): from the input, else the result. */
export function summarize(tool: string, input: R, result: R = {}): string {
	for (const src of [input, result]) {
		for (const k of SUMMARY_KEYS) {
			const v = src[k]
			if (has(v) && (typeof v === 'string' || typeof v === 'number')) return `${LABELS[tool] ?? tool}: ${String(v).slice(0, 120)}`
		}
	}
	return LABELS[tool] ?? tool
}

let ready: WeakMap<Db, Promise<void>> = new WeakMap()

export function migrateJournal(db: Db): Promise<void> {
	let p = ready.get(db)
	if (!p) {
		const id = db.dialect === 'pg' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'
		p = (async () => {
			await db.q(`CREATE TABLE IF NOT EXISTS ${db.t('atrium_agent_actions')} (
				id ${id},
				action_id VARCHAR(32) NOT NULL,
				agent_uid VARCHAR(64) NOT NULL,
				grantor_uid VARCHAR(64) NOT NULL,
				area VARCHAR(64) NOT NULL,
				tool VARCHAR(128) NOT NULL,
				summary TEXT NOT NULL,
				request_id VARCHAR(64),
				undo TEXT,
				undone_at BIGINT,
				undo_error TEXT,
				created_at BIGINT NOT NULL)`)
			await db.q(`CREATE UNIQUE INDEX IF NOT EXISTS ${db.t('atrium_agent_actions_aid')} ON ${db.t('atrium_agent_actions')} (action_id)`)
			await db.q(`CREATE INDEX IF NOT EXISTS ${db.t('atrium_agent_actions_grantor')} ON ${db.t('atrium_agent_actions')} (grantor_uid, id)`)
		})().catch((e) => { ready.delete(db); throw e })
		ready.set(db, p)
	}
	return p
}

/** Tests: forget which databases were migrated. */
export function resetJournalCache(): void { ready = new WeakMap() }

/** Log one action. Never throws: a journal failure must not fail the action. */
export async function recordAction(ctx: ToolCtx, tool: Tool, input: R, result: unknown, opts: { summary?: string, requestId?: string } = {}): Promise<void> {
	try {
		await migrateJournal(ctx.db)
		const r = (result && typeof result === 'object' ? result : {}) as R
		const undo = UNDO[tool.name]?.(input, r) ?? null
		await ctx.db.q(`INSERT INTO ${ctx.db.t('atrium_agent_actions')} (action_id, agent_uid, grantor_uid, area, tool, summary, request_id, undo, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		[`act_${ulid()}`, ctx.agent.uid, ctx.grantor, tool.area ?? 'agent', tool.name, (opts.summary ?? summarize(tool.name, input, r)).slice(0, 500), opts.requestId ?? null, undo ? JSON.stringify(undo) : null, nowSec()])
	} catch (e) {
		console.error(`agent journal ${tool.name}: ${(e as Error).message}`)
	}
}

export interface ActionRow { id: unknown, action_id: string, agent_uid: string, grantor_uid: string, area: string, tool: string, summary: string, request_id: string | null, undo: string | null, undone_at: unknown, undo_error: string | null, created_at: unknown }

export interface ActionView {
	action_id: string
	agent: string
	area: string
	tool: string
	summary: string
	request_id: string | null
	at: string | null
	/** What Undo does, or null when this action cannot be undone here. */
	undo: string | null
	undone_at: string | null
	undo_error: string | null
}

export function actionView(r: ActionRow): ActionView {
	const u = r.undo ? JSON.parse(r.undo) as Undo : null
	const expired = num(r.created_at) < nowSec() - JOURNAL_DAYS * 86400
	return {
		action_id: r.action_id, agent: r.agent_uid, area: r.area, tool: r.tool, summary: r.summary, request_id: r.request_id,
		at: iso(num(r.created_at)), undo: u && !expired && r.undone_at === null ? u.label : null,
		undone_at: r.undone_at === null ? null : iso(num(r.undone_at)), undo_error: r.undo_error,
	}
}

export class Journal {
	/** Context for (agent, grantor), as for an approved request. */
	ctxFor: ((agentUid: string, grantor: string) => Promise<ToolCtx>) | null = null

	constructor(private db: Db, private registry: Registry) {}

	async list(grantor: string, q: { agent?: string, cursor?: string, limit?: number } = {}): Promise<{ actions: ActionView[], next_cursor: string | null }> {
		await migrateJournal(this.db)
		// Older than the undo window: gone (lazy cleanup, per owner).
		await this.db.q(`DELETE FROM ${this.db.t('atrium_agent_actions')} WHERE grantor_uid = $1 AND created_at < $2`, [grantor, nowSec() - JOURNAL_DAYS * 86400])
		const limit = Math.min(Math.max(q.limit ?? 50, 1), 200)
		const where = ['grantor_uid = $1', 'created_at >= $2']
		const args: unknown[] = [grantor, nowSec() - JOURNAL_DAYS * 86400]
		if (q.agent) { args.push(q.agent); where.push(`agent_uid = $${args.length}`) }
		if (q.cursor !== undefined) {
			if (!/^\d+$/.test(q.cursor)) throw new AgentError('invalid_input', 'Bad cursor')
			args.push(Number(q.cursor)); where.push(`id < $${args.length}`)
		}
		args.push(limit + 1)
		const rows = await this.db.q<ActionRow>(`SELECT * FROM ${this.db.t('atrium_agent_actions')} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${args.length}`, args)
		const page = rows.slice(0, limit)
		return { actions: page.map(actionView), next_cursor: rows.length > limit ? String(num(page[page.length - 1].id)) : null }
	}

	/** The owner undoes one action. Claimed first, so two clicks run it once. */
	async undo(owner: string, actionId: string): Promise<ActionView & { result: unknown }> {
		await migrateJournal(this.db)
		const T = this.db.t('atrium_agent_actions')
		const [r] = await this.db.q<ActionRow>(`SELECT * FROM ${T} WHERE action_id = $1`, [actionId])
		if (!r || r.grantor_uid !== owner) throw new AgentError('not_found', `No action ${actionId}`)
		if (r.undone_at !== null) throw new AgentError('conflict', 'Already undone')
		if (!r.undo) throw new AgentError('conflict', 'This action cannot be undone from here')
		if (num(r.created_at) < nowSec() - JOURNAL_DAYS * 86400) throw new AgentError('conflict', `Older than ${JOURNAL_DAYS} days`)
		const u = JSON.parse(r.undo) as Undo
		const tool = this.registry.get(u.tool)
		if (!tool || !this.ctxFor) throw new AgentError('unavailable', `${u.tool} is not available`)
		const claimed = await this.db.q<{ id: unknown }>(`UPDATE ${T} SET undone_at = $1, undo_error = NULL WHERE action_id = $2 AND undone_at IS NULL RETURNING id`, [nowSec(), actionId])
		if (!claimed.length) throw new AgentError('conflict', 'Already undone')
		let result: unknown
		try {
			const errors = validate(tool.input, u.input)
			if (errors.length) throw new AgentError('invalid_input', errors.join('; '))
			const ctx = await this.ctxFor(r.agent_uid, r.grantor_uid)
			if (tool.run) result = await tool.run(ctx, u.input)
			else if (tool.prepare && tool.execute) result = await tool.execute(ctx, (await tool.prepare(ctx, u.input)).payload, null)
			else throw new AgentError('unavailable', `${u.tool} has no implementation`)
		} catch (e) {
			const msg = e instanceof AgentError ? e.message : 'The undo failed'
			if (!(e instanceof AgentError)) console.error(`agent journal undo ${actionId}: ${(e as Error).message}`)
			await this.db.q(`UPDATE ${T} SET undone_at = NULL, undo_error = $1 WHERE action_id = $2`, [msg.slice(0, 500), actionId])
			throw e instanceof AgentError ? new AgentError(e.code === 'not_found' ? 'conflict' : e.code, `Could not undo: ${msg}`) : new Error('Could not undo')
		}
		await enqueue(this.db, {
			app: 'agent', area: r.area, type: 'action.undone', grantor: r.grantor_uid, agent: r.agent_uid, wakeHint: false,
			dedupeKey: `undo:${actionId}`, data: { action_id: actionId, tool: r.tool, summary: r.summary, undo_tool: u.tool, undo_input: u.input },
		})
		const [after] = await this.db.q<ActionRow>(`SELECT * FROM ${T} WHERE action_id = $1`, [actionId])
		return { ...actionView(after), result: result ?? null }
	}
}
