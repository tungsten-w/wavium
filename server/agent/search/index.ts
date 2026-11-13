// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cross-app search (PLAN P3-6): one `search` tool that runs the search of
// every app the agent can read for this grantor (mail, files, contacts, notes,
// calendar events, tasks) and returns short hits, each with the tool call that
// opens it. It reuses the apps' own tools, so it sees exactly what they see:
// no new PHP, no index of its own. Apps the agent cannot read are listed in
// `skipped`, never queried; an app that fails is listed in `errors` and the
// others still answer.
import { modeOf } from '../access'
import type { AgentModule, LayerCore } from '../index'
import { arr, int, obj, str } from '../schema'
import type { Registry, Tool, ToolCtx } from '../tools'
import { AgentError } from '../util'

export interface Hit {
	app: string
	kind: string
	id: string | number
	title: string
	snippet: string | null
	date: string | null
	/** The call that returns the full item. */
	open: { tool: string, input: Record<string, unknown> }
}

type Row = Record<string, unknown>
const s = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v))
const DAY = 86_400_000

export interface Source {
	app: string
	/** Grant area that must allow read. */
	area: string
	/** Tool that runs the search (skipped when not registered). */
	tool: string
	input(query: string, limit: number, now: Date): Record<string, unknown>
	hits(out: Row): Hit[]
}

const firstValue = (v: unknown): string | null => {
	if (!Array.isArray(v) || v.length === 0) return null
	const x = v[0] as unknown
	return s(typeof x === 'object' && x !== null ? (x as Row).value : x)
}

export const SOURCES: Source[] = [
	{
		app: 'mail', area: 'mail', tool: 'mail_message_list',
		// The mail tool's default folders (inbox + archive): no spam, no trash.
		input: (q, limit) => ({ text: q, limit }),
		hits: (o) => (o.messages as Row[] ?? []).map((m) => ({
			app: 'mail', kind: 'message', id: String(m.message_key), title: String(m.subject ?? ''),
			snippet: s(m.from && typeof m.from === 'object' ? [(m.from as Row).name, (m.from as Row).email].filter(Boolean).join(' ') + ': ' + String(m.snippet ?? '') : m.snippet),
			date: s(m.date), open: { tool: 'mail_message_get', input: { message_key: m.message_key } },
		})),
	},
	{
		app: 'files', area: 'files', tool: 'files_search',
		input: (q, limit) => ({ query: q, limit }),
		hits: (o) => (o.results as Row[] ?? []).map((n) => ({
			app: 'files', kind: String(n.type ?? 'file'), id: Number(n.file_id), title: String(n.path ?? n.name ?? ''),
			snippet: s(n.mime), date: s(n.modified),
			open: n.type === 'folder' ? { tool: 'files_list', input: { file_id: n.file_id } } : { tool: 'files_read', input: { file_id: n.file_id } },
		})),
	},
	{
		app: 'contacts', area: 'contacts', tool: 'contacts_contact_list',
		input: (q, limit) => ({ query: q, limit }),
		hits: (o) => (o.contacts as Row[] ?? []).map((c) => ({
			app: 'contacts', kind: 'contact', id: String(c.contact_id), title: String(c.name ?? ''),
			snippet: [s(c.org), firstValue(c.emails), firstValue(c.phones)].filter(Boolean).join(' · ') || null,
			date: null, open: { tool: 'contacts_contact_get', input: { contact_id: c.contact_id } },
		})),
	},
	{
		app: 'notes', area: 'notes', tool: 'notes_note_list',
		input: (q, limit) => ({ query: q, limit }),
		hits: (o) => (o.notes as Row[] ?? []).map((n) => ({
			app: 'notes', kind: 'note', id: Number(n.id), title: String(n.title ?? ''),
			snippet: s(n.excerpt), date: s(n.modified), open: { tool: 'notes_note_get', input: { id: n.id } },
		})),
	},
	{
		// Events six months back and six months ahead (the tool allows 366 days).
		app: 'calendar', area: 'calendar', tool: 'calendar_event_list',
		input: (q, limit, now) => ({ query: q, limit, from: new Date(now.getTime() - 182 * DAY).toISOString(), to: new Date(now.getTime() + 182 * DAY).toISOString() }),
		hits: (o) => (o.events as Row[] ?? []).map((e) => ({
			app: 'calendar', kind: 'event', id: String(e.event_id), title: String(e.title ?? ''),
			snippet: s(e.location), date: s(e.start), open: { tool: 'calendar_event_get', input: { event_id: e.event_id } },
		})),
	},
	{
		app: 'tasks', area: 'calendar', tool: 'task_list',
		input: (q, limit) => ({ query: q, limit, status: 'all' }),
		hits: (o) => (o.tasks as Row[] ?? []).map((t) => ({
			app: 'tasks', kind: 'task', id: String(t.task_id), title: String(t.title ?? ''),
			snippet: s(t.status), date: s(t.due ?? t.start), open: { tool: 'task_get', input: { task_id: t.task_id } },
		})),
	},
]

export const APPS = SOURCES.map((x) => x.app)

export function searchTool(registry: () => Registry, sources: Source[] = SOURCES, now: () => Date = () => new Date()): Tool {
	return {
		name: 'search',
		description: `Search everything the agent can read for this grantor at once: ${APPS.join(', ')}. Each hit has app, kind, id, title, a short snippet, a date and \`open\` = the tool call that returns the full item. Apps without read access are listed in \`skipped\`; an app that fails is in \`errors\` and the others still answer. For finer filters, use each app's own list tool.`,
		area: null,
		input: obj({
			query: str('Words to look for', { minLength: 2, maxLength: 200 }),
			apps: arr(str(undefined, { enum: APPS }), 'Only these apps (default all)', { maxItems: APPS.length }),
			limit: int('Hits per app, default 5, max 20', { minimum: 1, maximum: 20 }),
		}, ['query']),
		run: async (ctx: ToolCtx, input) => {
			const query = String(input.query).trim()
			if (query.length < 2) throw new AgentError('invalid_input', 'query: at least 2 characters')
			const limit = input.limit === undefined ? 5 : Number(input.limit)
			const wanted = input.apps === undefined ? null : new Set(input.apps as string[])
			if (wanted?.size === 0) throw new AgentError('invalid_input', 'apps: give at least one app, or leave it out')
			const reg = registry()
			const at = now()
			const skipped: Array<{ app: string, reason: string }> = []
			const jobs: Array<Promise<{ app: string, hits: Hit[] }>> = []
			for (const src of sources) {
				if (wanted && !wanted.has(src.app)) continue
				const tool = reg.get(src.tool)
				if (!tool?.run) { skipped.push({ app: src.app, reason: 'not installed' }); continue }
				if (modeOf(ctx.access[src.area], 'read') !== 'allowed') { skipped.push({ app: src.app, reason: 'no read access' }); continue }
				const run = tool.run
				jobs.push((async () => ({ app: src.app, hits: src.hits(await run(ctx, src.input(query, limit, at)) as Row).slice(0, limit) }))())
			}
			const settled = await Promise.allSettled(jobs)
			const results: Hit[] = []
			const errors: Array<{ app: string, code: string, message: string }> = []
			const asked = sources.filter((src) => (!wanted || wanted.has(src.app)) && !skipped.some((k) => k.app === src.app))
			settled.forEach((r, i) => {
				if (r.status === 'fulfilled') results.push(...r.value.hits)
				else {
					const e = r.reason
					errors.push({ app: asked[i].app, code: e instanceof AgentError ? e.code : 'internal', message: e instanceof AgentError ? e.message : 'The app search failed' })
					if (!(e instanceof AgentError)) console.error(`agent search ${asked[i].app}: ${(e as Error)?.message}`)
				}
			})
			return { query, results, skipped, errors }
		},
	}
}

export function searchModule(): AgentModule {
	return { tools: (core: LayerCore) => [searchTool(() => core.registry)] }
}
