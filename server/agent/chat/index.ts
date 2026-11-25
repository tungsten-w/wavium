// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Talking to one of your agents from Wavium (V4-39), instead of from a
// terminal. One thread per agent, both directions, in atrium_agent_chat.
//
// The owner writes from the shell's assistant panel (session cookie):
//   GET  /agent/v1/chat              -> the agents they can talk to
//   GET  /agent/v1/chat/<uid>        -> the thread, oldest first
//   POST /agent/v1/chat/<uid>        -> send a message
//
// The agent reads and answers with two base tools, `chat_poll` and `chat_say`.
// They are base tools (no grant area): a message its owner deliberately typed
// to it is not access to the owner's data, and an answer is the agent's own
// words. Nothing here reads mail, files or anything else.
//
// The same two, in plain text, for an agent whose runner is a shell script
// (agent token, not a session):
//   GET  /agent/v1/chat/-/pending   -> the waiting messages, one per block
//   POST /agent/v1/chat/-/say       -> the body is what it says
// "-" is where a user id goes, and a user id can never contain a slash, so
// these can never shadow somebody's agent. They exist so that a runner needs
// nothing but curl: building and parsing JSON in sh is where such scripts rot.
//
// There is no push towards the agent on purpose. An agent like `claude-mail`
// runs on the owner's machine with no way in from here, so it asks: a loop
// polls, and only starts a real run when something is waiting
// (services/agentchat/chat-loop.sh).
import { getSettings } from '../access'
import type { Db } from '../db'
import { enqueue } from '../events'
import type { AgentModule, LayerCore } from '../index'
import { int, obj, str } from '../schema'
import type { Tool } from '../tools'
import { AgentError, nowSec } from '../util'

/** Longest message, either way. Long enough for a task, short enough to answer. */
export const MAX_TEXT = 8000
/** The agent's side of the thread, for a runner that only has curl. */
export const AGENT_PENDING = '/agent/v1/chat/-/pending'
export const AGENT_SAY = '/agent/v1/chat/-/say'
const PAGE = 200

export interface ChatRow {
	id: number | string
	agent_uid: string
	owner_uid: string
	role: string
	body: string
	created_at: number | string
	taken_at: number | string | null
}

const T = (db: Db) => db.t('atrium_agent_chat')
const n = (v: unknown): number => Number(v ?? 0)

export interface ChatMessage { id: number, from: 'you' | 'agent', text: string, at: number, taken: boolean }

const message = (r: ChatRow): ChatMessage => ({
	id: n(r.id),
	from: r.role === 'owner' ? 'you' : 'agent',
	text: r.body,
	at: n(r.created_at),
	taken: r.taken_at !== null,
})

/** The text of a message, checked. Refuses empty and over-long, like the assistant. */
export function chatText(v: unknown): string {
	const text = typeof v === 'string' ? v.trim() : ''
	if (!text) throw new AgentError('invalid_input', 'text: a message to send')
	if (text.length > MAX_TEXT) throw new AgentError('invalid_input', `text: at most ${MAX_TEXT} characters`)
	return text
}

export async function say(db: Db, agent: string, owner: string, role: 'owner' | 'agent', text: string): Promise<ChatMessage> {
	const at = nowSec()
	await db.q(`INSERT INTO ${T(db)} (agent_uid, owner_uid, role, body, created_at, taken_at) VALUES ($1, $2, $3, $4, $5, NULL)`,
		[agent, owner, role, text, at])
	const [row] = await db.q<ChatRow>(`SELECT * FROM ${T(db)} WHERE agent_uid = $1 AND role = $2 ORDER BY id DESC LIMIT 1`, [agent, role])
	// Only an owner message is news for the agent; its own answer is not.
	if (role === 'owner') {
		await enqueue(db, {
			app: 'chat', area: 'chat', type: 'chat.message', grantor: owner, agent,
			wakeHint: true, data: { message_id: n(row?.id), chars: text.length },
		})
	}
	return message(row!)
}

/** Owner messages the agent has not picked up yet; marks them picked up. */
export async function poll(db: Db, agent: string, limit: number): Promise<ChatMessage[]> {
	const rows = await db.q<ChatRow>(
		`SELECT * FROM ${T(db)} WHERE agent_uid = $1 AND role = 'owner' AND taken_at IS NULL ORDER BY id LIMIT $2`, [agent, limit])
	if (rows.length) {
		const at = nowSec()
		for (const r of rows) await db.q(`UPDATE ${T(db)} SET taken_at = $1 WHERE id = $2`, [at, n(r.id)])
	}
	return rows.map(message)
}

export async function thread(db: Db, agent: string, after: number, limit: number): Promise<ChatMessage[]> {
	const rows = await db.q<ChatRow>(`SELECT * FROM ${T(db)} WHERE agent_uid = $1 AND id > $2 ORDER BY id LIMIT $3`, [agent, after, limit])
	return rows.map(message)
}

/** An agent with no owner has nobody to talk to: say so rather than writing a row with no reader. */
function ownerOf(owner: string | null): string {
	if (!owner) throw new AgentError('forbidden', 'This agent has no owner to talk to')
	return owner
}

export function chatTools(): Tool[] {
	return [
		{
			name: 'chat_poll',
			description: 'Messages your owner has sent you in Wavium and you have not picked up yet, oldest first. Reading them marks them as picked up, so calling this twice does not answer the same message twice. Answer with chat_say.',
			area: null,
			input: obj({ limit: int('Default 20, max 100', { minimum: 1, maximum: 100 }) }),
			run: async (ctx, input) => {
				const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 100)
				const messages = await poll(ctx.db, ctx.agent.uid, limit)
				return { messages: messages.map((m) => ({ message_id: m.id, text: m.text, sent_at: m.at })), owner: ownerOf(ctx.agent.owner) }
			},
		},
		{
			name: 'chat_say',
			description: 'Say something to your owner in Wavium: an answer, what you did, or a question. It appears in their assistant panel. Use it to report, never to send a mail.',
			area: null,
			input: obj({ text: str(`What to say, at most ${MAX_TEXT} characters`) }, ['text']),
			run: async (ctx, input) => {
				const m = await say(ctx.db, ctx.agent.uid, ownerOf(ctx.agent.owner), 'agent', chatText(input.text))
				return { message_id: m.id, said_at: m.at }
			},
		},
	]
}

/** The agents of one user, newest message first, without the built-in assistant. */
async function talkable(core: LayerCore, owner: string) {
	const res = await core.php.ocs<{ agents: Array<{ uid: string, displayName: string, owner: string }> }>(
		'GET', 'core/atrium/agent/internal/agents', { query: { owner } })
	// The assistant has its own panel and its own AI provider; it is not someone
	// to write to. Its table only exists once it has been used at least once.
	const [assistant] = await core.db.q<{ agent_uid: string }>(
		`SELECT agent_uid FROM ${core.db.t('atrium_assistant')} WHERE owner_uid = $1`, [owner]).catch(() => [])
	const counts = await core.db.q<{ agent_uid: string, waiting: number | string, last_at: number | string }>(
		`SELECT agent_uid, SUM(CASE WHEN role = 'owner' AND taken_at IS NULL THEN 1 ELSE 0 END) AS waiting, MAX(created_at) AS last_at
		 FROM ${T(core.db)} WHERE owner_uid = $1 GROUP BY agent_uid`, [owner])
	const by = new Map(counts.map((c) => [c.agent_uid, c]))
	const out = []
	for (const a of res.agents) {
		if (a.uid === assistant?.agent_uid) continue
		const c = by.get(a.uid)
		out.push({
			uid: a.uid,
			name: a.displayName,
			paused: (await getSettings(core.db, a.uid)).paused,
			waiting: n(c?.waiting),
			lastAt: c ? n(c.last_at) : 0,
		})
	}
	return out.sort((x, y) => y.lastAt - x.lastAt || x.name.localeCompare(y.name))
}

export function chatModule(): AgentModule {
	return {
		tools: () => chatTools(),
		async route(core, req, url, pathname) {
			if (pathname !== '/agent/v1/chat' && !pathname.startsWith('/agent/v1/chat/')) return null
			// The agent's own side: an agent token, and text in and out.
			if (pathname === AGENT_PENDING || pathname === AGENT_SAY) {
				const caller = await core.auth.agent(req)
				const owner = ownerOf(caller.owner)
				if ((await getSettings(core.db, caller.uid)).paused) throw new AgentError('forbidden', 'This agent is paused by its owner', 'paused')
				if (pathname === AGENT_PENDING) {
					if (req.method !== 'GET') throw new AgentError('not_found', 'GET only')
					const msgs = await poll(core.db, caller.uid, 10)
					return new Response(msgs.map((m) => m.text).join('\n\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
				}
				if (req.method !== 'POST') throw new AgentError('not_found', 'POST only')
				const m = await say(core.db, caller.uid, owner, 'agent', chatText(await req.text()))
				return new Response(String(m.id), { status: 201, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
			}
			const owner = await core.auth.owner(req)
			if (pathname === '/agent/v1/chat') {
				if (req.method !== 'GET') throw new AgentError('not_found', 'GET only')
				return Response.json({ agents: await talkable(core, owner.uid) })
			}
			const uid = decodeURIComponent(pathname.slice('/agent/v1/chat/'.length))
			const agents = await talkable(core, owner.uid)
			const agent = agents.find((a) => a.uid === uid)
			if (!agent) throw new AgentError('not_found', `No agent ${uid} to talk to`)
			if (req.method === 'GET') {
				const after = Number(url.searchParams.get('after') ?? 0)
				return Response.json({
					agent: { uid: agent.uid, name: agent.name, paused: agent.paused },
					messages: await thread(core.db, uid, Number.isFinite(after) && after > 0 ? after : 0, PAGE),
				})
			}
			if (req.method !== 'POST') throw new AgentError('not_found', 'GET or POST')
			let body: unknown
			try { body = await req.json() } catch { throw new AgentError('invalid_input', 'Body must be JSON') }
			const text = chatText((body as { text?: unknown })?.text)
			return Response.json({ message: await say(core.db, uid, owner.uid, 'owner', text) })
		},
	}
}
