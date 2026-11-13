// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OAuth 2.1 for MCP (P2-7): discovery, client registration (DCR and client ID
// metadata documents behind the SSRF guard), authorize with PKCE, consent
// bound to one user, one-time codes, token audience, refresh rotation with
// replay detection, revocation. No network: fake fetch and DNS.
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { type Db, migrate, wrap } from './db'
import { webhookPolicy } from './netguard'
import { type AgentInfo, OAuth, redirectMatches, s256, validRedirect } from './oauth'

const BASE = 'https://atrium.test'
const VERIFIER = 'v'.repeat(20) + '-abcdefghijklmnopqrstuvwxyz0123456789'
let db: Db
let t: number
let agents: Map<string, AgentInfo>
let fetched: string[]
let docs: Map<string, { status?: number, body: unknown }>
let dns: string[]
let oauth: OAuth

const make = (base = BASE) => new OAuth(db, base, async (uid) => agents.get(uid) ?? null, (async (url: string) => {
	fetched.push(String(url))
	const d = docs.get(String(url))
	if (!d) return new Response('nope', { status: 404 })
	return new Response(JSON.stringify(d.body), { status: d.status ?? 200 })
}) as unknown as typeof fetch, webhookPolicy('', async () => dns), () => t)

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	t = 1_800_000_000
	agents = new Map([['agent-a', { uid: 'agent-a', displayName: 'A', owner: 'alice' }], ['agent-b', { uid: 'agent-b', displayName: 'B', owner: 'bob' }]])
	fetched = []
	docs = new Map()
	dns = ['93.184.216.34']
	oauth = make()
})

const get = (path: string) => oauth.handle(new Request(BASE + path), new URL(BASE + path), path.split('?')[0])
const post = (path: string, body: Record<string, string> | unknown, json = false) => oauth.handle(
	new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' }, body: json ? JSON.stringify(body) : new URLSearchParams(body as Record<string, string>).toString() }),
	new URL(BASE + path), path) as Promise<Response>

async function register(uris = ['http://127.0.0.1:33418/callback']) {
	const r = (await post('/agent/oauth/register', { client_name: 'Test MCP', redirect_uris: uris }, true))
	expect(r.status).toBe(201)
	return (await r.json()) as { client_id: string }
}

function authUrl(client: string, f: Record<string, string> = {}) {
	const q = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: 'http://127.0.0.1:33418/callback', code_challenge: s256(VERIFIER), code_challenge_method: 'S256', state: 'xyz', resource: `${BASE}/agent/mcp`, ...f })
	for (const [k, v] of Object.entries(f)) if (v === '') q.delete(k)
	return `/agent/oauth/authorize?${q}`
}

async function flowFor(client: string, f: Record<string, string> = {}) {
	const r = (await get(authUrl(client, f)))!
	expect(r.status).toBe(302)
	const loc = new URL(r.headers.get('location')!)
	expect(loc.pathname).toBe('/settings/user/agent-connect')
	return loc.searchParams.get('flow')!
}

async function codeFor(client: string, agent = 'agent-a', owner = 'alice') {
	const flow = await flowFor(client)
	await oauth.flow(owner, flow)
	const { redirect } = await oauth.approve(owner, flow, agent)
	return new URL(redirect).searchParams.get('code')!
}

const exchange = (client: string, code: string, f: Record<string, string> = {}) => post('/agent/oauth/token', { grant_type: 'authorization_code', code, client_id: client, code_verifier: VERIFIER, redirect_uri: 'http://127.0.0.1:33418/callback', resource: `${BASE}/agent/mcp`, ...f })

test('discovery documents', async () => {
	const prm = await (await get('/.well-known/oauth-protected-resource/agent/mcp'))!.json()
	expect(prm).toMatchObject({ resource: `${BASE}/agent/mcp`, authorization_servers: [BASE] })
	expect(await (await get('/.well-known/oauth-protected-resource'))!.json()).toEqual(prm)
	const as = await (await get('/.well-known/oauth-authorization-server'))!.json() as Record<string, unknown>
	expect(as).toMatchObject({ issuer: BASE, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true, registration_endpoint: `${BASE}/agent/oauth/register` })
	expect(await get('/.well-known/oauth-protected-resource/other')).toBeNull()
	expect(await get('/somewhere')).toBeNull()
	expect(oauth.challenge).toBe(`Bearer realm="atrium", resource_metadata="${BASE}/.well-known/oauth-protected-resource/agent/mcp"`)
})

test('redirect URI rules', () => {
	expect(validRedirect('https://claude.ai/api/mcp/auth_callback')).toBe(true)
	expect(validRedirect('http://localhost:6274/cb')).toBe(true)
	expect(validRedirect('cursor://anysphere.cursor-retrieval/oauth/callback')).toBe(true)
	expect(validRedirect('http://evil.example/cb')).toBe(false)
	expect(validRedirect('javascript:alert(1)')).toBe(false)
	expect(validRedirect('https://x.test/cb#frag')).toBe(false)
	expect(redirectMatches(['http://127.0.0.1/callback'], 'http://127.0.0.1:5555/callback')).toBe(true)
	expect(redirectMatches(['http://127.0.0.1/callback'], 'http://127.0.0.1:5555/other')).toBe(false)
	expect(redirectMatches(['https://a.test/cb'], 'https://a.test:444/cb')).toBe(false)
})

test('dynamic registration: public clients with safe redirect URIs only', async () => {
	expect((await post('/agent/oauth/register', { redirect_uris: ['http://evil.example/cb'] }, true)).status).toBe(400)
	const conf = await post('/agent/oauth/register', { redirect_uris: ['https://a.test/cb'], token_endpoint_auth_method: 'client_secret_basic' }, true)
	expect(await conf.json()).toMatchObject({ error: 'invalid_client_metadata' })
	const c = await register()
	expect(c.client_id).toMatch(/^atr_cli_/)
})

test('authorize: bad client or redirect never redirects; later errors go back to the app', async () => {
	const { client_id } = await register()
	const unknown = (await get(authUrl('nope')))!
	expect(unknown.status).toBe(400)
	expect(unknown.headers.get('location')).toBeNull()
	const wrongRedirect = (await get(authUrl(client_id, { redirect_uri: 'https://evil.example/cb' })))!
	expect(wrongRedirect.status).toBe(400)
	expect(await wrongRedirect.text()).toContain('redirect_uri')

	const noPkce = new URL((await get(authUrl(client_id, { code_challenge: '' })))!.headers.get('location')!)
	expect(Object.fromEntries(noPkce.searchParams)).toMatchObject({ error: 'invalid_request', state: 'xyz', iss: BASE })
	const plain = new URL((await get(authUrl(client_id, { code_challenge_method: 'plain' })))!.headers.get('location')!)
	expect(plain.searchParams.get('error')).toBe('invalid_request')
	const otherResource = new URL((await get(authUrl(client_id, { resource: 'https://other.test/mcp' })))!.headers.get('location')!)
	expect(otherResource.searchParams.get('error')).toBe('invalid_target')
	// Case and trailing slash do not matter for the resource.
	await flowFor(client_id, { resource: 'HTTPS://ATRIUM.TEST/agent/mcp/' })
})

test('consent: bound to the first user who opens it, answered once; deny goes back with access_denied', async () => {
	const { client_id } = await register()
	const flow = await flowFor(client_id)
	expect(await oauth.flow('alice', flow)).toMatchObject({ client_name: 'Test MCP', client_kind: 'dcr', redirect_host: '127.0.0.1:33418', localhost: true })
	await expect(oauth.flow('bob', flow)).rejects.toMatchObject({ code: 'not_found' })
	const { redirect } = await oauth.approve('alice', flow, 'agent-a')
	const r = new URL(redirect)
	expect(r.origin + r.pathname).toBe('http://127.0.0.1:33418/callback')
	expect(r.searchParams.get('state')).toBe('xyz')
	expect(r.searchParams.get('iss')).toBe(BASE)
	expect(r.searchParams.get('code')).toMatch(/^atr_oac_/)
	await expect(oauth.approve('alice', flow, 'agent-a')).rejects.toMatchObject({ code: 'conflict' })

	const flow2 = await flowFor(client_id)
	const d = new URL((await oauth.deny('alice', flow2)).redirect)
	expect(d.searchParams.get('error')).toBe('access_denied')
	await expect(oauth.approve('alice', flow2, 'agent-a')).rejects.toMatchObject({ code: 'conflict' })

	const flow3 = await flowFor(client_id)
	t += 16 * 60
	await expect(oauth.flow('alice', flow3)).rejects.toMatchObject({ code: 'not_found' })
})

test('code exchange: PKCE, client, redirect, single use (a replay revokes), expiry', async () => {
	const { client_id } = await register()
	const other = (await register()).client_id
	const code = await codeFor(client_id)
	expect(await (await exchange(client_id, code, { code_verifier: 'w'.repeat(50) })).json()).toMatchObject({ error: 'invalid_grant' })
	const code2 = await codeFor(client_id)
	expect(await (await exchange(other, code2)).json()).toMatchObject({ error: 'invalid_grant' })
	const code3 = await codeFor(client_id)
	expect(await (await exchange(client_id, code3, { redirect_uri: 'http://127.0.0.1:1/x' })).json()).toMatchObject({ error: 'invalid_grant' })

	const good = await codeFor(client_id)
	const res = await exchange(client_id, good)
	expect(res.headers.get('cache-control')).toBe('no-store')
	const tok = await res.json() as { access_token: string, refresh_token: string, expires_in: number, token_type: string }
	expect(tok).toMatchObject({ token_type: 'Bearer', expires_in: 3600 })
	expect(tok.access_token).toMatch(/^atr_oat_/)
	expect(await oauth.caller(`Bearer ${tok.access_token}`)).toMatchObject({ uid: 'agent-a', owner: 'alice', isAgent: true, agentToken: true })
	// Replay: refused, and the token from the first exchange stops working.
	expect(await (await exchange(client_id, good)).json()).toMatchObject({ error: 'invalid_grant' })
	await expect(oauth.caller(`Bearer ${tok.access_token}`)).rejects.toMatchObject({ code: 'auth' })

	const late = await codeFor(client_id)
	t += 11 * 60
	expect(await (await exchange(client_id, late)).json()).toMatchObject({ error: 'invalid_grant' })
})

test('access token: one hour, only for this resource, only while the agent exists', async () => {
	const { client_id } = await register()
	const tok = await (await exchange(client_id, await codeFor(client_id))).json() as { access_token: string }
	expect(OAuth.isAccessToken(`Bearer ${tok.access_token}`)).toBe(true)
	expect(OAuth.isAccessToken('Bearer some-agent-token')).toBe(false)
	await expect(make('https://elsewhere.test').caller(`Bearer ${tok.access_token}`)).rejects.toMatchObject({ code: 'auth' })
	t += 3601
	await expect(oauth.caller(`Bearer ${tok.access_token}`)).rejects.toMatchObject({ code: 'auth' })

	const tok2 = await (await exchange(client_id, await codeFor(client_id))).json() as { access_token: string }
	await oauth.forgetAgent('agent-a')
	await expect(oauth.caller(`Bearer ${tok2.access_token}`)).rejects.toMatchObject({ code: 'auth' })
})

test('an agent of another user cannot be bound; the agent must still exist at exchange', async () => {
	const { client_id } = await register()
	const code = await codeFor(client_id, 'agent-b', 'alice')
	expect(await (await exchange(client_id, code)).json()).toMatchObject({ error: 'invalid_grant' })
})

test('refresh: rotated; an old refresh token revokes the grant', async () => {
	const { client_id } = await register()
	const first = await (await exchange(client_id, await codeFor(client_id))).json() as { access_token: string, refresh_token: string }
	t += 4000
	const r = await post('/agent/oauth/token', { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id })
	const second = await r.json() as { access_token: string, refresh_token: string }
	expect(second.refresh_token).not.toBe(first.refresh_token)
	expect(await oauth.caller(`Bearer ${second.access_token}`)).toMatchObject({ uid: 'agent-a' })
	await expect(oauth.caller(`Bearer ${first.access_token}`)).rejects.toMatchObject({ code: 'auth' })
	const replay = await (await post('/agent/oauth/token', { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id })).json()
	expect(replay).toMatchObject({ error: 'invalid_grant' })
	await expect(oauth.caller(`Bearer ${second.access_token}`)).rejects.toMatchObject({ code: 'auth' })
	expect(await oauth.grants('agent-a')).toEqual([])
	expect(await (await post('/agent/oauth/token', { grant_type: 'password' })).json()).toMatchObject({ error: 'unsupported_grant_type' })
})

test('revocation endpoint, connected apps list and disconnect', async () => {
	const { client_id } = await register()
	const a = await (await exchange(client_id, await codeFor(client_id))).json() as { access_token: string }
	const b = await (await exchange(client_id, await codeFor(client_id))).json() as { access_token: string }
	const apps = await oauth.grants('agent-a')
	expect(apps.map((g) => g.clientName)).toEqual(['Test MCP', 'Test MCP'])
	expect((await post('/agent/oauth/revoke', { token: a.access_token })).status).toBe(200)
	await expect(oauth.caller(`Bearer ${a.access_token}`)).rejects.toMatchObject({ code: 'auth' })
	const [left] = await oauth.grants('agent-a')
	expect(await oauth.revokeGrant('agent-b', left.grantId)).toBe(false)
	expect(await oauth.revokeGrant('agent-a', left.grantId)).toBe(true)
	await expect(oauth.caller(`Bearer ${b.access_token}`)).rejects.toMatchObject({ code: 'auth' })
})

test('client ID metadata documents: fetched once, checked, internal addresses refused', async () => {
	const id = 'https://client.example/oauth/metadata.json'
	docs.set(id, { body: { client_id: id, client_name: 'Example Client', redirect_uris: ['http://127.0.0.1:33418/callback'] } })
	const flow = await flowFor(id)
	expect(await oauth.flow('alice', flow)).toMatchObject({ client_name: 'Example Client', client_kind: 'cimd', client_id: id })
	await flowFor(id)
	expect(fetched).toEqual([id])
	const code = await codeFor(id)
	expect(await (await exchange(id, code)).json()).toMatchObject({ token_type: 'Bearer' })

	const bad = 'https://client.example/oauth/bad.json'
	docs.set(bad, { body: { client_id: 'https://other.example/x.json', redirect_uris: ['http://127.0.0.1:33418/callback'] } })
	expect((await get(authUrl(bad)))!.status).toBe(400)
	const noPath = 'https://client.example'
	expect((await get(authUrl(noPath)))!.status).toBe(400)
	dns = ['10.0.0.5']
	const internal = 'https://intranet.example/meta.json'
	docs.set(internal, { body: { client_id: internal, redirect_uris: ['http://127.0.0.1:33418/callback'] } })
	const r = (await get(authUrl(internal)))!
	expect(r.status).toBe(400)
	expect(await r.text()).toContain('internal address')
	expect(fetched).not.toContain(internal)
})
