// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Calendar and Tasks tools (PLAN P3-2). Areas `calendar` (events) and `tasks`
// (VTODO), each read / write / delete; delete needs approval by default and
// moves the object to the calendar trash bin (30 days), never a hard delete.
//
// The work is done by PHP (apps/calendar/lib/Service/AtriumAgentCalendar.php)
// through Nextcloud's CalDAV backend, so phones and DAV clients see every
// change. Agents get simple fields, never raw iCalendar.
//
// Discoverable calendars: calendar_list shows the grantor's own calendars,
// the ones other users share with them (shared_by, writable) and their
// subscriptions, so an agent finds a delegated calendar without knowing
// its URL. Ids: event_id / task_id = "<calendar id>/<object>".
//
// Events (feed.ts): calendar.event.created / updated / deleted / starting,
// task.created / updated / completed / deleted / due.
import type { AgentModule, LayerCore } from '../index'
import { arr, boolean, int, obj, type Schema, str } from '../schema'
import type { Tool, ToolCtx } from '../tools'
import { AgentError } from '../util'
import { CalendarFeed, type Upcoming } from './feed'

export interface CalendarBridge {
	call<T = Record<string, unknown>>(op: string, uid: string, args?: Record<string, unknown>): Promise<T>
}

export function phpCalendarBridge(core: Pick<LayerCore, 'php'>): CalendarBridge {
	return { call: (op, uid, args = {}) => core.php.app('POST', 'apps/calendar/api/atrium-agent', { body: { op, uid, args } }) }
}

export const DEFAULT_DAYS = 7
export const MAX_DAYS = 366

/** Only the editable fields the caller sent (absent = unchanged, null = cleared). */
export function pick(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const k of keys) if (k in input) out[k] = input[k]
	return out
}

/** from / to defaults: now and now + DEFAULT_DAYS; to after from; at most MAX_DAYS. */
export function range(input: { from?: unknown, to?: unknown }, now = new Date()): { from: string, to: string } {
	const parse = (v: unknown, name: string) => {
		const t = Date.parse(String(v))
		if (Number.isNaN(t)) throw new AgentError('invalid_input', `${name} is not an ISO date`)
		return t
	}
	const from = input.from === undefined ? now.getTime() : parse(input.from, 'from')
	const to = input.to === undefined ? from + DEFAULT_DAYS * 86400_000 : parse(input.to, 'to')
	if (to <= from) throw new AgentError('invalid_input', 'to must be after from')
	if (to - from > MAX_DAYS * 86400_000) throw new AgentError('invalid_input', `The range is limited to ${MAX_DAYS} days`)
	return { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
}

const WHEN = 'ISO 8601 with an offset (2026-11-14T09:00:00+01:00 or ...Z); for all-day events a date YYYY-MM-DD'
const eventFields = (required: string[] = []): Schema => obj({
	title: str(undefined, { minLength: 1, maxLength: 500 }),
	start: str(WHEN),
	end: str(`${WHEN}. Default: start + 1 hour (all-day: the next day). For all-day events, end is the day after the last day.`),
	all_day: boolean(),
	location: { type: ['string', 'null'] },
	description: { type: ['string', 'null'] },
	rrule: { type: ['string', 'null'], description: 'Repeat rule, e.g. FREQ=WEEKLY;BYDAY=MO;COUNT=10 (null removes it). Changes apply to the whole series.' },
}, required)

const taskFields: Record<string, Schema> = {
	title: str(undefined, { minLength: 1, maxLength: 500 }),
	due: { type: ['string', 'null'], description: `Due date: ${WHEN}` },
	start: { type: ['string', 'null'], description: 'Start date, same format' },
	priority: { type: ['integer', 'null'], minimum: 0, maximum: 9, description: '1 = highest ... 9 = lowest, 0 or null = none' },
	description: { type: ['string', 'null'] },
	categories: arr(str(), 'Tags'),
}

export function calendarTools(bridge: CalendarBridge): Tool[] {
	const call = <T = Record<string, unknown>>(ctx: ToolCtx, op: string, args: Record<string, unknown> = {}) => bridge.call<T>(op, ctx.grantor, args)
	const etagOf = async (ctx: ToolCtx, id: string) => (await call<{ etag: string | null }>(ctx, 'etag', { id })).etag
	return [
		{
			name: 'calendar_list',
			description: 'Calendars the user can see: their own, the ones shared with them (shared_by = who shares it; writable false = read-only share) and subscriptions (read-only). events / tasks say what each one holds.',
			area: 'calendar',
			input: obj({}),
			run: (ctx) => call(ctx, 'calendars'),
		},
		{
			name: 'calendar_event_list',
			description: `Events between from and to (default: the next ${DEFAULT_DAYS} days), repeating events expanded into occurrences, sorted by start, across all calendars or one. Times are UTC; all-day events have dates.`,
			area: 'calendar',
			input: obj({
				from: str('ISO date-time, default now'),
				to: str(`ISO date-time, default from + ${DEFAULT_DAYS} days, at most ${MAX_DAYS} days after from`),
				calendar_id: str(),
				query: str('Text in the title, location or description'),
				limit: int('Default 100, max 500', { minimum: 1, maximum: 500 }),
			}),
			run: (ctx, input) => call(ctx, 'events', { ...range(input), calendar_id: input.calendar_id, query: input.query, limit: input.limit ?? 100 }),
		},
		{
			name: 'calendar_event_get',
			description: 'One event (the whole series for a repeating one, with its modified occurrences), with attendees and the etag to pass to calendar_event_update.',
			area: 'calendar',
			input: obj({ event_id: str() }, ['event_id']),
			run: (ctx, input) => call(ctx, 'event', { event_id: input.event_id }),
		},
		{
			name: 'calendar_event_create',
			description: 'Create an event. Default calendar: the user\'s first own calendar that takes events; a calendar shared with them read-write works too.',
			area: 'calendar',
			action: 'write',
			input: (() => { const s = eventFields(['title', 'start']); s.properties!.calendar_id = str('From calendar_list'); return s })(),
			run: (ctx, input) => call(ctx, 'event_create', { calendar_id: input.calendar_id, fields: pick(input, ['title', 'start', 'end', 'all_day', 'location', 'description', 'rrule']) }),
		},
		{
			name: 'calendar_event_update',
			description: 'Change an event (the whole series if it repeats). Only the fields you send change; null clears location, description or rrule. Moving start keeps the duration unless end is sent. Pass etag from calendar_event_get to refuse the change if someone edited it meanwhile.',
			area: 'calendar',
			action: 'write',
			input: (() => { const s = eventFields(['event_id']); s.properties!.event_id = str(); s.properties!.etag = str(); return s })(),
			run: (ctx, input) => call(ctx, 'event_update', { event_id: input.event_id, etag: input.etag, fields: pick(input, ['title', 'start', 'end', 'all_day', 'location', 'description', 'rrule']) }),
		},
		{
			name: 'calendar_event_delete',
			description: 'Delete an event (the whole series if it repeats): it goes to the calendar trash bin, restorable for 30 days. Usually needs the owner\'s approval: you get {status: "pending_approval", request_id}. The request is void if the event changes meanwhile.',
			area: 'calendar',
			action: 'delete',
			input: obj({ event_id: str() }, ['event_id']),
			prepare: async (ctx, input) => {
				const e = await call<{ title: string, start: string | null, etag: string | null, recurring: boolean }>(ctx, 'event', { event_id: input.event_id })
				const when = e.start ? ` on ${e.start.slice(0, 16).replace('T', ' ')}` : ''
				return { payload: { event_id: input.event_id, etag: e.etag }, summary: `Delete the event "${e.title}"${when}${e.recurring ? ' (all occurrences)' : ''}`, ref: `cal:${input.event_id}` }
			},
			stillValid: async (ctx, payload) => {
				const p = payload as { event_id: string, etag: string | null }
				try { return (await etagOf(ctx, p.event_id)) === p.etag } catch { return false }
			},
			execute: async (ctx, payload) => {
				const p = payload as { event_id: string, etag: string | null }
				const r = await call<{ title: string }>(ctx, 'event_delete', { event_id: p.event_id, etag: p.etag })
				return { event_id: p.event_id, deleted: true, in_trash: true, title: r.title }
			},
		},
		{
			name: 'task_list',
			description: 'Tasks (Tasks app, VTODO) across the user\'s task lists or one: open by default, sorted by due date (undated last). due_before keeps tasks due before that time.',
			area: 'tasks',
			input: obj({
				calendar_id: str('A task list from calendar_list (tasks: true)'),
				status: str('open (default), completed or all', { enum: ['open', 'completed', 'all'] }),
				due_before: str('ISO date-time'),
				query: str('Text in the title or description'),
				limit: int('Default 100, max 500', { minimum: 1, maximum: 500 }),
			}),
			run: (ctx, input) => call(ctx, 'tasks', { calendar_id: input.calendar_id, status: input.status ?? 'open', due_before: input.due_before, query: input.query, limit: input.limit ?? 100 }),
		},
		{
			name: 'task_get',
			description: 'One task with its etag. parent_uid is the uid of its parent task, if it is a subtask.',
			area: 'tasks',
			input: obj({ task_id: str() }, ['task_id']),
			run: (ctx, input) => call(ctx, 'task', { task_id: input.task_id }),
		},
		{
			name: 'task_create',
			description: 'Create a task. Default list: the user\'s first own calendar that takes tasks. parent_id (a task_id) makes it a subtask, in the parent\'s list.',
			area: 'tasks',
			action: 'write',
			input: obj({ ...taskFields, calendar_id: str(), parent_id: str('task_id of the parent task') }, ['title']),
			run: (ctx, input) => call(ctx, 'task_create', { calendar_id: input.calendar_id, parent_id: input.parent_id, fields: pick(input, ['title', 'due', 'start', 'priority', 'description', 'categories']) }),
		},
		{
			name: 'task_update',
			description: 'Change a task. Only the fields you send change; null clears due, start, priority or description. done ticks or unticks it. Pass etag from task_get to refuse the change if someone edited it meanwhile.',
			area: 'tasks',
			action: 'write',
			input: obj({ task_id: str(), etag: str(), done: boolean(), ...taskFields }, ['task_id']),
			run: (ctx, input) => call(ctx, 'task_update', { task_id: input.task_id, etag: input.etag, fields: pick(input, ['title', 'due', 'start', 'priority', 'description', 'categories', 'done']) }),
		},
		{
			name: 'task_complete',
			description: 'Tick (done: true, default) or untick a task.',
			area: 'tasks',
			action: 'write',
			input: obj({ task_id: str(), done: boolean('Default true') }, ['task_id']),
			run: async (ctx, input) => {
				const t = await call<{ task_id: string, done: boolean, completed_at: string | null }>(ctx, 'task_update', { task_id: input.task_id, fields: { done: input.done !== false } })
				return { task_id: t.task_id, done: t.done, completed_at: t.completed_at }
			},
		},
		{
			name: 'task_delete',
			description: 'Delete a task: it goes to the calendar trash bin, restorable for 30 days. Usually needs the owner\'s approval. The request is void if the task changes meanwhile.',
			area: 'tasks',
			action: 'delete',
			input: obj({ task_id: str() }, ['task_id']),
			prepare: async (ctx, input) => {
				const t = await call<{ title: string, etag: string | null }>(ctx, 'task', { task_id: input.task_id })
				return { payload: { task_id: input.task_id, etag: t.etag }, summary: `Delete the task "${t.title}"`, ref: `task:${input.task_id}` }
			},
			stillValid: async (ctx, payload) => {
				const p = payload as { task_id: string, etag: string | null }
				try { return (await etagOf(ctx, p.task_id)) === p.etag } catch { return false }
			},
			execute: async (ctx, payload) => {
				const p = payload as { task_id: string, etag: string | null }
				const r = await call<{ title: string }>(ctx, 'task_delete', { task_id: p.task_id, etag: p.etag })
				return { task_id: p.task_id, deleted: true, in_trash: true, title: r.title }
			},
		},
	]
}

/** The reminder pass asks PHP for each user's next events and tasks. */
export function upcomingFrom(bridge: CalendarBridge): Upcoming {
	return {
		events: async (uid, from, to) => (await bridge.call<{ events: Awaited<ReturnType<Upcoming['events']>> }>('events', uid, { from: from.toISOString(), to: to.toISOString(), limit: 500 })).events,
		tasks: async (uid, dueBefore) => (await bridge.call<{ tasks: Awaited<ReturnType<Upcoming['tasks']>> }>('tasks', uid, { status: 'open', due_before: dueBefore.toISOString(), limit: 500 })).tasks,
	}
}

export function calendarModule(): AgentModule {
	let feed: CalendarFeed | null = null
	return {
		tools: (core) => calendarTools(phpCalendarBridge(core)),
		start: (core) => {
			feed = new CalendarFeed(core.db, upcomingFrom(phpCalendarBridge(core)))
			feed.start()
		},
		stop: () => feed?.stop(),
	}
}
