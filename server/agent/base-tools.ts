// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Base tools every agent has (ADR 0009 section 3, "Base").
import { getSettings, grantorsFor } from './access'
import type { Approvals } from './approvals'
import { view } from './approvals'
import { eventsSince } from './events'
import { arr, int, obj, str } from './schema'
import type { Tool } from './tools'

const STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled', 'void', 'executed', 'failed']

export function baseTools(approvals: Approvals): Tool[] {
	return [
		{
			name: 'agent_whoami',
			description: 'Who this agent is: uid, owner, what each grantor allows per area (off/allowed/approval per action), wakes on/off.',
			area: null,
			input: obj({}),
			run: async (ctx) => {
				const grants = await grantorsFor(ctx.db, ctx.agent.uid)
				const settings = await getSettings(ctx.db, ctx.agent.uid)
				return {
					uid: ctx.agent.uid,
					display_name: ctx.agent.displayName,
					owner: ctx.agent.owner,
					wakes: settings.wakes,
					paused: settings.paused,
					grants: [...grants].map(([grantor, access]) => ({ grantor, areas: access })),
				}
			},
		},
		{
			name: 'events_since',
			description: 'Events after a cursor, oldest first (mail.received, approval.*). Without a cursor: no events, only next_cursor (start from now). Keep next_cursor and pass it next time. Events are kept 30 days; an older cursor fails with reason cursor_expired.',
			area: null,
			input: obj({
				cursor: str('From a previous next_cursor, e.g. "c_000123"'),
				limit: int('Default 100, max 500', { minimum: 1, maximum: 500 }),
				types: arr(str(), 'Only these types; "mail.*" matches a prefix'),
			}),
			run: (ctx, input) => eventsSince(ctx.db, ctx.agent.uid, input as never),
		},
		{
			name: 'approvals_list',
			description: 'This agent\'s approval requests, newest first.',
			area: null,
			input: obj({
				status: str(undefined, { enum: STATUSES }),
				cursor: str('From a previous next_cursor'),
				limit: int('Default 25, max 100', { minimum: 1, maximum: 100 }),
			}),
			run: (ctx, input) => approvals.list({ agent: ctx.agent.uid, status: input.status as string | undefined }, input.cursor as string | undefined, (input.limit as number | undefined) ?? 25),
		},
		{
			name: 'approvals_get',
			description: 'One approval request with its status, result or error.',
			area: null,
			input: obj({ request_id: str('e.g. "apr_01J..."') }, ['request_id']),
			run: async (ctx, input) => view(await approvals.getForAgent(ctx.agent.uid, input.request_id as string)),
		},
		{
			name: 'approvals_cancel',
			description: 'Withdraw a pending request.',
			area: null,
			input: obj({ request_id: str() }, ['request_id']),
			run: (ctx, input) => approvals.cancel(ctx.agent.uid, input.request_id as string),
		},
	]
}
