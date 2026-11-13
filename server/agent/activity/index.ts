// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Activity tools (PLAN P3-5, area `activity`, read only): the user's activity
// stream (who changed which file, event, contact...), rendered by the Activity
// app itself (apps/activity/lib/Controller/AtriumAgentController.php).
import type { AgentModule, LayerCore } from '../index'
import { int, obj, str } from '../schema'
import type { Tool } from '../tools'
import { AgentError, iso } from '../util'

export interface PhpActivity {
	activity_id: number
	time: number
	app: string
	type: string
	by: string | null
	subject: string
	message: string | null
	object_type: string | null
	object_id: number | null
	object_name: string | null
	link: string | null
}

export interface ActivityBridge {
	list(uid: string, q: { since?: number, limit: number, filter?: string, object_type?: string, object_id?: number }): Promise<{ activities: PhpActivity[], has_more: boolean }>
	filters(uid: string): Promise<Array<{ id: string, name: string }>>
}

export function phpActivity(core: Pick<LayerCore, 'php'>): ActivityBridge {
	const call = <T>(path: string, body: Record<string, unknown>) => core.php.app<T>('POST', `apps/activity/api/atrium-agent/${path}`, { body })
	return {
		list: (uid, q) => call('list', { uid, ...q }),
		filters: async (uid) => (await call<{ filters: Array<{ id: string, name: string }> }>('filters', { uid })).filters,
	}
}

/** Absolute links, so an agent can hand them to the owner. */
export function activityView(a: PhpActivity, baseUrl: string) {
	const link = a.link && a.link.startsWith('/') ? baseUrl + a.link : a.link
	return { ...a, time: iso(a.time), link }
}

export function activityTools(bridge: ActivityBridge): Tool[] {
	return [
		{
			name: 'activity_list',
			description: 'The owner\'s activity stream, newest first: what changed (subject, message), in which app, by whom (`by`; null = the system), on what (object_type, object_id, object_name, link). Page with next_cursor. `filter`: all (default), self (done by the owner), by (done by others), or an app filter from activity_filters. Or one item\'s history with object_type + object_id (e.g. "files" and a file id).',
			area: 'activity',
			input: obj({
				filter: str(undefined, { maxLength: 64 }),
				object_type: str(undefined, { maxLength: 64 }),
				object_id: int(undefined, { minimum: 1 }),
				limit: int('Default 30, max 100', { minimum: 1, maximum: 100 }),
				cursor: str('next_cursor of the previous page'),
			}),
			run: async (ctx, input) => {
				const since = input.cursor === undefined ? 0 : Number(input.cursor)
				if (!Number.isInteger(since) || since < 0) throw new AgentError('invalid_input', 'Bad cursor')
				const res = await bridge.list(ctx.grantor, {
					since,
					limit: input.limit === undefined ? 30 : Number(input.limit),
					filter: input.filter === undefined ? 'all' : String(input.filter),
					object_type: input.object_type === undefined ? undefined : String(input.object_type),
					object_id: input.object_id === undefined ? undefined : Number(input.object_id),
				})
				const last = res.activities.at(-1)
				return {
					activities: res.activities.map((a) => activityView(a, ctx.baseUrl)),
					next_cursor: res.has_more && last ? String(last.activity_id) : null,
				}
			},
		},
		{
			name: 'activity_filters',
			description: 'Filter ids for activity_list (all, self, by, and one per app such as files or calendar).',
			area: 'activity',
			input: obj({}),
			run: async (ctx) => ({ filters: await bridge.filters(ctx.grantor) }),
		},
	]
}

export function activityModule(make: (core: LayerCore) => ActivityBridge = phpActivity): AgentModule {
	return { tools: (core) => activityTools(make(core)) }
}
