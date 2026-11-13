// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The agent layer (ADR 0009), mounted by server/index.ts on /agent:
//   POST /agent/mcp                     MCP (Streamable HTTP, JSON)
//   POST /agent/v1/tools/<name>         REST, body = tool input, bare JSON back
//   GET  /agent/v1/openapi.json         REST description
//   *    /agent/v1/owner/...            Settings > Agents and approvals (owner session)
//   + routes of app modules (mail uploads and attachment downloads)
import type { PhpTarget } from '../php'
import { grantorsFor, modeOf } from './access'
import { Approvals } from './approvals'
import { Auth, authFingerprint, type Caller } from './auth'
import type { WebhookPolicy } from './netguard'
import { baseTools } from './base-tools'
import { loadNcConfig, type NcConfig } from './config'
import { connect, type Db, migrate } from './db'
import { EventLog, type Notifier } from './events'
import { handleMcp } from './mcp'
import { ntfyNotifier } from './notify'
import { openapi } from './openapi'
import { OwnerApi } from './owner'
import { phpCaller, type PhpCaller } from './phpcall'
import { type AgentIdentity, buildCtx, callTool, Registry, type Tool, type ToolCtx } from './tools'
import { AgentError, errorResponse } from './util'

export interface AgentLayer {
	handle(req: Request, url: URL, pathname: string, remote: string): Promise<Response>
	stop(): Promise<void>
}

/** Shared state handed to app modules (mail, ...). */
export interface LayerCore {
	db: Db
	php: PhpCaller
	cfg: NcConfig
	auth: Auth
	approvals: Approvals
	events: EventLog
	notifier: Notifier | null
	registry: Registry
	baseCtx(agent: AgentIdentity): Omit<ToolCtx, 'grantor' | 'access'>
	/** Authenticated agent + context for one grantor, with a read check on an area. */
	agentCtx(req: Request, area: string, grantor?: string): Promise<ToolCtx>
}

export interface AgentModule {
	tools(core: LayerCore): Tool[]
	/** Extra routes under /agent/v1/<prefix>; return null when not handled. */
	route?(core: LayerCore, req: Request, url: URL, path: string): Promise<Response | null>
	start?(core: LayerCore): void
	stop?(): void
}

const identity = (c: Caller): AgentIdentity => ({ uid: c.uid, displayName: c.displayName, owner: c.owner })

export async function createLayer(opts: { cfg: NcConfig, db: Db, php: PhpCaller, notifier?: Notifier | null, modules?: AgentModule[], fetcher?: typeof fetch, webhookPolicy?: WebhookPolicy }): Promise<AgentLayer & { core: LayerCore }> {
	const { cfg, db, php } = opts
	await migrate(db)
	const notifier = opts.notifier ?? null
	const auth = new Auth(php, () => authFingerprint(db))
	const approvals = new Approvals(db, notifier, `${cfg.baseUrl}/settings/user/agents`)
	const events = new EventLog(db, notifier, opts.fetcher, opts.webhookPolicy)
	const registry = new Registry()
	const modules = opts.modules ?? []

	const core: LayerCore = {
		db, php, cfg, auth, approvals, events, notifier, registry,
		baseCtx: (agent) => ({ db, php, agent, baseUrl: cfg.baseUrl, approvals }),
		async agentCtx(req, area, grantor) {
			const caller = await auth.agent(req)
			const ctx = await buildCtx(core.baseCtx(identity(caller)), grantor)
			if (modeOf(ctx.access[area], 'read') !== 'allowed') throw new AgentError('forbidden', `No access to ${area} for ${ctx.grantor}`)
			return ctx
		},
	}

	registry.add(...baseTools(approvals))
	for (const m of modules) registry.add(...m.tools(core))
	approvals.registry = registry
	approvals.ctxFor = async (agentUid, grantor) => {
		const res = await php.ocs<{ agents: Array<{ uid: string, displayName: string, owner: string }> }>('GET', 'core/atrium/agent/internal/agents', { query: { uid: agentUid } })
		const a = res.agents[0]
		if (!a) throw new AgentError('not_found', `Agent ${agentUid} no longer exists`)
		return buildCtx(core.baseCtx({ uid: a.uid, displayName: a.displayName, owner: a.owner }), grantor)
	}
	const owner = new OwnerApi(db, php, auth, approvals, cfg.baseUrl, registry)

	async function visibleTools(caller: Caller): Promise<Tool[]> {
		const readable = new Set<string>()
		for (const access of (await grantorsFor(db, caller.uid)).values()) {
			for (const [area, modes] of Object.entries(access)) if (modeOf(modes, 'read') === 'allowed') readable.add(area)
		}
		return registry.visible(readable)
	}

	async function route(req: Request, url: URL, pathname: string): Promise<Response> {
		if (pathname === '/agent/mcp') {
			if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
			const caller = await auth.agent(req)
			return handleMcp(req, {
				list: () => visibleTools(caller),
				call: (name, input) => callTool(registry, core.baseCtx(identity(caller)), name, input),
			})
		}
		if (pathname === '/agent/v1/openapi.json' && req.method === 'GET') {
			return Response.json(openapi(registry.all(), cfg.baseUrl))
		}
		const tool = /^\/agent\/v1\/tools\/([A-Za-z0-9_.]+)$/.exec(pathname)
		if (tool) {
			if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
			const caller = await auth.agent(req)
			let input: unknown = {}
			const text = await req.text()
			if (text.trim() !== '') {
				try { input = JSON.parse(text) } catch { throw new AgentError('invalid_input', 'Body must be JSON') }
			}
			return Response.json(await callTool(registry, core.baseCtx(identity(caller)), tool[1], input))
		}
		if (pathname.startsWith('/agent/v1/owner/')) {
			return owner.handle(req, pathname.slice('/agent/v1/owner/'.length), url)
		}
		for (const m of modules) {
			const res = await m.route?.(core, req, url, pathname)
			if (res) return res
		}
		throw new AgentError('not_found', `No route ${pathname}`)
	}

	events.start()
	const expiry = setInterval(() => { void approvals.expireOld().catch((e) => console.error(`agent approvals: ${(e as Error).message}`)) }, 600_000)
	for (const m of modules) m.start?.(core)

	return {
		core,
		async handle(req, url, pathname) {
			try {
				const res = await route(req, url, pathname)
				res.headers.set('Cache-Control', 'no-store')
				return res
			} catch (e) {
				if (e instanceof AgentError) {
					const res = errorResponse(e)
					if (e.code === 'auth') res.headers.set('WWW-Authenticate', 'Bearer realm="atrium"')
					return res
				}
				console.error(`agent ${req.method} ${pathname}:`, e)
				return errorResponse(new AgentError('unavailable', 'Internal error'))
			}
		},
		async stop() {
			events.stop()
			clearInterval(expiry)
			for (const m of modules) m.stop?.()
			await db.close()
		},
	}
}

export async function startAgentLayer(opts: { docroot: string, php: PhpTarget }): Promise<AgentLayer> {
	const cfg = await loadNcConfig(opts.docroot)
	if (!cfg.secret) throw new Error('config.php has no secret')
	const db = connect(cfg)
	const php = phpCaller(opts.php, cfg.secret, cfg.baseUrl)
	const { mailModule } = await import('./mail')
	const { filesModule } = await import('./files')
	const layer = await createLayer({
		cfg, db, php,
		notifier: ntfyNotifier(process.env.ATRIUM_NTFY_URL, process.env.ATRIUM_NTFY_TOKEN),
		modules: [mailModule(), filesModule()],
	})
	console.log(`agent layer: ${cfg.dbtype} ${cfg.baseUrl}/agent/mcp`)
	return layer
}
