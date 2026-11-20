// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Messages (V4-3..V4-7) over a fake sidecar: link, sealed session, sync,
// events, agent tools with grants and approvals, one-time codes, demo, routes.
// The Go sidecar has its own tests (services/gmessages, go test).
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { normalizeModes, setAccess } from '../access'
import { Approvals } from '../approvals'
import { type Db, migrate, wrap } from '../db'
import type { LayerCore } from '../index'
import { callTool, Registry, type ToolCtx } from '../tools'
import { AgentError } from '../util'
import { messagesModule, MessagesService, messagesTools, numberKey, parseCookies } from './index'
import { isOneTimeCode } from './otp'
import type { Sidecar, SideEvent } from './sidecar'
import type { SideConversation, SideMessage } from './store'

let db: Db
let side: FakeSide
let svc: MessagesService
let core: LayerCore
let registry: Registry
let approvals: Approvals
let base: Omit<ToolCtx, 'grantor' | 'access'>

const conv = (id: string, name: string, number: string, extra: Partial<SideConversation> = {}): SideConversation => ({
	id, name, is_group: false, unread: false, last_at: 1_700_000_000_000, kind: 'sms', read_only: false, outgoing_id: 'me',
	participants: [{ id: 'me', name: '', number: '', is_me: true }, { id: 'p' + id, name, number, is_me: false }], ...extra,
})
const msg = (id: string, c: string, text: string, extra: Partial<SideMessage> = {}): SideMessage => ({
	id, conversation_id: c, at: Date.now() - 1000, from_me: false, sender_id: 'p' + c, sender_name: 'Léa', sender_number: '+33600000001', text, status: 'received', media: [], ...extra,
})

class FakeSide implements Sidecar {
	calls: string[] = []
	connected = new Map<string, unknown>()
	convs: SideConversation[] = [conv('c1', '+33 6 00 00 00 01', '+33600000001'), conv('c2', 'BANK', '38015', { read_only: true })]
	msgs: Record<string, SideMessage[]> = { c1: [msg('m1', 'c1', 'On se voit demain ?')], c2: [msg('m2', 'c2', 'Votre code de vérification est 482913')] }
	failSend = false
	async status(uid: string) { return { state: this.connected.has(uid) ? 'connected' : 'unpaired' } }
	async pairQr(uid: string) { this.calls.push(`pairQr ${uid}`); return { qr: 'QRDATA' } }
	async pairGoogle(uid: string, cookies: Record<string, string>) { this.calls.push(`pairGoogle ${uid} ${Object.keys(cookies).length}`); return { emoji: '🦊' } }
	async connect(uid: string, session: unknown) { this.calls.push(`connect ${uid} ${JSON.stringify(session)}`); this.connected.set(uid, session); return { state: 'connected' } }
	async unpair(uid: string) { this.calls.push(`unpair ${uid}`); this.connected.delete(uid) }
	async conversations() { return this.convs }
	async messages(_uid: string, c: string) { return this.msgs[c] ?? [] }
	async start(_uid: string, number: string) { const c = conv('n1', number, number); this.convs.push(c); return c }
	async send(uid: string, c: string, text: string, tmp: string) {
		this.calls.push(`send ${uid} ${c} ${text}`)
		if (this.failSend) throw new AgentError('unavailable', 'Phone: offline')
		void tmp
	}
	async markRead(uid: string, c: string, m: string) { this.calls.push(`read ${uid} ${c} ${m}`) }
	async media() { return new Uint8Array([1, 2, 3]) }
	async listen(_on: (e: SideEvent) => void, _signal: AbortSignal) {}
}

function makeCore(owner = 'alice'): LayerCore {
	return {
		db, cfg: { secret: 'test-secret-test-secret-test-secret', baseUrl: 'https://w.test' } as never,
		php: {
			ocs: async (_m: string, _p: string, o: { query?: { uid?: string, owner?: string } }) => ({
				agents: o.query?.uid === 'bot' || o.query?.owner === 'alice' ? [{ uid: 'bot', displayName: 'Bot', owner: 'alice' }] : [],
			}),
		} as never,
		auth: {
			owner: async (req: Request) => {
				if (!req.headers.get('cookie')) throw new AgentError('auth', 'Not logged in')
				if (req.method !== 'GET' && req.headers.get('ocs-apirequest') !== 'true') throw new AgentError('forbidden', 'Missing OCS-APIRequest header')
				return { uid: req.headers.get('x-test-user') ?? owner, displayName: '', isAgent: false, agentToken: false, owner: null }
			},
		} as never,
		approvals: null as never, events: null as never, notifier: null, registry: null as never,
		baseCtx: null as never, agentCtx: null as never,
	}
}

const noContacts = () => ({ list: async () => ({ contacts: [{ name: 'Léa Martin', phones: [{ value: '06 00 00 00 01', type: null }] }], total: 1 }) }) as never

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	side = new FakeSide()
	core = makeCore()
	svc = new MessagesService(core, { sidecar: side, demo: false, contacts: noContacts })
	approvals = new Approvals(db, null, 'https://x/settings/agents')
	registry = new Registry()
	registry.add(...messagesTools(() => svc))
	approvals.registry = registry
	base = { db, php: null as never, agent: { uid: 'bot', displayName: 'Bot', owner: 'alice' }, baseUrl: 'https://w.test', approvals }
	approvals.ctxFor = async (_agent, grantor) => ({ ...base, grantor, access: {} } as ToolCtx)
})

const grant = (modes: Record<string, string>) => setAccess(db, 'bot', 'alice', 'messages', normalizeModes(modes, ['read', 'write', 'send']))
const call = (name: string, input: Record<string, unknown> = {}) => callTool(registry, base, name, input) as Promise<any>
const events = async () => db.q<{ type: string, data: string, grantor_uid: string }>('SELECT type, data, grantor_uid FROM oc_atrium_agent_event_queue ORDER BY id')

async function pair(uid = 'alice') {
	await svc.linkQr(uid)
	await svc.onEvent({ type: 'paired', uid, session: { tachyon: 'SECRET-TOKEN' }, phone: 'Pixel' })
	await svc.sync(uid)
}

test('one-time codes are recognised, ordinary texts are not', () => {
	for (const t of ['Votre code de vérification est 482913', 'G-123456 is your Google verification code', 'Your OTP: 8812-331', 'BANQUE : votre code est 482 913. Ne le communiquez jamais.', 'Use code AB12-CD34 to log in'])
		expect(isOneTimeCode(t)).toBe(true)
	for (const t of ['On se voit demain à 9h ?', 'Le code de la porte, tu le connais', 'Il coûte 1500 euros', 'Rendez-vous le 12/11/2026', ''])
		expect(isOneTimeCode(t)).toBe(false)
})

test('numbers match whatever their format', () => {
	expect(numberKey('+33 6 00 00 00 01')).toBe(numberKey('06.00.00.00.01'))
})

test('pairing stores the session sealed, never in clear; restore hands it back', async () => {
	expect((await svc.status('alice')).state).toBe('unpaired')
	expect(await svc.linkQr('alice')).toEqual({ qr: 'QRDATA' })
	expect((await svc.status('alice')).state).toBe('pairing')
	await svc.onEvent({ type: 'paired', uid: 'alice', session: { tachyon: 'SECRET-TOKEN' }, phone: 'Pixel' })
	const [row] = await db.q<{ session_sealed: string }>('SELECT session_sealed FROM oc_atrium_msg_links WHERE uid = $1', ['alice'])
	expect(row.session_sealed.startsWith('v1:')).toBe(true)
	expect(row.session_sealed).not.toContain('SECRET-TOKEN')
	// A sealed session copied to another user does not open.
	await db.q("INSERT INTO oc_atrium_msg_links (uid, state, session_sealed, updated_at) VALUES ('bob', 'connected', $1, 0)", [row.session_sealed])
	await svc.restore()
	expect(side.calls).toContain('connect alice {"tachyon":"SECRET-TOKEN"}')
	expect(side.calls.some((c) => c.startsWith('connect bob'))).toBe(false)
	expect((await svc.store.link('bob'))?.state).toBe('error')
})

test('sync copies conversations and messages, named after Contacts', async () => {
	await pair()
	const convs = await svc.conversations('alice')
	expect(convs.map((c) => c.name)).toContain('Léa Martin')
	expect(convs.find((c) => c.id === 'c2')?.name).toBe('BANK')
	expect((await svc.store.messages('alice', 'c1')).map((m) => m.text)).toEqual(['On se voit demain ?'])
	// Deleted on the phone: still kept (sync never deletes).
	side.msgs.c1 = []
	await svc.sync('alice')
	expect((await svc.store.messages('alice', 'c1')).length).toBe(1)
})

test('live messages become events; codes never reach events', async () => {
	await pair()
	await svc.onEvent({ type: 'message', uid: 'alice', message: msg('m3', 'c1', 'Tu es là ?') })
	await svc.onEvent({ type: 'message', uid: 'alice', message: msg('m4', 'c2', 'Votre code de vérification est 777888') })
	await svc.onEvent({ type: 'message', uid: 'alice', message: msg('m3', 'c1', 'Tu es là ?') }) // duplicate
	const ev = await events()
	expect(ev.map((e) => e.type)).toEqual(['message.received', 'message.received'])
	expect(ev[1].data).not.toContain('777888')
	expect(ev[1].data).toContain('hidden')
	expect((await svc.store.conversation('alice', 'c1'))?.unread).toBe(true)
})

test('phone offline and logged out are tracked', async () => {
	await pair()
	await svc.onEvent({ type: 'phone_offline', uid: 'alice' })
	expect((await svc.status('alice')).offline_since).not.toBeNull()
	expect((await events()).map((e) => e.type)).toContain('messages.phone_offline')
	await svc.onEvent({ type: 'phone_online', uid: 'alice' })
	expect((await svc.status('alice')).state).toBe('connected')
	await svc.onEvent({ type: 'logged_out', uid: 'alice' })
	expect((await svc.store.link('alice'))?.session).toBeNull()
})

test('agents: no grant, nothing; codes hidden unless the owner allows them', async () => {
	await pair()
	await expect(call('messages_conversation_list')).rejects.toMatchObject({ code: 'forbidden' })
	await grant({ read: 'allowed' })
	expect((await call('messages_conversation_list')).conversations.length).toBe(2)
	const bank = await call('messages_message_list', { conversation_id: 'c2' })
	expect(bank.messages[0].text).not.toContain('482913')
	expect(bank.messages[0].one_time_code_hidden).toBe(true)
	expect((await call('messages_search', { query: '4829' })).results).toEqual([])
	await svc.store.setShowCodes('alice', 'bot', true)
	expect((await call('messages_message_list', { conversation_id: 'c2' })).messages[0].text).toContain('482913')
	await expect(call('messages_mark_read', { conversation_id: 'c1' })).rejects.toMatchObject({ code: 'forbidden' })
})

test('agents: sending waits for approval by default, then goes out as frozen', async () => {
	await pair()
	await grant({ read: 'allowed', write: 'allowed' })
	const r = await call('messages_send', { conversation_id: 'c1', text: 'Oui, 9h au café' })
	expect(r.status).toBe('pending_approval')
	expect(side.calls.some((c) => c.startsWith('send'))).toBe(false)
	const [a] = await db.q<{ summary: string }>('SELECT summary FROM oc_atrium_agent_approvals')
	expect(a.summary).toContain('Léa Martin')
	await approvals.approve('alice', r.request_id, null)
	expect(side.calls).toContain('send alice c1 Oui, 9h au café')
	// Read-only conversations (short codes) refuse answers.
	await expect(call('messages_send', { conversation_id: 'c2', text: 'STOP' })).rejects.toMatchObject({ code: 'forbidden' })
	await expect(call('messages_send', { text: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
})

test('a failed send is kept as failed and becomes an event', async () => {
	await pair()
	side.failSend = true
	await expect(svc.send('alice', 'c1', 'hello')).rejects.toMatchObject({ code: 'unavailable' })
	const ms = await svc.store.messages('alice', 'c1')
	expect(ms[ms.length - 1]).toMatchObject({ text: 'hello', status: 'failed', from_me: true })
	expect((await events()).map((e) => e.type)).toContain('message.failed')
	await expect(svc.send('alice', 'c1', 'x'.repeat(2001))).rejects.toMatchObject({ code: 'invalid_input' })
})

test('the echo from the phone replaces the "sending" placeholder', async () => {
	await pair()
	await svc.send('alice', 'c1', 'coucou')
	const tmp = (await svc.store.messages('alice', 'c1')).find((m) => m.text === 'coucou')!
	expect(tmp.status).toBe('sending')
	const [row] = await db.q<{ tmp_id: string }>('SELECT tmp_id FROM oc_atrium_msg_messages WHERE msg_id = $1', [tmp.id])
	await svc.onEvent({ type: 'message', uid: 'alice', message: msg('real1', 'c1', 'coucou', { from_me: true, status: 'sent', tmp_id: row.tmp_id }) })
	const after = (await svc.store.messages('alice', 'c1')).filter((m) => m.text === 'coucou')
	expect(after.map((m) => m.id)).toEqual(['real1'])
})

test('demo: fake conversations, nothing leaves, an automatic answer', async () => {
	const demo = new MessagesService(core, { sidecar: null, demo: true, contacts: noContacts, demoReplyMs: 10 })
	const st = await demo.status('alice')
	expect(st).toMatchObject({ state: 'demo', demo: true, available: true })
	const convs = await demo.conversations('alice')
	expect(convs.length).toBeGreaterThan(3)
	expect((await demo.conversations('bob')).map((c) => c.name)).toContain('Alice')
	await expect(demo.linkQr('alice')).rejects.toMatchObject({ code: 'unavailable' })
	await demo.send('alice', 'demo-bob', 'À tout à l’heure')
	await new Promise((r) => setTimeout(r, 50))
	const ms = await demo.store.messages('alice', 'demo-bob')
	expect(ms.slice(-2).map((m) => m.from_me)).toEqual([true, false])
})

test('no sidecar and no demo: says it is not set up', async () => {
	const off = new MessagesService(core, { sidecar: null, demo: false })
	expect((await off.status('alice')).available).toBe(false)
	await expect(off.linkQr('alice')).rejects.toMatchObject({ code: 'unavailable' })
})

test('Google account pairing: needs the Google cookies, drops odd ones', () => {
	expect(() => parseCookies({ SID: 'a' })).toThrow(/HSID/)
	const c = parseCookies('SID=1; HSID=2; SSID=3; APISID=4; SAPISID=5; bad name=6; NID=7\r\nX')
	expect(Object.keys(c).sort()).toEqual(['APISID', 'HSID', 'SAPISID', 'SID', 'SSID'])
})

test('routes: login needed, CSRF header on writes, one user cannot see another', async () => {
	const mod = messagesModule({ sidecar: side, demo: false, contacts: noContacts }, {})
	mod.tools(core)
	const route = (path: string, init: RequestInit & { user?: string } = {}) => {
		const headers = new Headers(init.headers)
		if (init.user !== '') headers.set('cookie', 'nc_session=x')
		if (init.user) headers.set('x-test-user', init.user)
		const req = new Request(`https://w.test${path}`, { ...init, headers })
		return mod.route!(core, req, new URL(req.url), new URL(req.url).pathname).catch((e) => e as AgentError)
	}
	expect(await route('/agent/v1/messages/status', { user: '' })).toMatchObject({ code: 'auth' })
	expect(await route('/agent/v1/messages/link/qr', { method: 'POST' })).toMatchObject({ code: 'forbidden' })
	const ok = await route('/agent/v1/messages/link/qr', { method: 'POST', headers: { 'OCS-APIRequest': 'true' } }) as Response
	expect(await ok.json()).toEqual({ qr: 'QRDATA' })
	// alice's messages are not bob's
	await pair('alice')
	const bobConvs = await route('/agent/v1/messages/conversations', { user: 'bob' }) as Response
	expect(((await bobConvs.json()) as { conversations: unknown[] }).conversations).toEqual([])
	const peek = await route('/agent/v1/messages/conversations/c1/messages', { user: 'bob' })
	expect(peek).toMatchObject({ code: 'not_found' })
	// Only the user's own agents get a codes setting.
	expect(await route('/agent/v1/messages/agents/other-agent', { method: 'PUT', headers: { 'OCS-APIRequest': 'true' }, body: '{"show_codes":true}' })).toMatchObject({ code: 'not_found' })
})
