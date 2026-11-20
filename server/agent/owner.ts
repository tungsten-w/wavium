// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner side: Settings > Agents and the approvals inbox, under
// /agent/v1/owner/*. Called by the logged-in user (session cookie + the
// OCS-APIRequest header). Account and token work goes to PHP internally.
import {
	type AccessMap, type Action, ACTIONS, dropAgent, getAccess, getSettings, normalizeModes,
	type Preset, presetAccess, setAccess, tokenScopes, updateSettings,
} from './access'
import { type Approvals, view as approvalView } from './approvals'
import type { Journal } from './journal'
import { timeline } from './timeline'
import type { OAuth } from './oauth'
import type { DoorbellTest } from './events'
import type { Auth, Caller, TokenUse } from './auth'
import type { Db } from './db'
import type { PhpCaller } from './phpcall'
import type { Registry } from './tools'
import { AgentError, randomToken } from './util'

/** Server plumbing, not something to hand an agent. */
export const HIDDEN_AREAS = new Set([
	'account', 'core', 'search', 'appstore', 'cloud_federation_api', 'dashboard', 'federatedfilesharing', 'federation',
	'files_external', 'lookup_server_connector', 'sharebymail', 'weather_status', 'webhook_listeners', 'workflowengine',
])

interface AgentRow { uid: string, displayName: string, description: string, owner: string, createdAt: number, enabled: boolean }
interface TokenRow { id: number, name: string, lastActivity: number, agent: boolean }

export class OwnerApi {
	private areasCache: { at: number, areas: Record<string, Action[]> } | null = null

	constructor(private db: Db, private php: PhpCaller, private auth: Auth, private approvals: Approvals, private baseUrl: string, private registry?: Registry, private journal?: Journal, private oauth?: OAuth, private tokenUse?: TokenUse, private webhookTest?: (agent: string) => Promise<DoorbellTest>) {}
	private lastTest = new Map<string, number>()

	/** Agent tools per area (areas without tools still grant the app's own API through token scopes). */
	toolCounts(): Record<string, number> {
		const out: Record<string, number> = {}
		for (const t of this.registry?.all() ?? []) if (t.area) out[t.area] = (out[t.area] ?? 0) + 1
		return out
	}

	async areas(): Promise<Record<string, Action[]>> {
		if (this.areasCache && Date.now() - this.areasCache.at < 300_000) return this.areasCache.areas
		const res = await this.php.ocs<{ areas: Record<string, string[]> }>('GET', 'core/atrium/agent/internal/areas')
		const areas: Record<string, Action[]> = {}
		for (const [area, actions] of Object.entries(res.areas)) {
			if (HIDDEN_AREAS.has(area)) continue
			areas[area] = actions.filter((a): a is Action => (ACTIONS as string[]).includes(a))
		}
		this.areasCache = { at: Date.now(), areas }
		return areas
	}

	private async ownedAgent(owner: Caller, uid: string): Promise<AgentRow> {
		const res = await this.php.ocs<{ agents: AgentRow[] }>('GET', 'core/atrium/agent/internal/agents', { query: { uid } })
		const agent = res.agents[0]
		if (!agent || agent.owner !== owner.uid) throw new AgentError('not_found', `No agent ${uid}`)
		return agent
	}

	private async describe(agent: AgentRow) {
		const [settings, access, tokens, uses] = await Promise.all([
			getSettings(this.db, agent.uid),
			getAccess(this.db, agent.uid, agent.owner),
			this.php.ocs<{ tokens: TokenRow[] }>('GET', `core/atrium/agent/internal/agents/${encodeURIComponent(agent.uid)}/tokens`),
			this.tokenUse ? this.tokenUse.forAgent(agent.uid).catch(() => new Map()) : Promise.resolve(new Map()),
		])
		return {
			...agent,
			paused: settings.paused,
			wakes: settings.wakes,
			webhookUrl: settings.webhookUrl,
			notifyApprovals: settings.notifyApprovals,
			quiet: settings.quiet,
			doorbellError: settings.doorbellError,
			doorbellErrorAt: settings.doorbellErrorAt,
			access,
			tokens: tokens.tokens.filter((t) => t.agent).map((t) => {
				const u = uses.get(t.id)
				return u ? { ...t, lastIp: u.ip, lastUserAgent: u.userAgent, lastActivity: Math.max(t.lastActivity, u.at) } : { ...t, lastIp: null, lastUserAgent: null }
			}),
			connectedApps: this.oauth ? await this.oauth.grants(agent.uid) : [],
		}
	}

	private async syncTokenScopes(uid: string, owner: string): Promise<void> {
		await this.php.ocs('PUT', `core/atrium/agent/internal/agents/${encodeURIComponent(uid)}/scopes`, { body: { scopes: tokenScopes(await getAccess(this.db, uid, owner)) } })
	}

	connectInfo(uid: string, token: string, webhookSecret: string | null) {
		const mcp = `${this.baseUrl}/agent/mcp`
		return {
			mcpUrl: mcp,
			restUrl: `${this.baseUrl}/agent/v1/tools/<tool>`,
			openapiUrl: `${this.baseUrl}/agent/v1/openapi.json`,
			token,
			webhookSecret,
			snippets: {
				claudeCode: `claude mcp add --transport http atrium ${mcp} --header "Authorization: Bearer ${token}"`,
				mcpJson: JSON.stringify({ mcpServers: { atrium: { type: 'http', url: mcp, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
				codex: `[mcp_servers.atrium]\nurl = "${mcp}"\nhttp_headers = { Authorization = "Bearer ${token}" }`,
				curl: `curl -X POST ${this.baseUrl}/agent/v1/tools/agent_whoami -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{}'`,
			},
			agent: uid,
		}
	}

	private async newToken(uid: string, owner: string, name: string) {
		const scopes = tokenScopes(await getAccess(this.db, uid, owner))
		return this.php.ocs<{ id: number, name: string, token: string }>('POST', `core/atrium/agent/internal/agents/${encodeURIComponent(uid)}/tokens`, { body: { name, scopes } })
	}

	private async setAccessMap(uid: string, owner: string, patch: Record<string, unknown>): Promise<void> {
		const areas = await this.areas()
		for (const [area, modes] of Object.entries(patch)) {
			if (!areas[area]) throw new AgentError('invalid_input', `Unknown area ${area}`)
			if (modes === null || modes === false) {
				await setAccess(this.db, uid, owner, area, null)
			} else if (typeof modes === 'object') {
				await setAccess(this.db, uid, owner, area, normalizeModes(modes as Record<string, unknown>, areas[area]))
			} else {
				throw new AgentError('invalid_input', `access.${area}: expected an object of modes or null`)
			}
		}
	}

	async handle(req: Request, path: string, url: URL): Promise<Response> {
		const owner = await this.auth.owner(req)
		const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
		const body = async (): Promise<Record<string, unknown>> => {
			if (req.method === 'GET' || req.method === 'DELETE') return {}
			try {
				const b = await req.json()
				return b && typeof b === 'object' ? b as Record<string, unknown> : {}
			} catch {
				throw new AgentError('invalid_input', 'Body must be JSON')
			}
		}
		const m = req.method
		const [a, b, c, d] = parts

		if (a === 'areas' && m === 'GET') return Response.json({ areas: await this.areas(), tools: this.toolCounts() })

		if (a === 'agents' && !b) {
			if (m === 'GET') {
				const res = await this.php.ocs<{ agents: AgentRow[] }>('GET', 'core/atrium/agent/internal/agents', { query: { owner: owner.uid } })
				return Response.json({ agents: await Promise.all(res.agents.map((x) => this.describe(x))) })
			}
			if (m === 'POST') {
				const input = await body()
				const name = String(input.name ?? '').trim()
				if (!name) throw new AgentError('invalid_input', 'name is required')
				const created = await this.php.ocs<AgentRow>('POST', 'core/atrium/agent/internal/agents', { body: { owner: owner.uid, name, description: String(input.description ?? '') } })
				const preset = input.preset as Preset | undefined
				const access: AccessMap = preset ? presetAccess(preset, await this.areas()) : {}
				for (const [area, modes] of Object.entries(access)) await setAccess(this.db, created.uid, owner.uid, area, modes)
				if (input.access && typeof input.access === 'object') await this.setAccessMap(created.uid, owner.uid, input.access as Record<string, unknown>)
				const settings = await updateSettings(this.db, created.uid, {})
				// token: false = no token now (the agent is being connected through OAuth).
				if (input.token === false) return Response.json({ agent: await this.describe(created), connect: null })
				const token = await this.newToken(created.uid, owner.uid, String(input.tokenName ?? 'default'))
				return Response.json({ agent: await this.describe(created), connect: this.connectInfo(created.uid, token.token, settings.webhookSecret) })
			}
		}

		if (a === 'agents' && b) {
			const agent = await this.ownedAgent(owner, b)
			if (!c) {
				if (m === 'GET') return Response.json(await this.describe(agent))
				if (m === 'PATCH' || m === 'PUT') {
					const input = await body()
					if (input.displayName !== undefined || input.description !== undefined) {
						await this.php.ocs('PUT', `core/atrium/agent/internal/agents/${encodeURIComponent(agent.uid)}`, {
							body: { displayName: input.displayName, description: input.description },
						})
					}
					const patch: Parameters<typeof updateSettings>[2] = {}
					if (typeof input.paused === 'boolean') patch.paused = input.paused
					if (typeof input.wakes === 'boolean') patch.wakes = input.wakes
					if (typeof input.notifyApprovals === 'boolean') patch.notifyApprovals = input.notifyApprovals
					if (input.quiet !== undefined) patch.quiet = input.quiet as never
					if (input.webhookUrl !== undefined) {
						patch.webhookUrl = input.webhookUrl === null ? null : String(input.webhookUrl).trim()
						patch.doorbellError = null
						patch.doorbellErrorAt = null
					}
					await updateSettings(this.db, agent.uid, patch)
					if (input.access && typeof input.access === 'object') {
						await this.setAccessMap(agent.uid, owner.uid, input.access as Record<string, unknown>)
						await this.syncTokenScopes(agent.uid, owner.uid)
					}
					return Response.json(await this.describe(await this.ownedAgent(owner, b)))
				}
				if (m === 'DELETE') {
					await this.php.ocs('DELETE', `core/atrium/agent/internal/agents/${encodeURIComponent(agent.uid)}`)
					await dropAgent(this.db, agent.uid)
					await this.oauth?.forgetAgent(agent.uid)
					this.auth.clear()
					return Response.json({ deleted: true })
				}
			}
			if (c === 'access' && (m === 'PUT' || m === 'PATCH')) {
				const input = await body()
				if (input.preset) {
					const areas = await this.areas()
					for (const area of Object.keys(areas)) await setAccess(this.db, agent.uid, owner.uid, area, null)
					for (const [area, modes] of Object.entries(presetAccess(input.preset as Preset, areas))) await setAccess(this.db, agent.uid, owner.uid, area, modes)
				}
				if (input.areas && typeof input.areas === 'object') await this.setAccessMap(agent.uid, owner.uid, input.areas as Record<string, unknown>)
				await this.syncTokenScopes(agent.uid, owner.uid)
				return Response.json(await this.describe(agent))
			}
			if (c === 'webhook-test' && m === 'POST' && this.webhookTest) {
				// One test at a time per agent: the button is not a way to flood someone's server.
				const last = this.lastTest.get(agent.uid) ?? 0
				if (Date.now() - last < 5000) throw new AgentError('conflict', 'Wait a few seconds before testing again')
				this.lastTest.set(agent.uid, Date.now())
				return Response.json(await this.webhookTest(agent.uid))
			}
			if (c === 'webhook-secret' && m === 'POST') {
				const s = await updateSettings(this.db, agent.uid, { webhookSecret: 'whsec_' + randomToken(24), doorbellError: null, doorbellErrorAt: null })
				return Response.json({ webhookSecret: s.webhookSecret })
			}
			if (c === 'tokens' && !d) {
				if (m === 'GET') return Response.json((await this.describe(agent)).tokens)
				if (m === 'POST') {
					const input = await body()
					const token = await this.newToken(agent.uid, owner.uid, String(input.name ?? 'agent'))
					const s = await getSettings(this.db, agent.uid)
					return Response.json({ id: token.id, name: token.name, connect: this.connectInfo(agent.uid, token.token, s.webhookSecret) })
				}
			}
			if (c === 'oauth' && d && m === 'DELETE' && this.oauth) {
				if (!(await this.oauth.revokeGrant(agent.uid, d))) throw new AgentError('not_found', `No connected app ${d}`)
				return Response.json({ revoked: true })
			}
			if (c === 'tokens' && d && m === 'DELETE') {
				await this.php.ocs('DELETE', `core/atrium/agent/internal/agents/${encodeURIComponent(agent.uid)}/tokens/${Number(d)}`)
				this.auth.clear()
				return Response.json({ revoked: true })
			}
		}

		if (a === 'approvals') {
			if (!b && m === 'GET') {
				const status = url.searchParams.get('status') ?? undefined
				const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200)
				const agent = url.searchParams.get('agent') || undefined
				return Response.json(await this.approvals.list({ grantor: owner.uid, status, agent }, url.searchParams.get('cursor') ?? undefined, limit))
			}
			if (b && !c && m === 'GET') {
				const r = await this.approvals.get(b)
				if (!r || r.grantor_uid !== owner.uid) throw new AgentError('not_found', `No request ${b}`)
				return Response.json(approvalView(r))
			}
			if (b && (c === 'approve' || c === 'reject') && m === 'POST') {
				const input = await body()
				const note = input.note === undefined || input.note === null || input.note === '' ? null : String(input.note).slice(0, 2000)
				return Response.json(c === 'approve' ? await this.approvals.approve(owner.uid, b, note) : await this.approvals.reject(owner.uid, b, note))
			}
		}

		// Agent activity: journal actions + requests, one timeline (timeline.ts).
		if (a === 'activity' && !b && m === 'GET') {
			const limit = Number(url.searchParams.get('limit') ?? 50) || 50
			return Response.json(await timeline(this.db, owner.uid, { agent: url.searchParams.get('agent') || undefined, cursor: url.searchParams.get('cursor') || undefined, limit }))
		}

		// OAuth consent (Settings > Connect an agent, oauth.ts): the flow, then yes for one agent, or no.
		if (a === 'oauth' && b === 'flows' && c && this.oauth) {
			if (!d && m === 'GET') return Response.json(await this.oauth.flow(owner.uid, c))
			if (d === 'approve' && m === 'POST') {
				const input = await body()
				const agent = await this.ownedAgent(owner, String(input.agent ?? ''))
				return Response.json(await this.oauth.approve(owner.uid, c, agent.uid))
			}
			if (d === 'deny' && m === 'POST') return Response.json(await this.oauth.deny(owner.uid, c))
		}

		// Journal of agent actions on the owner's data, and undo (journal.ts).
		if (a === 'actions' && this.journal) {
			if (!b && m === 'GET') {
				const limit = Number(url.searchParams.get('limit') ?? 50) || 50
				return Response.json(await this.journal.list(owner.uid, { agent: url.searchParams.get('agent') ?? undefined, cursor: url.searchParams.get('cursor') ?? undefined, limit }))
			}
			if (b && c === 'undo' && !d && m === 'POST') return Response.json(await this.journal.undo(owner.uid, b))
		}

		throw new AgentError('not_found', `No route ${m} /agent/v1/owner/${parts.join('/')}`)
	}
}
