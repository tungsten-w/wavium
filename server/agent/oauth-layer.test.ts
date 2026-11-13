// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OAuth for MCP through the whole agent layer (P2-7), with a fake PHP: the
// 401 challenge, discovery, the owner's consent API (own agents only), the
// token at /agent/mcp and nowhere else, connected apps and disconnect.
import { SQL } from 'bun'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type Db, wrap } from './db'
import { createLayer } from './index'
import type { PhpCaller } from './phpcall'
import { s256 } from './oauth'
import { AgentError } from './util'

const BASE = 'https://atrium.test'
const VERIFIER = 'x'.repeat(60)
const AGENTS = [
	{ uid: 'agent-a', displayName: 'Helper', owner: 'alice', description: '', createdAt: 1, enabled: true },
	{ uid: 'agent-b', displayName: 'Bob bot', owner: 'bob', description: '', createdAt: 1, enabled: true },
]

let db: Db
let layer: Awaited<ReturnType<typeof createLayer>>

const php = {
	async ocs(method: string, path: string, opts: { headers?: Record<string, string>, query?: Record<string, string> } = {}) {
		if (path === 'core/atrium/agent/whoami') {
			const h = opts.headers ?? {}
			if (h.cookie === 'session=alice') return { uid: 'alice', displayName: 'Alice', isAgent: false, agentToken: false, owner: null }
			if (h.authorization === 'Bearer plain-agent-token') return { uid: 'agent-a', displayName: 'Helper', isAgent: true, agentToken: true, owner: 'alice' }
			throw new AgentError('auth', 'not logged in')
		}
		if (path === 'core/atrium/agent/internal/agents' && method === 'GET') {
			const q = opts.query ?? {}
			return { agents: AGENTS.filter((a) => (!q.uid || a.uid === q.uid) && (!q.owner || a.owner === q.owner)) }
		}
		if (/\/tokens$/.test(path) && method === 'GET') return { tokens: [] }
		throw new Error(`unexpected PHP call ${method} ${path}`)
	},
	async app() { throw new Error('no app calls') },
	async raw() { throw new Error('no raw calls') },
} as unknown as PhpCaller

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	layer = await createLayer({ cfg: { baseUrl: BASE, secret: 's', dbtype: 'sqlite3', dbname: '', dbhost: '', dbport: '', dbuser: '', dbpassword: '', dbtableprefix: 'oc_', datadirectory: '' }, db, php })
})
afterEach(async () => { await layer.stop() })

function call(path: string, init: RequestInit = {}) {
	const req = new Request(BASE + path, init)
	const url = new URL(req.url)
	return layer.handle(req, url, url.pathname, '127.0.0.1')
}
const owner = (path: string, method = 'GET', body?: unknown) => call(path, {
	method, headers: { cookie: 'session=alice', 'OCS-APIRequest': 'true', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
})
const mcp = (token: string | null, method = 'tools/list', params: unknown = {}) => call('/agent/mcp', {
	method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
	body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
})

async function connect(agent = 'agent-a') {
	const reg = await (await call('/agent/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['http://localhost:7777/cb'] }) })).json() as { client_id: string }
	const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://localhost:7777/cb', code_challenge: s256(VERIFIER), code_challenge_method: 'S256', state: 's1', resource: `${BASE}/agent/mcp` })
	const auth = await call(`/agent/oauth/authorize?${q}`)
	expect(auth.status).toBe(302)
	const flow = new URL(auth.headers.get('location')!).searchParams.get('flow')!
	expect((await owner(`/agent/v1/owner/oauth/flows/${flow}`)).status).toBe(200)
	const ok = await owner(`/agent/v1/owner/oauth/flows/${flow}/approve`, 'POST', { agent })
	if (ok.status !== 200) return { status: ok.status, client: reg.client_id }
	const code = new URL(((await ok.json()) as { redirect: string }).redirect).searchParams.get('code')!
	const tok = await (await call('/agent/oauth/token', {
		method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, code_verifier: VERIFIER, redirect_uri: 'http://localhost:7777/cb', resource: `${BASE}/agent/mcp` }).toString(),
	})).json() as { access_token: string }
	return { status: 200, client: reg.client_id, token: tok.access_token }
}

test('401 at /agent/mcp points to the resource metadata, which points to the server metadata', async () => {
	const r = await mcp(null)
	expect(r.status).toBe(401)
	const challenge = r.headers.get('www-authenticate')!
	const meta = /resource_metadata="([^"]+)"/.exec(challenge)![1]
	expect(meta).toBe(`${BASE}/.well-known/oauth-protected-resource/agent/mcp`)
	const prm = await (await call(new URL(meta).pathname)).json() as { authorization_servers: string[] }
	const as = await (await call('/.well-known/oauth-authorization-server')).json() as { issuer: string }
	expect(as.issuer).toBe(prm.authorization_servers[0])
	// Elsewhere the challenge stays the plain one.
	expect((await call('/agent/v1/tools/agent_whoami', { method: 'POST' })).headers.get('www-authenticate')).toBe('Bearer realm="atrium"')
})

test('connect, call MCP as that agent; the token works only at /agent/mcp; disconnect', async () => {
	const c = await connect()
	expect(c.token).toMatch(/^atr_oat_/)
	const list = await (await mcp(c.token!)).json() as { result: { tools: Array<{ name: string }> } }
	expect(list.result.tools.map((t) => t.name)).toContain('agent_whoami')
	const who = await (await mcp(c.token!, 'tools/call', { name: 'agent_whoami', arguments: {} })).json() as { result: { content: Array<{ text: string }> } }
	expect(JSON.parse(who.result.content[0].text)).toMatchObject({ uid: 'agent-a', owner: 'alice' })
	expect((await call('/agent/v1/tools/agent_whoami', { method: 'POST', headers: { Authorization: `Bearer ${c.token}` } })).status).toBe(401)
	// A plain agent token keeps working at /agent/mcp.
	expect((await mcp('plain-agent-token')).status).toBe(200)

	const agent = await (await owner('/agent/v1/owner/agents/agent-a')).json() as { connectedApps: Array<{ grantId: string, clientName: string }> }
	expect(agent.connectedApps.map((x) => x.clientName)).toEqual(['Claude'])
	expect((await owner(`/agent/v1/owner/agents/agent-a/oauth/${agent.connectedApps[0].grantId}`, 'DELETE')).status).toBe(200)
	expect((await mcp(c.token!)).status).toBe(401)
})

test('the owner can only bind their own agent; consent needs the OCS header', async () => {
	const c = await connect('agent-b')
	expect(c.status).toBe(404)
	const reg = await (await call('/agent/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost:7777/cb'] }) })).json() as { client_id: string }
	const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, code_challenge: s256(VERIFIER), code_challenge_method: 'S256' })
	const flow = new URL((await call(`/agent/oauth/authorize?${q}`)).headers.get('location')!).searchParams.get('flow')!
	const noHeader = await call(`/agent/v1/owner/oauth/flows/${flow}/approve`, { method: 'POST', headers: { cookie: 'session=alice', 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'agent-a' }) })
	expect(noHeader.status).toBe(403)
})
