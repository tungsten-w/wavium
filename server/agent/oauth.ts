// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OAuth 2.1 for MCP (PLAN P2-7), following the MCP authorization spec
// (2025-11-25): an MCP client (Claude, Cursor, ...) gets a token for one of
// the user's agents without copying a token by hand.
//
// - Discovery: protected resource metadata (RFC 9728) for /agent/mcp, and
//   authorization server metadata (RFC 8414). A 401 from /agent/mcp points to
//   the resource metadata in WWW-Authenticate.
// - Clients: Client ID Metadata Documents (an https client_id URL, fetched
//   through the SSRF guard and cached) and Dynamic Client Registration
//   (RFC 7591). Public clients only (no client secret); PKCE S256 required.
// - Consent: /agent/oauth/authorize records the request and sends the browser
//   to Settings > Connect an agent, where the logged-in user picks one of
//   their agents (or creates one) after seeing what it may do. Then the
//   browser goes back to the client's redirect_uri with a one-time code.
// - Tokens: Atrium's own opaque tokens, stored hashed: access tokens live one
//   hour and only work at /agent/mcp (the `resource`, RFC 8707); refresh
//   tokens are rotated at each use and a replayed one revokes the grant. The
//   agent's permissions and approvals apply as with any agent token.
//
// No Nextcloud oauth2 app here: it needs clients registered by an admin and
// issues tokens for the user's whole account, while MCP clients register
// themselves and must only act as one agent.
import type { Db } from './db'
import { num } from './db'
import { assertPublicWebhook, BlockedWebhook, type WebhookPolicy, webhookPolicy } from './netguard'
import { AgentError, nowSec, randomToken, sha256Hex } from './util'

export const ACCESS_TTL = 3600
export const REFRESH_TTL = 30 * 86400
export const CODE_TTL = 600
export const FLOW_TTL = 900
const CIMD_TTL = 3600
const MAX_DOC = 64 * 1024

export interface AgentInfo { uid: string, displayName: string, owner: string }
export type AgentLookup = (uid: string) => Promise<AgentInfo | null>

export interface OAuthCaller { uid: string, displayName: string, isAgent: true, agentToken: true, owner: string, grantId: string }

/** OAuth errors are answered as {error, error_description} (RFC 6749 5.2). */
export class OAuthError extends Error {
	constructor(public error: string, message: string, public status = 400) { super(message) }
	response(): Response {
		return Response.json({ error: this.error, error_description: this.message }, { status: this.status, headers: CORS })
	}
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }

const b64url = (buf: ArrayBuffer | Uint8Array): string => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString('base64url')
export const s256 = (verifier: string): string => b64url(new Bun.CryptoHasher('sha256').update(verifier).digest() as Uint8Array)

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const BAD_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'])

/** https, http on a loopback host, or an app's own scheme (cursor://, vscode://). */
export function validRedirect(uri: string): boolean {
	let u: URL
	try { u = new URL(uri) } catch { return false }
	if (u.hash) return false
	if (u.protocol === 'https:') return true
	if (u.protocol === 'http:') return LOOPBACK.has(u.hostname)
	return !BAD_SCHEMES.has(u.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(u.protocol)
}

/** Exact match; on loopback http the port may differ (RFC 8252 7.3). */
export function redirectMatches(registered: string[], uri: string): boolean {
	if (registered.includes(uri)) return true
	let u: URL
	try { u = new URL(uri) } catch { return false }
	if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname)) return false
	return registered.some((r) => {
		try {
			const x = new URL(r)
			return x.protocol === 'http:' && x.hostname === u.hostname && x.pathname === u.pathname && x.search === u.search
		} catch { return false }
	})
}

export function canonicalResource(s: string): string {
	try {
		const u = new URL(s)
		return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, '')}`
	} catch { return s }
}

interface ClientRow { client_id: string, kind: string, name: string, redirect_uris: string, created_at: unknown, fetched_at: unknown }
interface FlowRow {
	flow_id: string, client_id: string, client_name: string, redirect_uri: string, state: string | null, code_challenge: string,
	resource: string, owner_uid: string | null, agent_uid: string | null, code_hash: string | null, code_expires: unknown, used: unknown, created_at: unknown,
}
interface GrantRow {
	grant_id: string, agent_uid: string, owner_uid: string, client_id: string, client_name: string, resource: string,
	access_hash: string, access_expires: unknown, refresh_hash: string, previous_refresh_hash: string | null, refresh_expires: unknown, created_at: unknown, last_used_at: unknown,
}

export interface Client { client_id: string, kind: 'cimd' | 'dcr', name: string, redirect_uris: string[] }

export interface FlowView {
	flow_id: string
	client_id: string
	client_name: string
	/** Metadata document URL host, or "registered" for a self-registered client. */
	client_kind: 'cimd' | 'dcr'
	redirect_uri: string
	/** What the user should check: where the browser goes back to. */
	redirect_host: string
	/** Only a local address: any program on this computer could claim the name. */
	localhost: boolean
}

export class OAuth {
	private ready: Promise<void> | null = null
	private agentCache = new Map<string, { at: number, info: AgentInfo | null }>()

	constructor(
		private db: Db,
		private baseUrl: string,
		private lookup: AgentLookup,
		private fetcher: typeof fetch = fetch,
		private policy: WebhookPolicy = webhookPolicy(process.env.ATRIUM_OAUTH_FETCH_ALLOW),
		private now: () => number = nowSec,
	) {}

	get resource(): string { return canonicalResource(`${this.baseUrl}/agent/mcp`) }
	get resourceMetadataUrl(): string { return `${this.baseUrl}/.well-known/oauth-protected-resource/agent/mcp` }
	/** WWW-Authenticate for a 401 at /agent/mcp. */
	get challenge(): string { return `Bearer realm="atrium", resource_metadata="${this.resourceMetadataUrl}"` }

	private migrate(): Promise<void> {
		this.ready ??= (async () => {
			const T = this.db.t
			await this.db.q(`CREATE TABLE IF NOT EXISTS ${T('atrium_agent_oauth_clients')} (
				client_id VARCHAR(512) PRIMARY KEY, kind VARCHAR(8) NOT NULL, name VARCHAR(200) NOT NULL,
				redirect_uris TEXT NOT NULL, created_at BIGINT NOT NULL, fetched_at BIGINT NOT NULL)`)
			await this.db.q(`CREATE TABLE IF NOT EXISTS ${T('atrium_agent_oauth_flows')} (
				flow_id VARCHAR(64) PRIMARY KEY, client_id VARCHAR(512) NOT NULL, client_name VARCHAR(200) NOT NULL,
				redirect_uri TEXT NOT NULL, state TEXT, code_challenge VARCHAR(128) NOT NULL, resource TEXT NOT NULL,
				owner_uid VARCHAR(64), agent_uid VARCHAR(64), code_hash VARCHAR(64), code_expires BIGINT, used SMALLINT NOT NULL DEFAULT 0,
				created_at BIGINT NOT NULL)`)
			await this.db.q(`CREATE UNIQUE INDEX IF NOT EXISTS ${T('atrium_agent_oauth_flows_code')} ON ${T('atrium_agent_oauth_flows')} (code_hash)`)
			await this.db.q(`CREATE TABLE IF NOT EXISTS ${T('atrium_agent_oauth_grants')} (
				grant_id VARCHAR(64) PRIMARY KEY, agent_uid VARCHAR(64) NOT NULL, owner_uid VARCHAR(64) NOT NULL,
				client_id VARCHAR(512) NOT NULL, client_name VARCHAR(200) NOT NULL, resource TEXT NOT NULL,
				access_hash VARCHAR(64) NOT NULL, access_expires BIGINT NOT NULL,
				refresh_hash VARCHAR(64) NOT NULL, previous_refresh_hash VARCHAR(64), refresh_expires BIGINT NOT NULL,
				created_at BIGINT NOT NULL, last_used_at BIGINT NOT NULL)`)
			await this.db.q(`CREATE UNIQUE INDEX IF NOT EXISTS ${T('atrium_agent_oauth_grants_access')} ON ${T('atrium_agent_oauth_grants')} (access_hash)`)
			await this.db.q(`CREATE UNIQUE INDEX IF NOT EXISTS ${T('atrium_agent_oauth_grants_refresh')} ON ${T('atrium_agent_oauth_grants')} (refresh_hash)`)
			await this.db.q(`CREATE INDEX IF NOT EXISTS ${T('atrium_agent_oauth_grants_agent')} ON ${T('atrium_agent_oauth_grants')} (agent_uid)`)
		})().catch((e) => { this.ready = null; throw e })
		return this.ready
	}

	// --- Discovery -------------------------------------------------------

	resourceMetadata() {
		return {
			resource: this.resource,
			authorization_servers: [this.baseUrl],
			bearer_methods_supported: ['header'],
			resource_name: 'Atrium agents (MCP)',
			resource_documentation: `${this.baseUrl}/settings/user/agents`,
		}
	}

	serverMetadata() {
		const b = this.baseUrl
		return {
			issuer: b,
			authorization_endpoint: `${b}/agent/oauth/authorize`,
			token_endpoint: `${b}/agent/oauth/token`,
			registration_endpoint: `${b}/agent/oauth/register`,
			revocation_endpoint: `${b}/agent/oauth/revoke`,
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none'],
			revocation_endpoint_auth_methods_supported: ['none'],
			client_id_metadata_document_supported: true,
		}
	}

	// --- Clients ---------------------------------------------------------

	/** RFC 7591: public clients only. */
	async register(body: unknown): Promise<Response> {
		await this.migrate()
		const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
		const uris = b.redirect_uris
		if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === 'string' && u.length <= 2000 && validRedirect(u))) {
			throw new OAuthError('invalid_redirect_uri', 'redirect_uris: 1 to 10 URIs, https, http://localhost or an app scheme')
		}
		if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') {
			throw new OAuthError('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported')
		}
		const name = typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim().slice(0, 200) : 'MCP client'
		// Unused registrations do not pile up.
		await this.db.q(`DELETE FROM ${this.db.t('atrium_agent_oauth_clients')} WHERE kind = 'dcr' AND fetched_at < $1
			AND client_id NOT IN (SELECT client_id FROM ${this.db.t('atrium_agent_oauth_grants')})`, [this.now() - 30 * 86400])
		const id = 'atr_cli_' + randomToken(18)
		const t = this.now()
		await this.db.q(`INSERT INTO ${this.db.t('atrium_agent_oauth_clients')} (client_id, kind, name, redirect_uris, created_at, fetched_at) VALUES ($1, $2, $3, $4, $5, $6)`,
			[id, 'dcr', name, JSON.stringify(uris), t, t])
		return Response.json({
			client_id: id, client_id_issued_at: t, client_name: name, redirect_uris: uris,
			token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
		}, { status: 201, headers: CORS })
	}

	/** A registered client, or a metadata document fetched (and cached) for an https client_id. */
	async client(clientId: string): Promise<Client> {
		await this.migrate()
		const [row] = await this.db.q<ClientRow>(`SELECT * FROM ${this.db.t('atrium_agent_oauth_clients')} WHERE client_id = $1`, [clientId])
		if (row && (row.kind === 'dcr' || num(row.fetched_at) > this.now() - CIMD_TTL)) {
			return { client_id: row.client_id, kind: row.kind as Client['kind'], name: row.name, redirect_uris: JSON.parse(row.redirect_uris) }
		}
		if (!clientId.startsWith('https://')) throw new OAuthError('invalid_client', 'Unknown client_id')
		const doc = await this.fetchDocument(clientId)
		const t = this.now()
		await this.db.q(`INSERT INTO ${this.db.t('atrium_agent_oauth_clients')} (client_id, kind, name, redirect_uris, created_at, fetched_at) VALUES ($1, 'cimd', $2, $3, $4, $4)
			ON CONFLICT (client_id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris, fetched_at = excluded.fetched_at`,
		[clientId, doc.name, JSON.stringify(doc.redirect_uris), t])
		return { client_id: clientId, kind: 'cimd', ...doc }
	}

	private async fetchDocument(url: string): Promise<{ name: string, redirect_uris: string[] }> {
		let u: URL
		try { u = new URL(url) } catch { throw new OAuthError('invalid_client', 'client_id is not a URL') }
		if (u.protocol !== 'https:' || u.pathname === '/' || u.hash || u.username || u.password) throw new OAuthError('invalid_client', 'client_id must be an https URL with a path')
		try {
			await assertPublicWebhook(url, this.policy)
		} catch (e) {
			if (e instanceof BlockedWebhook) throw new OAuthError('invalid_client', 'The client metadata URL points to an internal address')
			throw new OAuthError('invalid_client', 'The client metadata URL does not resolve')
		}
		let res: Response
		try {
			res = await this.fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } })
		} catch {
			throw new OAuthError('invalid_client', 'Could not fetch the client metadata document')
		}
		if (!res.ok) throw new OAuthError('invalid_client', `Client metadata document: HTTP ${res.status}`)
		const text = await res.text()
		if (text.length > MAX_DOC) throw new OAuthError('invalid_client', 'Client metadata document too large')
		let doc: Record<string, unknown>
		try { doc = JSON.parse(text) } catch { throw new OAuthError('invalid_client', 'Client metadata document is not JSON') }
		if (!doc || typeof doc !== 'object' || doc.client_id !== url) throw new OAuthError('invalid_client', 'client_id in the document does not match its URL')
		const uris = doc.redirect_uris
		if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((x) => typeof x === 'string' && validRedirect(x))) {
			throw new OAuthError('invalid_client', 'Client metadata document: bad redirect_uris')
		}
		if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'none') {
			throw new OAuthError('invalid_client', 'Only public clients (token_endpoint_auth_method "none") are supported')
		}
		const name = typeof doc.client_name === 'string' && doc.client_name.trim() ? doc.client_name.trim().slice(0, 200) : u.host
		return { name, redirect_uris: uris as string[] }
	}

	// --- Authorization ---------------------------------------------------

	/**
	 * GET /agent/oauth/authorize. Errors before the redirect_uri is known to be
	 * the client's are shown as a page (never redirect to an unchecked URI);
	 * later errors go back to the client.
	 */
	async authorize(url: URL): Promise<Response> {
		await this.migrate()
		const p = url.searchParams
		const clientId = p.get('client_id') ?? ''
		const redirectUri = p.get('redirect_uri') ?? ''
		let client: Client
		try {
			client = await this.client(clientId)
		} catch (e) {
			return page(400, 'This app cannot connect', e instanceof OAuthError ? e.message : 'Unknown client')
		}
		const redirect = redirectUri || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : '')
		if (!redirect || !redirectMatches(client.redirect_uris, redirect)) return page(400, 'This app cannot connect', 'The redirect_uri is not one the app registered')
		const back = (error: string, description: string) => {
			const to = new URL(redirect)
			to.searchParams.set('error', error)
			to.searchParams.set('error_description', description)
			if (p.get('state') !== null) to.searchParams.set('state', p.get('state')!)
			to.searchParams.set('iss', this.baseUrl)
			return new Response(null, { status: 302, headers: { Location: to.toString() } })
		}
		if (p.get('response_type') !== 'code') return back('unsupported_response_type', 'Only response_type=code')
		const challenge = p.get('code_challenge') ?? ''
		if (p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return back('invalid_request', 'PKCE with code_challenge_method=S256 is required')
		const resource = p.get('resource')
		if (resource !== null && canonicalResource(resource) !== this.resource) return back('invalid_target', `This server only issues tokens for ${this.resource}`)
		const flowId = 'atr_flow_' + randomToken(18)
		await this.db.q(`DELETE FROM ${this.db.t('atrium_agent_oauth_flows')} WHERE created_at < $1`, [this.now() - FLOW_TTL - CODE_TTL])
		await this.db.q(`INSERT INTO ${this.db.t('atrium_agent_oauth_flows')} (flow_id, client_id, client_name, redirect_uri, state, code_challenge, resource, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [flowId, client.client_id, client.name, redirect, p.get('state'), challenge, this.resource, this.now()])
		return new Response(null, { status: 302, headers: { Location: `${this.baseUrl}/settings/user/agent-connect?flow=${flowId}` } })
	}

	private async openFlow(owner: string, flowId: string): Promise<FlowRow> {
		await this.migrate()
		const [f] = await this.db.q<FlowRow>(`SELECT * FROM ${this.db.t('atrium_agent_oauth_flows')} WHERE flow_id = $1`, [flowId])
		if (!f || num(f.created_at) < this.now() - FLOW_TTL || (f.owner_uid !== null && f.owner_uid !== owner)) {
			throw new AgentError('not_found', 'This connection request expired. Start again from the app.')
		}
		if (f.code_hash !== null || num(f.used)) throw new AgentError('conflict', 'This connection request was already answered')
		return f
	}

	/** The consent screen's data. The first user who opens it owns the request. */
	async flow(owner: string, flowId: string): Promise<FlowView> {
		const f = await this.openFlow(owner, flowId)
		if (f.owner_uid === null) {
			await this.db.q(`UPDATE ${this.db.t('atrium_agent_oauth_flows')} SET owner_uid = $1 WHERE flow_id = $2 AND owner_uid IS NULL`, [owner, flowId])
		}
		const [client] = await this.db.q<ClientRow>(`SELECT kind FROM ${this.db.t('atrium_agent_oauth_clients')} WHERE client_id = $1`, [f.client_id])
		const r = new URL(f.redirect_uri)
		return {
			flow_id: f.flow_id, client_id: f.client_id, client_name: f.client_name, client_kind: (client?.kind ?? 'dcr') as FlowView['client_kind'],
			redirect_uri: f.redirect_uri, redirect_host: r.protocol === 'http:' || r.protocol === 'https:' ? r.host : r.protocol.replace(/:$/, ''),
			localhost: r.protocol === 'http:' && LOOPBACK.has(r.hostname),
		}
	}

	/** The user said yes for one of their agents (checked by the caller): a one-time code back to the app. */
	async approve(owner: string, flowId: string, agentUid: string): Promise<{ redirect: string }> {
		const f = await this.openFlow(owner, flowId)
		const code = 'atr_oac_' + randomToken(32)
		const done = await this.db.q(`UPDATE ${this.db.t('atrium_agent_oauth_flows')} SET owner_uid = $1, agent_uid = $2, code_hash = $3, code_expires = $4
			WHERE flow_id = $5 AND code_hash IS NULL RETURNING flow_id`, [owner, agentUid, sha256Hex(code), this.now() + CODE_TTL, flowId])
		if (!done.length) throw new AgentError('conflict', 'This connection request was already answered')
		const to = new URL(f.redirect_uri)
		to.searchParams.set('code', code)
		if (f.state !== null) to.searchParams.set('state', f.state)
		to.searchParams.set('iss', this.baseUrl)
		return { redirect: to.toString() }
	}

	async deny(owner: string, flowId: string): Promise<{ redirect: string }> {
		const f = await this.openFlow(owner, flowId)
		await this.db.q(`UPDATE ${this.db.t('atrium_agent_oauth_flows')} SET used = 1, owner_uid = $1 WHERE flow_id = $2`, [owner, flowId])
		const to = new URL(f.redirect_uri)
		to.searchParams.set('error', 'access_denied')
		to.searchParams.set('error_description', 'The user did not allow the connection')
		if (f.state !== null) to.searchParams.set('state', f.state)
		to.searchParams.set('iss', this.baseUrl)
		return { redirect: to.toString() }
	}

	// --- Tokens ----------------------------------------------------------

	/** POST /agent/oauth/token (form or JSON body). */
	async token(params: URLSearchParams): Promise<Response> {
		await this.migrate()
		const grant = params.get('grant_type')
		const out = grant === 'authorization_code' ? await this.fromCode(params)
			: grant === 'refresh_token' ? await this.fromRefresh(params)
			: (() => { throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token') })()
		return Response.json(out, { headers: { ...CORS, 'Cache-Control': 'no-store', Pragma: 'no-cache' } })
	}

	private async fromCode(p: URLSearchParams) {
		const code = p.get('code') ?? ''
		const verifier = p.get('code_verifier') ?? ''
		const F = this.db.t('atrium_agent_oauth_flows')
		const [f] = await this.db.q<FlowRow>(`SELECT * FROM ${F} WHERE code_hash = $1`, [sha256Hex(code)])
		if (!f) throw new OAuthError('invalid_grant', 'Unknown or expired code')
		// Single use: a second try with the same code revokes what the first one got.
		const claimed = await this.db.q(`UPDATE ${F} SET used = 1 WHERE flow_id = $1 AND used = 0 RETURNING flow_id`, [f.flow_id])
		if (!claimed.length) {
			await this.db.q(`DELETE FROM ${this.db.t('atrium_agent_oauth_grants')} WHERE grant_id = $1`, [`grant_${f.flow_id}`])
			throw new OAuthError('invalid_grant', 'This code was already used')
		}
		if (num(f.code_expires) < this.now()) throw new OAuthError('invalid_grant', 'Unknown or expired code')
		if (p.get('client_id') !== f.client_id) throw new OAuthError('invalid_grant', 'The code was issued to another client')
		if ((p.get('redirect_uri') ?? f.redirect_uri) !== f.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request')
		if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || s256(verifier) !== f.code_challenge) throw new OAuthError('invalid_grant', 'PKCE verification failed')
		const resource = p.get('resource')
		if (resource !== null && canonicalResource(resource) !== f.resource) throw new OAuthError('invalid_target', `Tokens are only for ${this.resource}`)
		const agent = await this.agent(f.agent_uid ?? '')
		if (!agent || agent.owner !== f.owner_uid) throw new OAuthError('invalid_grant', 'The agent no longer exists')
		const [client] = await this.db.q<ClientRow>(`SELECT name FROM ${this.db.t('atrium_agent_oauth_clients')} WHERE client_id = $1`, [f.client_id])
		const access = 'atr_oat_' + randomToken(32)
		const refresh = 'atr_ort_' + randomToken(32)
		const t = this.now()
		await this.db.q(`INSERT INTO ${this.db.t('atrium_agent_oauth_grants')} (grant_id, agent_uid, owner_uid, client_id, client_name, resource, access_hash, access_expires, refresh_hash, refresh_expires, created_at, last_used_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
		[`grant_${f.flow_id}`, agent.uid, agent.owner, f.client_id, client?.name ?? f.client_name, f.resource, sha256Hex(access), t + ACCESS_TTL, sha256Hex(refresh), t + REFRESH_TTL, t])
		return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh }
	}

	private async fromRefresh(p: URLSearchParams) {
		const token = p.get('refresh_token') ?? ''
		const h = sha256Hex(token)
		const G = this.db.t('atrium_agent_oauth_grants')
		const [g] = await this.db.q<GrantRow>(`SELECT * FROM ${G} WHERE refresh_hash = $1`, [h])
		if (!g) {
			// A refresh token already rotated away: someone kept a copy. Revoke the grant.
			const replay = await this.db.q<{ grant_id: string }>(`DELETE FROM ${G} WHERE previous_refresh_hash = $1 RETURNING grant_id`, [h])
			throw new OAuthError('invalid_grant', replay.length ? 'Refresh token reused: the connection was revoked' : 'Unknown refresh token')
		}
		if (num(g.refresh_expires) < this.now()) throw new OAuthError('invalid_grant', 'Refresh token expired')
		if (p.get('client_id') !== g.client_id) throw new OAuthError('invalid_grant', 'The token was issued to another client')
		const resource = p.get('resource')
		if (resource !== null && canonicalResource(resource) !== g.resource) throw new OAuthError('invalid_target', `Tokens are only for ${this.resource}`)
		const agent = await this.agent(g.agent_uid)
		if (!agent || agent.owner !== g.owner_uid) {
			await this.db.q(`DELETE FROM ${G} WHERE grant_id = $1`, [g.grant_id])
			throw new OAuthError('invalid_grant', 'The agent no longer exists')
		}
		const access = 'atr_oat_' + randomToken(32)
		const refresh = 'atr_ort_' + randomToken(32)
		const t = this.now()
		const rotated = await this.db.q(`UPDATE ${G} SET access_hash = $1, access_expires = $2, refresh_hash = $3, previous_refresh_hash = $4, refresh_expires = $5, last_used_at = $6
			WHERE grant_id = $7 AND refresh_hash = $4 RETURNING grant_id`, [sha256Hex(access), t + ACCESS_TTL, sha256Hex(refresh), h, t + REFRESH_TTL, t, g.grant_id])
		if (!rotated.length) throw new OAuthError('invalid_grant', 'Refresh token already used')
		return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh }
	}

	/** RFC 7009: always 200; an access or refresh token ends its whole grant. */
	async revoke(params: URLSearchParams): Promise<Response> {
		await this.migrate()
		const h = sha256Hex(params.get('token') ?? '')
		await this.db.q(`DELETE FROM ${this.db.t('atrium_agent_oauth_grants')} WHERE access_hash = $1 OR refresh_hash = $1`, [h])
		return new Response(null, { status: 200, headers: CORS })
	}

	/** Is this an Atrium OAuth access token (as opposed to an agent token from Settings)? */
	static isAccessToken(authz: string | null): boolean {
		return !!authz && /^Bearer\s+atr_oat_/i.test(authz)
	}

	/** The agent behind an access token used at the MCP endpoint. */
	async caller(authz: string): Promise<OAuthCaller> {
		await this.migrate()
		const token = authz.replace(/^Bearer\s+/i, '')
		const [g] = await this.db.q<GrantRow>(`SELECT * FROM ${this.db.t('atrium_agent_oauth_grants')} WHERE access_hash = $1`, [sha256Hex(token)])
		if (!g || num(g.access_expires) < this.now()) throw new AgentError('auth', 'Invalid or expired access token')
		if (g.resource !== this.resource) throw new AgentError('auth', 'This token is for another resource')
		const agent = await this.agent(g.agent_uid)
		if (!agent || agent.owner !== g.owner_uid) throw new AgentError('auth', 'The agent no longer exists')
		if (num(g.last_used_at) < this.now() - 60) {
			await this.db.q(`UPDATE ${this.db.t('atrium_agent_oauth_grants')} SET last_used_at = $1 WHERE grant_id = $2`, [this.now(), g.grant_id])
		}
		return { uid: agent.uid, displayName: agent.displayName, isAgent: true, agentToken: true, owner: agent.owner, grantId: g.grant_id }
	}

	private async agent(uid: string): Promise<AgentInfo | null> {
		const hit = this.agentCache.get(uid)
		if (hit && Date.now() - hit.at < 30_000) return hit.info
		const info = uid ? await this.lookup(uid) : null
		if (this.agentCache.size > 500) this.agentCache.clear()
		this.agentCache.set(uid, { at: Date.now(), info })
		return info
	}

	/** Forget an agent (deleted): its grants go and its cached info too. */
	async forgetAgent(uid: string): Promise<void> {
		await this.migrate()
		this.agentCache.delete(uid)
		await this.db.q(`DELETE FROM ${this.db.t('atrium_agent_oauth_grants')} WHERE agent_uid = $1`, [uid])
	}

	// --- Owner: connected apps -------------------------------------------

	async grants(agentUid: string) {
		await this.migrate()
		const rows = await this.db.q<GrantRow>(`SELECT * FROM ${this.db.t('atrium_agent_oauth_grants')} WHERE agent_uid = $1 ORDER BY created_at DESC`, [agentUid])
		return rows.map((g) => ({ grantId: g.grant_id, clientName: g.client_name, clientId: g.client_id, createdAt: num(g.created_at), lastUsedAt: num(g.last_used_at) }))
	}

	async revokeGrant(agentUid: string, grantId: string): Promise<boolean> {
		await this.migrate()
		const r = await this.db.q(`DELETE FROM ${this.db.t('atrium_agent_oauth_grants')} WHERE agent_uid = $1 AND grant_id = $2 RETURNING grant_id`, [agentUid, grantId])
		return r.length > 0
	}

	// --- HTTP ------------------------------------------------------------

	/** Public OAuth endpoints (no session): discovery, register, authorize, token, revoke. Null = not ours. */
	async handle(req: Request, url: URL, pathname: string): Promise<Response | null> {
		const m = req.method
		const wk = /^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server)(\/.*)?$/.exec(pathname)
		if (!wk && !pathname.startsWith('/agent/oauth/')) return null
		if (m === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
		try {
			if (wk) {
				if (m !== 'GET' && m !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET', ...CORS } })
				const suffix = wk[2] ?? ''
				if (wk[1] === 'oauth-protected-resource') {
					if (suffix !== '' && suffix !== '/agent/mcp') return null
					return Response.json(this.resourceMetadata(), { headers: CORS })
				}
				if (suffix !== '') return null
				return Response.json(this.serverMetadata(), { headers: CORS })
			}
			if (pathname === '/agent/oauth/authorize' && m === 'GET') return await this.authorize(url)
			if (pathname === '/agent/oauth/register' && m === 'POST') {
				let body: unknown
				try { body = await req.json() } catch { throw new OAuthError('invalid_client_metadata', 'Body must be JSON') }
				return await this.register(body)
			}
			if ((pathname === '/agent/oauth/token' || pathname === '/agent/oauth/revoke') && m === 'POST') {
				const params = await formParams(req)
				return pathname.endsWith('/token') ? await this.token(params) : await this.revoke(params)
			}
			return null
		} catch (e) {
			if (e instanceof OAuthError) return e.response()
			throw e
		}
	}
}

async function formParams(req: Request): Promise<URLSearchParams> {
	const type = req.headers.get('content-type') ?? ''
	const text = await req.text()
	if (type.includes('application/json')) {
		try {
			const o = JSON.parse(text) as Record<string, unknown>
			return new URLSearchParams(Object.entries(o).filter(([, v]) => typeof v === 'string') as Array<[string, string]>)
		} catch {
			throw new OAuthError('invalid_request', 'Body must be form-encoded or JSON')
		}
	}
	return new URLSearchParams(text)
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function page(status: number, title: string, message: string): Response {
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#1d1b20}h1{font-size:22px}p{color:#49454f}</style></head>
<body><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/settings/user/agents">Settings &gt; Agents</a></p></body></html>`
	return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}
