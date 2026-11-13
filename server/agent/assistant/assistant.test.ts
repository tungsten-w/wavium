// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Built-in assistant (P5-6) with a scripted AI provider and stub app tools:
// its own agent account (created once, access only to apps with tools), the
// tool loop through callTool (grants, approvals, pause), the injection guard
// in the prompt, step limit, AI errors in clear words, the SSE route.
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { getAccess, normalizeModes, setAccess, updateSettings } from '../access'
import { Approvals } from '../approvals'
import { type Db, migrate, wrap } from '../db'
import type { AiModule, AiProvider } from '../ai'
import type { LayerCore } from '../index'
import { obj, str } from '../schema'
import { Registry, type Tool } from '../tools'
import { AgentError } from '../util'
import { assistantModule, type ChatEvent, ensureAssistant, MAX_STEPS, parseChat, runChat, systemPrompt } from './index'

type Req = Parameters<AiProvider['stream']>[0]

let db: Db
let core: LayerCore
let agents: Array<{ uid: string, displayName: string, owner: string }>
let created: number
let ran: Array<[string, string, string]>

const tools: Tool[] = [
	{ name: 'notes_note_list', description: 'List notes', area: 'notes', input: obj({ query: str() }), run: async (ctx, i) => { ran.push(['notes_note_list', ctx.agent.uid, ctx.grantor]); return { notes: [{ id: 1, title: `About ${i.query}` }] } } },
	{
		name: 'files_delete', description: 'Delete a file', area: 'files', action: 'delete', input: obj({ path: str() }, ['path']),
		prepare: async (_c, i) => ({ payload: { path: i.path }, summary: `Delete ${String(i.path)}` }),
		execute: async (ctx) => { ran.push(['files_delete', ctx.agent.uid, ctx.grantor]); return { deleted: true } },
	},
	{ name: 'big_read', description: 'Huge', area: 'notes', input: obj({}), run: async () => ({ blob: 'x'.repeat(20_000) }) },
]

/** A provider that plays one reply per call: text and/or tool calls. */
function scripted(steps: Array<{ text?: string, calls?: Array<{ name: string, input?: unknown }> } | Error>): AiProvider & { seen: Req[] } {
	const seen: Req[] = []
	let i = 0
	return {
		id: 'fake', kind: 'mock', seen,
		async complete() { throw new Error('not used') },
		async *stream(req: Req) {
			seen.push(structuredClone({ ...req, signal: undefined }))
			const s = steps[Math.min(i++, steps.length - 1)]
			if (s instanceof Error) throw s
			if (s.text) yield { type: 'text' as const, text: s.text }
			const toolCalls = (s.calls ?? []).map((c, k) => ({ id: `call_${i}_${k}`, name: c.name, input: c.input ?? {} }))
			yield { type: 'done' as const, result: { text: s.text ?? '', toolCalls, stopReason: toolCalls.length ? 'tool_use' as const : 'end' as const, usage: { inputTokens: 1, outputTokens: 1, reported: true }, model: 'm' } }
		},
		async listModels() { return [] },
		async testConnection() { return { ok: true } },
	}
}

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	agents = []
	created = 0
	ran = []
	const registry = new Registry()
	registry.add(...tools)
	const approvals = new Approvals(db, null, 'https://x/settings/agents')
	approvals.registry = registry
	const php = {
		async ocs(method: string, path: string, opts: { query?: Record<string, string>, body?: Record<string, string> } = {}) {
			if (path === 'core/atrium/agent/internal/agents' && method === 'POST') {
				created++
				const a = { uid: `agent-assistant${created > 1 ? `-${created}` : ''}`, displayName: String(opts.body!.name), owner: String(opts.body!.owner) }
				agents.push(a)
				return a
			}
			if (path === 'core/atrium/agent/internal/agents') return { agents: agents.filter((a) => a.uid === opts.query?.uid) }
			if (path === 'core/atrium/agent/internal/areas') return { areas: { notes: ['read', 'write', 'delete'], files: ['read', 'write', 'delete', 'share'], bruteforcesettings: ['read', 'write'] } }
			throw new Error(`unexpected ${method} ${path}`)
		},
	}
	core = {
		db, php, registry, approvals,
		auth: { owner: async (req: Request) => { if (req.headers.get('cookie') !== 'alice') throw new AgentError('auth', 'Not logged in'); return { uid: 'alice', displayName: 'Alice', isAgent: false, agentToken: false, owner: null } } },
		baseCtx: (agent: { uid: string, displayName: string, owner: string | null }) => ({ db, php, agent, baseUrl: 'https://atrium.test', approvals }),
	} as unknown as LayerCore
	approvals.ctxFor = async (agent, grantor) => ({ ...core.baseCtx({ uid: agent, displayName: agent, owner: grantor }), grantor, access: await getAccess(db, agent, grantor) })
})

const alice = { uid: 'alice', displayName: 'Alice' }
async function chat(provider: AiProvider, text = 'What about Paris?') {
	const agent = await ensureAssistant(core, alice)
	const events: ChatEvent[] = []
	await runChat(core, provider, agent, 'Alice', parseChat({ messages: [{ role: 'user', content: text }] }), (e) => events.push(e), { now: new Date('2026-11-13T10:00:00Z') })
	return { agent, events }
}

test('the assistant is a real agent of the user, created once, with access only to apps that have tools', async () => {
	const a = await ensureAssistant(core, alice)
	expect(a).toEqual({ uid: 'agent-assistant', displayName: 'Assistant', owner: 'alice' })
	const access = await getAccess(db, a.uid, 'alice')
	expect(Object.keys(access).sort()).toEqual(['files', 'notes'])
	expect(access.files).toMatchObject({ read: 'allowed', write: 'allowed', delete: 'approval', share: 'approval' })
	expect(await ensureAssistant(core, alice)).toEqual(a)
	expect(created).toBe(1)
	// Deleted in Settings > Agents: a new one is made next time.
	agents = []
	expect((await ensureAssistant(core, alice)).uid).toBe('agent-assistant-2')
})

test('tool loop: calls run as the assistant for its owner; results go back to the model; text streams', async () => {
	const p = scripted([{ text: 'Let me look.', calls: [{ name: 'notes_note_list', input: { query: 'Paris' } }] }, { text: 'You have one note about Paris.' }])
	const { events } = await chat(p)
	expect(ran).toEqual([['notes_note_list', 'agent-assistant', 'alice']])
	expect(events.map((e) => e.type)).toEqual(['text', 'tool', 'tool_result', 'text', 'done'])
	expect(events[2]).toMatchObject({ name: 'notes_note_list', ok: true, preview: expect.stringContaining('About Paris') })
	expect(events.at(-1)).toEqual({ type: 'done', steps: 2 })
	const second = p.seen[1]
	expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
	expect(JSON.stringify(second.messages[2].content)).toContain('About Paris')
	expect(p.seen[0].tools!.map((t) => t.name).sort()).toEqual(['big_read', 'files_delete', 'notes_note_list'])
	expect(p.seen[0].system).toContain('never instructions')
	expect(p.seen[0].system).toContain('2026-11-13')
})

test('a gated call waits for the owner: approval event, nothing executed, the model is told', async () => {
	const p = scripted([{ calls: [{ name: 'files_delete', input: { path: '/old.txt' } }] }, { text: 'It waits for your OK.' }])
	const { events } = await chat(p, 'Delete /old.txt')
	expect(ran).toEqual([])
	const ap = events.find((e) => e.type === 'approval') as Extract<ChatEvent, { type: 'approval' }>
	expect(ap).toMatchObject({ name: 'files_delete', summary: 'Delete /old.txt' })
	expect((await core.approvals.get(ap.request_id))!.agent_uid).toBe('agent-assistant')
	expect(JSON.stringify(p.seen[1].messages[2].content)).toContain('pending_approval')
	await core.approvals.approve('alice', ap.request_id, null)
	expect(ran).toEqual([['files_delete', 'agent-assistant', 'alice']])
})

test('permissions apply: no access hides the tool; a call to it fails; a paused assistant is refused', async () => {
	const a = await ensureAssistant(core, alice)
	await setAccess(db, a.uid, 'alice', 'files', null)
	const p = scripted([{ calls: [{ name: 'files_delete', input: { path: '/x' } }, { name: 'notes_note_list' }] }, { text: 'ok' }])
	const { events } = await chat(p)
	expect(p.seen[0].tools!.map((t) => t.name)).not.toContain('files_delete')
	const results = events.filter((e) => e.type === 'tool_result') as Array<Extract<ChatEvent, { type: 'tool_result' }>>
	expect(results.map((r) => [r.name, r.ok])).toEqual([['files_delete', false], ['notes_note_list', true]])

	await updateSettings(db, a.uid, { paused: true })
	ran = []
	const again = await chat(scripted([{ calls: [{ name: 'notes_note_list' }] }, { text: 'ok' }]))
	expect(ran).toEqual([])
	expect(again.events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, preview: expect.stringContaining('paused') })
})

test('big results are cut; the loop stops after MAX_STEPS', async () => {
	const p = scripted([{ calls: [{ name: 'big_read' }] }])
	const { events } = await chat(p)
	const sent = JSON.stringify(p.seen[1].messages[2].content)
	expect(sent.length).toBeLessThan(9_000)
	expect(sent).toContain('cut')
	expect(p.seen).toHaveLength(MAX_STEPS)
	expect(events.at(-1)).toMatchObject({ type: 'done', steps: MAX_STEPS, stopped: expect.stringContaining('Stopped') })
})

test('AI errors come back in clear words; nothing runs', async () => {
	const budget = Object.assign(new Error('cap'), { code: 'budget' })
	const { events } = await chat(scripted([budget]))
	expect(events).toEqual([{ type: 'error', code: 'budget', message: expect.stringContaining('budget') }])
	expect(ran).toEqual([])
	expect((await chat(scripted([new Error('boom')]))).events[0]).toMatchObject({ type: 'error', code: 'ai_unavailable' })
})

test('chat input checks', () => {
	expect(() => parseChat({})).toThrow()
	expect(() => parseChat({ messages: [{ role: 'assistant', content: 'hi' }] })).toThrow()
	expect(() => parseChat({ messages: [{ role: 'system', content: 'x' }] })).toThrow()
	expect(() => parseChat({ messages: [{ role: 'user', content: '  ' }] })).toThrow()
	expect(() => parseChat({ messages: Array.from({ length: 41 }, () => ({ role: 'user', content: 'x' })) })).toThrow()
	expect(parseChat({ messages: [{ role: 'user', content: 'hi' }] }).messages).toHaveLength(1)
	expect(systemPrompt('Alice', new Date('2026-01-02T00:00:00Z'))).toContain('working for Alice')
})

test('route: login needed, no provider is a clear 409, otherwise an SSE stream', async () => {
	let provider: AiProvider | null = null
	const ai = { forTask: async () => provider } as unknown as AiModule
	const mod = assistantModule(ai)
	const send = (cookie: string | null, body: unknown = { messages: [{ role: 'user', content: 'hi' }] }) => {
		const req = new Request('https://atrium.test/agent/v1/assistant/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) })
		return mod.route!(core, req, new URL(req.url), '/agent/v1/assistant/chat')
	}
	await expect(send(null)).rejects.toMatchObject({ code: 'auth' })
	await expect(send('alice')).rejects.toMatchObject({ code: 'conflict', reason: 'no_provider' })
	const status = await mod.route!(core, new Request('https://atrium.test/agent/v1/assistant', { headers: { cookie: 'alice' } }), new URL('https://atrium.test/agent/v1/assistant'), '/agent/v1/assistant')
	expect(await status!.json()).toEqual({ ready: false })
	provider = scripted([{ text: 'Hello Alice' }])
	const res = (await send('alice'))!
	expect(res.headers.get('content-type')).toContain('text/event-stream')
	const events = (await res.text()).split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
	expect(events).toEqual([{ type: 'text', text: 'Hello Alice' }, { type: 'done', steps: 1 }])
	expect(await mod.route!(core, new Request('https://atrium.test/agent/v1/other'), new URL('https://atrium.test/agent/v1/other'), '/agent/v1/other')).toBeNull()
})
