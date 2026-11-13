// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Daily Todo agent tools (P3-1): views, the move order, and the tools through
// the real call path (grants, approval) with a fake PHP bridge. The PHP side
// (BoardService + todo.* events) is tested by apps/daily_todo/tests/run-agent.php.
import { beforeEach, expect, test } from 'bun:test'
import { normalizeModes, setAccess } from '../access'
import { Approvals } from '../approvals'
import { type Db, migrate, wrap } from '../db'
import { callTool, Registry, type ToolCtx } from '../tools'
import { AgentError } from '../util'
import { dayView, isLayout, moveOrder, type RawDay, type RawItem, type TodoBridge, todoTools } from './index'

const it = (id: number, title: string, position: number, parent_id: number | null = null, source_type = 'quick', completed = false): RawItem =>
	({ id, title, position, parent_id, source_type, completed })

test('layout rows are recognised', () => {
	expect(['---', ' ----- ', '<br>', '<br/>', '<BR />'].every(isLayout)).toBe(true)
	expect(['--', 'a---', 'br', 'Lunch'].some(isLayout)).toBe(false)
})

test('dayView: order by position, layout rows hidden, kinds and counts', () => {
	const v = dayView({
		day: '2026-11-13', logicalToday: '2026-11-13', editable: true, future: false,
		items: [
			it(3, 'Call Bob', 2),
			it(1, 'Wake up', 0, null, 'routine', true),
			it(2, '---', 1, null, 'routine'),
			{ ...it(4, 'Dentist', 3, null, 'event'), starts_at: 1763030000, all_day: false },
			it(5, 'Report', 4, null, 'task'),
		],
	})
	expect(v.items.map((i) => [i.item_id, i.kind, i.done])).toEqual([[1, 'routine', true], [3, 'item', false], [4, 'event', false], [5, 'task', false]])
	expect(v.items[2]).toMatchObject({ can_rename: false, can_delete: false, all_day: false })
	expect(typeof v.items[2].starts_at).toBe('string')
	expect(v.items[1]).toMatchObject({ can_rename: true, can_delete: true })
	expect(v.items[1]).not.toHaveProperty('starts_at')
	expect(v).toMatchObject({ date: '2026-11-13', open_count: 2, done_count: 1 })
})

// a(1) [a1(2) [a1x(3)], a2(4)], b(5), c(6) [c1(7)]
const tree = [it(1, 'a', 0), it(2, 'a1', 1, 1), it(3, 'a1x', 2, 2), it(4, 'a2', 3, 1), it(5, 'b', 4), it(6, 'c', 5), it(7, 'c1', 6, 6)]

test('moveOrder: a root moves with its whole subtree, after a sibling\'s whole block', () => {
	expect(moveOrder(tree, 1, 5)).toEqual([5, 1, 2, 3, 4, 6, 7])
	expect(moveOrder(tree, 1, 6)).toEqual([5, 6, 7, 1, 2, 3, 4])
	expect(moveOrder(tree, 6, null)).toEqual([6, 7, 1, 2, 3, 4, 5])
	expect(moveOrder(tree, 5, 6)).toEqual([1, 2, 3, 4, 6, 7, 5])
})

test('moveOrder: a subitem stays under its parent', () => {
	expect(moveOrder(tree, 2, 4)).toEqual([1, 4, 2, 3, 5, 6, 7])
	expect(moveOrder(tree, 4, null)).toEqual([1, 4, 2, 3, 5, 6, 7])
	// positions as strings (Postgres) and an unsorted input give the same result
	const shuffled = [...tree].reverse().map((i) => ({ ...i, position: String(i.position) }))
	expect(moveOrder(shuffled, 2, 4)).toEqual([1, 4, 2, 3, 5, 6, 7])
})

test('moveOrder: refuses another level, itself, and unknown ids', () => {
	const code = (f: () => unknown) => { try { f() } catch (e) { return (e as AgentError).code } return 'none' }
	expect(code(() => moveOrder(tree, 2, 5))).toBe('invalid_input')
	expect(code(() => moveOrder(tree, 1, 1))).toBe('invalid_input')
	expect(code(() => moveOrder(tree, 99, null))).toBe('not_found')
	expect(code(() => moveOrder(tree, 1, 99))).toBe('not_found')
})

// ------------------------------------------------------------- through callTool

let db: Db

beforeEach(async () => {
	db = wrap(new Bun.SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
})

/** A tiny Daily Todo: today 2026-11-13 and yesterday, in memory. */
function fakeTodo() {
	const calls: Array<{ op: string, uid: string, agent: string, args: Record<string, unknown> }> = []
	const days: Record<string, RawItem[]> = {
		'2026-11-13': [it(10, 'Wake up', 0, null, 'routine'), it(11, 'Buy bread', 1), it(12, 'Call Bob', 2)],
		'2026-11-12': [it(20, 'Old thing', 0)],
	}
	const bridge: TodoBridge = {
		async call<T>(op: string, uid: string, agent: string, args: Record<string, unknown> = {}) {
			calls.push({ op, uid, agent, args })
			const date = args.date === 'today' || args.date === undefined ? '2026-11-13' : String(args.date)
			let out: unknown
			switch (op) {
			case 'day': out = { day: date, logicalToday: '2026-11-13', editable: date >= '2026-11-11', future: date > '2026-11-13', items: days[date] ?? [] } satisfies RawDay; break
			case 'create': out = { id: 99 }; break
			case 'delete': out = { trash_id: 7 }; break
			case 'postpone': out = { trash: 8, due: '2026-11-16' }; break
			default: out = { ok: true }
			}
			return out as T
		},
	}
	return { bridge, calls }
}

function setup() {
	const todo = fakeTodo()
	const approvals = new Approvals(db, null, 'https://x/settings/agents')
	const registry = new Registry()
	registry.add(...todoTools(todo.bridge))
	const base = { db, php: null as never, agent: { uid: 'bot', displayName: 'Bot', owner: 'alice' }, baseUrl: 'https://x', approvals }
	approvals.registry = registry
	approvals.ctxFor = async (_agent, grantor) => ({ ...base, grantor, access: {} } as ToolCtx)
	return { ...todo, approvals, registry, base }
}

const grant = (modes: Record<string, string>) => setAccess(db, 'bot', 'alice', 'daily_todo', normalizeModes(modes as never, ['read', 'write', 'delete']))

test('tools need the daily_todo grant: none → forbidden, read only → no writes', async () => {
	const { registry, base, calls } = setup()
	await expect(callTool(registry, base, 'todo_day_get', {})).rejects.toMatchObject({ code: 'forbidden' })
	await grant({ read: 'allowed' })
	const day = await callTool(registry, base, 'todo_day_get', {}) as ReturnType<typeof dayView>
	expect(day.items.map((i) => i.title)).toEqual(['Wake up', 'Buy bread', 'Call Bob'])
	await expect(callTool(registry, base, 'todo_item_create', { title: 'x' })).rejects.toMatchObject({ code: 'forbidden' })
	await expect(callTool(registry, base, 'todo_day_get', { grantor: 'bob' })).rejects.toMatchObject({ code: 'forbidden' })
	// every PHP call acts as the grantor and names the agent (for the todo.* events)
	expect(calls.every((c) => c.uid === 'alice' && c.agent === 'bot')).toBe(true)
})

test('writes: create, complete, rename, postpone, restore go to PHP with the right arguments', async () => {
	const { registry, base, calls } = setup()
	await grant({ read: 'allowed', write: 'allowed' })
	expect(await callTool(registry, base, 'todo_item_create', { title: 'Water plants', parent_id: 11 })).toEqual({ item_id: 99, created: true })
	expect(await callTool(registry, base, 'todo_item_complete', { item_id: 11 })).toEqual({ item_id: 11, done: true })
	expect(await callTool(registry, base, 'todo_item_complete', { item_id: 11, done: false })).toEqual({ item_id: 11, done: false })
	await callTool(registry, base, 'todo_item_rename', { item_id: 12, title: '  Call Bob back ' })
	expect(await callTool(registry, base, 'todo_item_postpone', { item_id: 12, days: 3 })).toEqual({ item_id: 12, trash_id: 8, comes_back_on: '2026-11-16' })
	await callTool(registry, base, 'todo_item_restore', { trash_id: 8 })
	expect(calls.map((c) => [c.op, c.args])).toEqual([
		['create', { title: 'Water plants', date: 'today', parent_id: 11, after_id: undefined }],
		['complete', { item_id: 11, done: true }],
		['complete', { item_id: 11, done: false }],
		['rename', { item_id: 12, title: '  Call Bob back ' }],
		['postpone', { item_id: 12, days: 3 }],
		['restore', { trash_id: 8, today: false }],
	])
	await expect(callTool(registry, base, 'todo_item_create', {})).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(callTool(registry, base, 'todo_item_postpone', { item_id: 12, days: 400 })).rejects.toMatchObject({ code: 'invalid_input' })
})

test('move: computes the full order of the day and finds items of the days before', async () => {
	const { registry, base, calls } = setup()
	await grant({ read: 'allowed', write: 'allowed' })
	expect(await callTool(registry, base, 'todo_item_move', { item_id: 12, after_id: 10 })).toEqual({ item_id: 12, date: '2026-11-13', moved: true })
	expect(calls.at(-1)).toMatchObject({ op: 'reorder', args: { date: '2026-11-13', item_ids: [10, 12, 11] } })
	await callTool(registry, base, 'todo_item_move', { item_id: 20, after_id: null })
	expect(calls.at(-1)).toMatchObject({ op: 'reorder', args: { date: '2026-11-12', item_ids: [20] } })
	await expect(callTool(registry, base, 'todo_item_move', { item_id: 404 })).rejects.toMatchObject({ code: 'not_found' })
})

test('delete needs approval by default; approving runs it; only hand-made items and tasks', async () => {
	const { registry, base, calls, approvals } = setup()
	await grant({ read: 'allowed', write: 'allowed' })
	const pending = await callTool(registry, base, 'todo_item_delete', { item_id: 11 }) as { status: string, request_id: string }
	expect(pending.status).toBe('pending_approval')
	expect(calls.some((c) => c.op === 'delete')).toBe(false)
	const req = await approvals.get(pending.request_id)
	expect(req!.summary).toBe('Delete from Daily Todo (2026-11-13): "Buy bread"')
	const done = await approvals.approve('alice', pending.request_id, null)
	expect(done.status).toBe('executed')
	expect(done.result).toEqual({ item_id: 11, deleted: true, trash_id: 7 })
	expect(calls.at(-1)).toMatchObject({ op: 'delete', uid: 'alice', args: { item_id: 11 } })

	await expect(callTool(registry, base, 'todo_item_delete', { item_id: 10 })).rejects.toMatchObject({ code: 'invalid_input' })

	await grant({ read: 'allowed', write: 'allowed', delete: 'allowed' })
	expect(await callTool(registry, base, 'todo_item_delete', { item_id: 12 })).toEqual({ item_id: 12, deleted: true, trash_id: 7 })
})
