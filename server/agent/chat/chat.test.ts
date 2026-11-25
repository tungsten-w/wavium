// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Talking to an agent from Wavium (V4-39): what the owner sends waits until
// the agent picks it up (once), what the agent says comes back in the thread,
// the agent is woken by an event addressed to it alone, threads never mix, and
// the owner's routes refuse what is not theirs.
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { EventLog, eventsSince } from '../events'
import { type Db, migrate, wrap } from '../db'
import { Approvals } from '../approvals'
import { updateSettings } from '../access'
import type { LayerCore } from '../index'
import { Registry } from '../tools'
import { callTool } from '../tools'
import { AgentError } from '../util'
import { AGENT_PENDING, AGENT_SAY, chatModule, chatTools, MAX_TEXT, poll, say, thread } from './index'

let db: Db
let core: LayerCore
let agents: Array<{ uid: string, displayName: string, owner: string }>
let events: EventLog

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	agents = [
		{ uid: 'claude-mail', displayName: 'Claude Mail', owner: 'alice' },
		{ uid: 'agent-assistant', displayName: 'Assistant', owner: 'alice' },
		{ uid: 'bobs-agent', displayName: 'Bob bot', owner: 'bob' },
	]
	const registry = new Registry()
	registry.add(...chatTools())
	// A real event log: enqueue() writes to the queue, and only moveQueued()
	// puts rows in the log where events_since can see them.
	events = new EventLog(db, null)
	const approvals = new Approvals(db, null, 'https://x/settings/agents')
	approvals.registry = registry
	const php = {
		async ocs(_m: string, path: string, opts: { query?: Record<string, string> } = {}) {
			if (path === 'core/atrium/agent/internal/agents') {
				const q = opts.query ?? {}
				return { agents: agents.filter((a) => (q.owner ? a.owner === q.owner : a.uid === q.uid)) }
			}
			throw new Error(`unexpected ${path}`)
		},
	}
	core = {
		db, php, registry, approvals, events,
		auth: {
			owner: async (req: Request) => {
				const who = req.headers.get('cookie')
				if (who !== 'alice' && who !== 'bob') throw new AgentError('auth', 'Not logged in')
				return { uid: who, displayName: who, isAgent: false, agentToken: false, owner: null }
			},
			// A bearer token names one agent, as the real Auth does.
			agent: async (req: Request) => {
				const uid = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
				const a = agents.find((x) => x.uid === uid)
				if (!a) throw new AgentError('auth', 'Unknown agent token')
				return { uid: a.uid, displayName: a.displayName, isAgent: true, agentToken: true, owner: a.owner }
			},
		},
		baseCtx: (agent: { uid: string, displayName: string, owner: string | null }) => ({ db, php, agent, baseUrl: 'https://wavium.test', approvals }),
	} as unknown as LayerCore
})

const asAgent = (uid: string, owner: string | null = 'alice') => core.baseCtx({ uid, displayName: uid, owner })
const call = (uid: string, name: string, input: unknown = {}, owner: string | null = 'alice') =>
	callTool(core.registry, asAgent(uid, owner), name, input)

/** The built-in assistant's row, which is what keeps it out of the list. */
const assistantIs = async (uid: string) => {
	await db.q(`CREATE TABLE IF NOT EXISTS ${db.t('atrium_assistant')} (owner_uid VARCHAR(64) PRIMARY KEY, agent_uid VARCHAR(64) NOT NULL)`)
	await db.q(`INSERT INTO ${db.t('atrium_assistant')} (owner_uid, agent_uid) VALUES ($1, $2)`, ['alice', uid])
}

const req = (method: string, path: string, who: string | null, body?: unknown) => new Request(`https://wavium.test${path}`, {
	method,
	headers: who ? { cookie: who } : {},
	body: body === undefined ? undefined : JSON.stringify(body),
})
const route = (method: string, path: string, who: string | null, body?: unknown) => {
	const r = req(method, path, who, body)
	return chatModule().route!(core, r, new URL(r.url), new URL(r.url).pathname)
}
/** The agent's own side: a token instead of a cookie, and text instead of JSON. */
const asToken = (method: string, path: string, token: string | null, text?: string) => {
	const r = new Request(`https://wavium.test${path}`, {
		method,
		headers: token ? { authorization: `Bearer ${token}` } : {},
		body: text,
	})
	return chatModule().route!(core, r, new URL(r.url), new URL(r.url).pathname)
}

test('a message waits for the agent, is picked up once, and the second run finds nothing', async () => {
	await say(db, 'claude-mail', 'alice', 'owner', 'Tague les factures de novembre')
	const first = await call('claude-mail', 'chat_poll') as { messages: Array<{ text: string }>, owner: string }
	expect([first.messages.map((m) => m.text), first.owner]).toEqual([['Tague les factures de novembre'], 'alice'])
	// Picked up: a second loop tick must not answer the same thing twice.
	expect((await call('claude-mail', 'chat_poll') as { messages: unknown[] }).messages).toEqual([])
	// It stays in the thread for the owner, marked as taken.
	expect(await thread(db, 'claude-mail', 0, 10)).toEqual([
		{ id: 1, from: 'you', text: 'Tague les factures de novembre', at: expect.any(Number), taken: true },
	])
})

test('an owner message wakes the agent: the event is addressed to it, so no grant is needed', async () => {
	const before = (await eventsSince(db, 'claude-mail', {})).next_cursor
	await say(db, 'claude-mail', 'alice', 'owner', 'bonjour')
	await events.moveQueued()
	const seen = (await eventsSince(db, 'claude-mail', { cursor: before })).events
	expect(seen.map((e) => e.type)).toEqual(['chat.message'])
	// Another agent of the same owner must not see it.
	expect((await eventsSince(db, 'bobs-agent', { cursor: before })).events).toEqual([])
})

test('what the agent says comes back in the thread, and does not wake it in turn', async () => {
	const before = (await eventsSince(db, 'claude-mail', {})).next_cursor
	const said = await call('claude-mail', 'chat_say', { text: '14 factures taguees' }) as { message_id: number }
	expect(said.message_id).toBe(1)
	expect((await thread(db, 'claude-mail', 0, 10)).map((m) => [m.from, m.text])).toEqual([['agent', '14 factures taguees']])
	await events.moveQueued()
	expect((await eventsSince(db, 'claude-mail', { cursor: before })).events).toEqual([])
})

test('empty and over-long messages are refused, in both directions', async () => {
	await expect(call('claude-mail', 'chat_say', { text: '   ' })).rejects.toThrow(/a message to send/)
	await expect(call('claude-mail', 'chat_say', { text: 'x'.repeat(MAX_TEXT + 1) })).rejects.toThrow(/at most 8000/)
	expect((await route('POST', '/agent/v1/chat/claude-mail', 'alice', { text: '' }).catch((e: Error) => e)) as Error).toMatchObject({ code: 'invalid_input' })
	// At the limit it goes through: the cap is a cap, not a trap.
	expect(await call('claude-mail', 'chat_say', { text: 'y'.repeat(MAX_TEXT) })).toMatchObject({ message_id: 1 })
})

test('threads never mix: each agent sees only what was written to it', async () => {
	await say(db, 'claude-mail', 'alice', 'owner', 'pour toi')
	await say(db, 'bobs-agent', 'bob', 'owner', 'pour bob')
	expect((await poll(db, 'claude-mail', 10)).map((m) => m.text)).toEqual(['pour toi'])
	expect((await poll(db, 'bobs-agent', 10)).map((m) => m.text)).toEqual(['pour bob'])
})

test('an agent its owner paused cannot read or answer', async () => {
	await say(db, 'claude-mail', 'alice', 'owner', 'tu es en pause')
	await updateSettings(db, 'claude-mail', { paused: true })
	await expect(call('claude-mail', 'chat_poll')).rejects.toThrow(/paused/)
	await expect(call('claude-mail', 'chat_say', { text: 'coucou' })).rejects.toThrow(/paused/)
	// Nothing was consumed: it is still waiting when the owner resumes.
	await updateSettings(db, 'claude-mail', { paused: false })
	expect((await call('claude-mail', 'chat_poll') as { messages: unknown[] }).messages).toHaveLength(1)
})

test('an agent with no owner has nobody to talk to', async () => {
	await expect(call('orphan', 'chat_say', { text: 'hello?' }, null)).rejects.toThrow(/no owner/)
})

test('the owner sees who they can talk to: not the assistant, and what is waiting', async () => {
	await assistantIs('agent-assistant')
	await say(db, 'claude-mail', 'alice', 'owner', 'un')
	await say(db, 'claude-mail', 'alice', 'owner', 'deux')
	await poll(db, 'claude-mail', 1)
	const res = await route('GET', '/agent/v1/chat', 'alice')
	expect(await res!.json()).toEqual({ agents: [{ uid: 'claude-mail', name: 'Claude Mail', paused: false, waiting: 1, lastAt: expect.any(Number) }] })
})

test('the owner reads the thread, sends, and cannot touch an agent that is not theirs', async () => {
	const sent = await (await route('POST', '/agent/v1/chat/claude-mail', 'alice', { text: 'coucou' }))!.json() as { message: { id: number, from: string } }
	expect(sent.message).toMatchObject({ id: 1, from: 'you', text: 'coucou', taken: false })
	await call('claude-mail', 'chat_poll')
	await call('claude-mail', 'chat_say', { text: 'recu' })
	const got = await (await route('GET', '/agent/v1/chat/claude-mail', 'alice'))!.json() as { agent: unknown, messages: Array<{ from: string }> }
	expect([got.agent, got.messages.map((m) => m.from)]).toEqual([{ uid: 'claude-mail', name: 'Claude Mail', paused: false }, ['you', 'agent']])
	// `after` pages: only what came later.
	const after = await (await route('GET', '/agent/v1/chat/claude-mail?after=1', 'alice'))!.json() as { messages: Array<{ text: string }> }
	expect(after.messages.map((m) => m.text)).toEqual(['recu'])
	// Bob may not read or write Alice's agent, and a stranger gets no thread at all.
	expect(await route('GET', '/agent/v1/chat/claude-mail', 'bob').catch((e: Error) => e)).toMatchObject({ code: 'not_found' })
	expect(await route('POST', '/agent/v1/chat/claude-mail', 'bob', { text: 'hi' }).catch((e: Error) => e)).toMatchObject({ code: 'not_found' })
	expect(await route('GET', '/agent/v1/chat', null).catch((e: Error) => e)).toMatchObject({ code: 'auth' })
})

test('only the chat paths are handled, and only with the verbs they have', async () => {
	expect(await route('GET', '/agent/v1/chatter', 'alice')).toBeNull()
	expect(await route('DELETE', '/agent/v1/chat', 'alice').catch((e: Error) => e)).toMatchObject({ code: 'not_found' })
	expect(await route('DELETE', '/agent/v1/chat/claude-mail', 'alice').catch((e: Error) => e)).toMatchObject({ code: 'not_found' })
})

test('the plain-text side needs nothing but a token: pending reads, say writes', async () => {
	await say(db, 'claude-mail', 'alice', 'owner', 'premier')
	await say(db, 'claude-mail', 'alice', 'owner', 'second')
	const res = (await asToken('GET', AGENT_PENDING, 'claude-mail'))!
	expect(res.headers.get('content-type')).toContain('text/plain')
	// One blank line between messages: a shell script can split on that.
	expect(await res.text()).toBe('premier\n\nsecond')
	// Taken, so the next tick of the loop does not answer them again.
	expect(await (await asToken('GET', AGENT_PENDING, 'claude-mail'))!.text()).toBe('')
	const wrote = (await asToken('POST', AGENT_SAY, 'claude-mail', 'les deux sont faits'))!
	expect(wrote.status).toBe(201)
	expect((await thread(db, 'claude-mail', 0, 10)).map((m) => [m.from, m.text])).toEqual([
		['you', 'premier'], ['you', 'second'], ['agent', 'les deux sont faits'],
	])
})

test('the plain-text side refuses what the tools refuse', async () => {
	// No token, a token nobody owns, an empty body, and a paused agent.
	expect(await asToken('GET', AGENT_PENDING, null).catch((e: Error) => e)).toMatchObject({ code: 'auth' })
	expect(await asToken('GET', AGENT_PENDING, 'nobody').catch((e: Error) => e)).toMatchObject({ code: 'auth' })
	expect(await asToken('POST', AGENT_SAY, 'claude-mail', '  ').catch((e: Error) => e)).toMatchObject({ code: 'invalid_input' })
	expect(await asToken('POST', AGENT_PENDING, 'claude-mail').catch((e: Error) => e)).toMatchObject({ code: 'not_found' })
	await updateSettings(db, 'claude-mail', { paused: true })
	expect(await asToken('GET', AGENT_PENDING, 'claude-mail').catch((e: Error) => e)).toMatchObject({ code: 'forbidden', reason: 'paused' })
	expect(await asToken('POST', AGENT_SAY, 'claude-mail', 'coucou').catch((e: Error) => e)).toMatchObject({ code: 'forbidden', reason: 'paused' })
})

test('"-" is where a user id goes, so the agent routes cannot shadow an agent', async () => {
	// An agent called "pending" keeps its own thread: only "-/pending" is special.
	agents.push({ uid: 'pending', displayName: 'Pending', owner: 'alice' })
	const got = await (await route('GET', '/agent/v1/chat/pending', 'alice'))!.json() as { agent: { uid: string } }
	expect(got.agent.uid).toBe('pending')
})
