// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Daily Todo tools (PLAN P3-1, ADR 0009 order: the app after Mail). Area
// `daily_todo` (read, write, delete). Every call goes through PHP's
// BoardService as the grantor (apps/daily_todo/lib/Controller/
// AtriumAgentController.php), so the app's own rules apply: only today (and
// the two days before) can be edited, events are read-only mirrors, deleted
// and postponed items wait in the app's trash for an undo.
//
// Events: the app itself queues `todo.*` events for every change, whoever
// made it (web UI or agent): todo.item.created / completed / uncompleted /
// renamed / deleted / postponed / restored, todo.day.reordered,
// todo.day.finished. Agents read them with events_since.
import type { AgentModule, LayerCore } from '../index'
import { boolean, int, obj, str } from '../schema'
import type { Tool, ToolCtx } from '../tools'
import { AgentError } from '../util'

export const AREA = 'daily_todo'

/** The PHP side. `agent` is written into the todo.* events the call causes. */
export interface TodoBridge {
	call<T = Record<string, unknown>>(op: string, uid: string, agent: string, args?: Record<string, unknown>): Promise<T>
}

export function phpTodoBridge(core: Pick<LayerCore, 'php'>): TodoBridge {
	return {
		call: (op, uid, agent, args = {}) => core.php.app('POST', 'apps/daily_todo/api/atrium-agent', { body: { op, uid, agent, args } }),
	}
}

/** One row of a day as PHP returns it (daily_todo_items). */
export interface RawItem {
	id: number
	title: string
	source_type: string
	parent_id: number | null
	position: number | string
	completed: boolean
	all_day?: boolean
	starts_at?: number | string | null
	due_at?: number | string | null
	error?: string | null
}

export interface RawDay {
	day: string
	logicalToday: string
	editable: boolean
	future: boolean
	items: RawItem[]
}

/** Divider ("---") and blank ("<br>") rows: layout only, never shown to agents. */
export const isLayout = (title: string) => /^\s*-{3,}\s*$/.test(title) || /^\s*<br\s*\/?>\s*$/i.test(title)

const n = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))
const iso = (sec: number | null) => (sec === null ? null : new Date(sec * 1000).toISOString())

const KINDS: Record<string, string> = { quick: 'item', routine: 'routine', task: 'task', event: 'event' }

/** What agents see of an item. */
export function itemView(i: RawItem) {
	const kind = KINDS[i.source_type] ?? i.source_type
	return {
		item_id: Number(i.id),
		title: i.title,
		kind,
		done: Boolean(i.completed),
		parent_id: i.parent_id === null ? null : Number(i.parent_id),
		...(kind === 'event' || kind === 'task' ? { starts_at: iso(n(i.starts_at)), due_at: iso(n(i.due_at)), all_day: Boolean(i.all_day) } : {}),
		...(i.error ? { error: i.error } : {}),
		can_rename: kind !== 'event',
		can_delete: kind === 'item' || kind === 'task',
	}
}

export function dayView(d: RawDay) {
	const items = [...d.items].sort((a, b) => Number(a.position) - Number(b.position)).filter((i) => !isLayout(i.title)).map(itemView)
	const open = items.filter((i) => !i.done && i.kind !== 'event').length
	return {
		date: d.day,
		today: d.logicalToday,
		editable: d.editable,
		items,
		open_count: open,
		done_count: items.filter((i) => i.done).length,
	}
}

/** Ids of an item and everything below it, in day order. */
function block(sorted: RawItem[], id: number): number[] {
	const out = [id]
	for (let grew = true; grew;) {
		grew = false
		for (const i of sorted) {
			if (i.parent_id !== null && out.includes(Number(i.parent_id)) && !out.includes(Number(i.id))) {
				out.push(Number(i.id))
				grew = true
			}
		}
	}
	return sorted.map((i) => Number(i.id)).filter((x) => out.includes(x))
}

/**
 * New order of a day's ids after moving `id` (with its subitems) right after
 * its sibling `after` (its whole block), or first among its siblings (null).
 */
export function moveOrder(items: RawItem[], id: number, after: number | null): number[] {
	const sorted = [...items].sort((a, b) => Number(a.position) - Number(b.position))
	const item = sorted.find((i) => Number(i.id) === id)
	if (!item) throw new AgentError('not_found', `No item ${id} on that day`)
	const parent = item.parent_id === null ? null : Number(item.parent_id)
	const moving = block(sorted, id)
	const rest = sorted.map((i) => Number(i.id)).filter((x) => !moving.includes(x))
	let at: number
	if (after === null) {
		at = parent === null ? 0 : rest.indexOf(parent) + 1
	} else {
		if (after === id) throw new AgentError('invalid_input', 'after_id is the item itself')
		const target = sorted.find((i) => Number(i.id) === after)
		if (!target) throw new AgentError('not_found', `No item ${after} on that day`)
		const tp = target.parent_id === null ? null : Number(target.parent_id)
		if (tp !== parent) throw new AgentError('invalid_input', 'after_id must be an item at the same level (same parent_id)')
		const tb = block(sorted.filter((i) => !moving.includes(Number(i.id))), after)
		at = rest.indexOf(tb[tb.length - 1]) + 1
	}
	return [...rest.slice(0, at), ...moving, ...rest.slice(at)]
}

const DATE = str('YYYY-MM-DD, or "today" (default). Today follows the board\'s day change hour, not midnight.')
const ITEM_ID = int('item_id from todo_day_get', { minimum: 1 })

export function todoTools(bridge: TodoBridge): Tool[] {
	const call = <T = Record<string, unknown>>(ctx: ToolCtx, op: string, args: Record<string, unknown> = {}) => bridge.call<T>(op, ctx.grantor, ctx.agent.uid, args)
	const day = async (ctx: ToolCtx, date?: unknown) => call<RawDay>(ctx, 'day', { date: date ?? 'today' })
	/** The day an item is on (today first, then the two editable days before). */
	const findItem = async (ctx: ToolCtx, id: number, date?: unknown) => {
		const first = await day(ctx, date)
		const hit = first.items.find((i) => Number(i.id) === id)
		if (hit || date) return { d: first, item: hit }
		for (const back of [1, 2]) {
			const t = new Date(`${first.logicalToday}T12:00:00Z`)
			t.setUTCDate(t.getUTCDate() - back)
			const d = await day(ctx, t.toISOString().slice(0, 10))
			const item = d.items.find((i) => Number(i.id) === id)
			if (item) return { d, item }
		}
		return { d: first, item: undefined }
	}

	return [
		{
			name: 'todo_day_get',
			description: 'A Daily Todo day: its items in order (kind item = added by hand, routine = from the daily template, task = from Tasks, event = calendar event, read-only), done or not, nesting (parent_id). Days in the future or never opened are empty; today and the two days before are editable.',
			area: AREA,
			input: obj({ date: DATE }),
			run: async (ctx, input) => dayView(await day(ctx, input.date)),
		},
		{
			name: 'todo_overdue',
			description: 'Tasks (from the Tasks app) whose date has passed and that are not done nor on today\'s list.',
			area: AREA,
			input: obj({}),
			run: async (ctx) => call(ctx, 'overdue'),
		},
		{
			name: 'todo_trash_list',
			description: 'Items waiting in the Daily Todo trash: postponed ones (with the day they come back) and ones deleted in the last 7 days. Use todo_item_restore to bring one back.',
			area: AREA,
			input: obj({}),
			run: async (ctx) => call(ctx, 'trash'),
		},
		{
			name: 'todo_item_create',
			description: 'Add an item to a day (default today), in the day items slot of the template. parent_id makes it a subitem; after_id puts it right after that item.',
			area: AREA,
			action: 'write',
			input: obj({
				title: str('The text of the item', { minLength: 1, maxLength: 255 }),
				date: DATE,
				parent_id: ITEM_ID,
				after_id: ITEM_ID,
			}, ['title']),
			run: async (ctx, input) => {
				const r = await call<{ id: number }>(ctx, 'create', { title: input.title, date: input.date ?? 'today', parent_id: input.parent_id, after_id: input.after_id })
				return { item_id: Number(r.id), created: true }
			},
		},
		{
			name: 'todo_item_complete',
			description: 'Tick (done: true, default) or untick an item. A task item also changes in the Tasks app. Calendar events cannot be ticked.',
			area: AREA,
			action: 'write',
			input: obj({ item_id: ITEM_ID, done: boolean('Default true') }, ['item_id']),
			run: async (ctx, input) => {
				const done = input.done !== false
				await call(ctx, 'complete', { item_id: input.item_id, done })
				return { item_id: input.item_id, done }
			},
		},
		{
			name: 'todo_item_rename',
			description: 'Change the text of an item. Routine items change for that day only; task items are renamed in Tasks. Events cannot be renamed.',
			area: AREA,
			action: 'write',
			input: obj({ item_id: ITEM_ID, title: str(undefined, { minLength: 1, maxLength: 255 }) }, ['item_id', 'title']),
			run: async (ctx, input) => {
				await call(ctx, 'rename', { item_id: input.item_id, title: input.title })
				return { item_id: input.item_id, title: String(input.title).trim() }
			},
		},
		{
			name: 'todo_item_move',
			description: 'Move an item (with its subitems) within its day: right after its sibling after_id, or first among its siblings when after_id is null or left out. The nesting does not change.',
			area: AREA,
			action: 'write',
			input: obj({ item_id: ITEM_ID, after_id: { type: ['integer', 'null'], description: 'A sibling (same parent_id); null = first' }, date: DATE }, ['item_id']),
			run: async (ctx, input) => {
				const id = Number(input.item_id)
				const { d, item } = await findItem(ctx, id, input.date)
				if (!item) throw new AgentError('not_found', `No item ${id} on ${input.date ? d.day : 'today or the two days before'}`)
				if (!d.editable) throw new AgentError('conflict', `${d.day} can no longer be edited`)
				const order = moveOrder(d.items, id, input.after_id === undefined || input.after_id === null ? null : Number(input.after_id))
				await call(ctx, 'reorder', { date: d.day, item_ids: order })
				return { item_id: id, date: d.day, moved: true }
			},
		},
		{
			name: 'todo_item_postpone',
			description: 'Postpone an item of today by 1-365 days (default 1). An item added by hand leaves today and comes back on that day; a task has its dates moved in Tasks. Undo with todo_item_restore and the returned trash_id.',
			area: AREA,
			action: 'write',
			input: obj({ item_id: ITEM_ID, days: int('Default 1', { minimum: 1, maximum: 365 }) }, ['item_id']),
			run: async (ctx, input) => {
				const r = await call<{ trash: number, due: string }>(ctx, 'postpone', { item_id: input.item_id, days: input.days ?? 1 })
				return { item_id: input.item_id, trash_id: Number(r.trash), comes_back_on: r.due }
			},
		},
		{
			name: 'todo_item_delete',
			description: 'Delete an item added by hand, or a task (moved to the trash of Tasks). Kept 7 days in the Daily Todo trash: todo_item_restore undoes it. Usually needs the owner\'s approval: you get {status: "pending_approval", request_id}.',
			area: AREA,
			action: 'delete',
			input: obj({ item_id: ITEM_ID }, ['item_id']),
			prepare: async (ctx, input) => {
				const id = Number(input.item_id)
				const { d, item } = await findItem(ctx, id)
				if (!item) throw new AgentError('not_found', `No item ${id} on today or the two days before`)
				if (item.source_type !== 'quick' && item.source_type !== 'task') throw new AgentError('invalid_input', 'Only items added by hand and tasks can be deleted')
				return { payload: { item_id: id, title: item.title }, summary: `Delete from Daily Todo (${d.day}): "${item.title}"`, ref: `todo:${id}` }
			},
			execute: async (ctx, payload) => {
				const p = payload as { item_id: number }
				const r = await call<{ trash_id: number }>(ctx, 'delete', { item_id: p.item_id })
				return { item_id: p.item_id, deleted: true, trash_id: Number(r.trash_id) }
			},
		},
		{
			name: 'todo_item_restore',
			description: 'Undo a delete or a postpone (trash_id from those tools or todo_trash_list). The items go back where they were, or to today with today: true or when their day can no longer be edited.',
			area: AREA,
			action: 'write',
			input: obj({ trash_id: int(undefined, { minimum: 1 }), today: boolean('Bring them to today') }, ['trash_id']),
			run: async (ctx, input) => {
				await call(ctx, 'restore', { trash_id: input.trash_id, today: input.today === true })
				return { trash_id: input.trash_id, restored: true }
			},
		},
	]
}

export function todoModule(): AgentModule {
	return {
		tools: (core) => todoTools(phpTodoBridge(core)),
	}
}

