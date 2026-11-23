// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > AI routes (PLAN P2-2), under /agent/v1/ai/*, for the logged-in
// user (same auth as the owner API: session cookie + OCS-APIRequest on writes).
//
//   GET    settings                       providers (instance + mine), kinds, defaults
//   POST   providers                      add {scope, label, kind, baseUrl, apiKey, defaultModel, models}
//   PATCH  providers/<id>                 edit (apiKey: string sets, null removes, absent keeps)
//   DELETE providers/<id>
//   POST   test                           test a draft or a saved provider ({id, ...changes})
//   PUT    default                        {provider: id | null, scope?: 'user' | 'instance'}
//   PUT    admin                          {personalProviders: boolean} (admins)
//
// Plus POST /agent/v1/internal/ai/triage for Mail's TriageService (P2-4,
// internal only, see ./triage.ts).
//
// Keys go in, never out. The settings store lives in server/ai/settings.ts.
import { timingSafeEqual } from 'node:crypto'
import { Budget } from '../ai/budget'
import { resolveRoute, withModel } from '../ai/routing'
import { AiSettings, AiSettingsError, type AiCaller } from '../ai/settings'
import { handleTriage, TRIAGE_PATH } from '../ai/triage-route'
import type { AiProvider } from '../ai/types'
import { SqlUsageStore } from '../ai/usage-store'
import { Corrections } from './mailcorrect'
import type { AgentModule, LayerCore } from './index'
import { internalHeaderValue } from './phpcall'
import { AgentError } from './util'

/** X-Atrium-Internal check for calls from PHP (same HMAC as Bun -> PHP calls). */
export function internalCheck(secret: string): (req: Request) => boolean {
	const want = Buffer.from(internalHeaderValue(secret))
	return (req) => {
		const given = Buffer.from(req.headers.get('x-atrium-internal') ?? '')
		return secret !== '' && given.length === want.length && timingSafeEqual(given, want)
	}
}

export interface AiModule extends AgentModule {
	/** The settings store, once the layer started (for features: triage, summaries...). */
	settings(): AiSettings | null
	/** Usage and caps of every AI call made by Atrium itself (P2-3). */
	budget(): Budget | null
	/**
	 * For features in other modules (digest, ...): `uid`'s provider for `task`,
	 * model chosen (P2-5), behind the budget (P2-3). Null when they have no AI
	 * or no model fits. Only once the layer started.
	 */
	forTask(uid: string, task: string): Promise<AiProvider | null>
}

export type { AiProvider }
/** Sealing with the instance secret, for other modules' secrets (Messages pairing sessions). */
export { keyCipher, type KeyCipher } from '../ai/settings'

export function aiModule(make?: (core: LayerCore) => AiSettings, makeBudget?: (core: LayerCore) => Budget): AiModule {
	let corrections: Corrections | null = null
	let store: AiSettings | null = null
	let budget: Budget | null = null
	const get = (core: LayerCore) => (store ??= make ? make(core) : new AiSettings(core.db, core.cfg.secret))
	// No caps or prices are configured yet (the budget page is still to come):
	// usage is recorded and error pauses apply; Mail keeps its own € caps.
	const getBudget = (core: LayerCore) => (budget ??= makeBudget ? makeBudget(core) : new Budget(new SqlUsageStore(core.db), () => ({})))

	async function caller(core: LayerCore, req: Request): Promise<AiCaller> {
		const c = await core.auth.owner(req)
		return { uid: c.uid, isAdmin: await get(core).isAdmin(c.uid) }
	}

	async function body(req: Request): Promise<Record<string, unknown>> {
		try {
			const b = await req.json()
			if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>
		} catch { /* fall through */ }
		throw new AgentError('invalid_input', 'Body must be a JSON object')
	}

	/**
	 * Ask Mail to turn classification on (TriageService::enableOnFirstProvider).
	 * Never fatal: a provider is saved whether or not Mail answers, and the
	 * switch on the Mail status page is still there.
	 */
	async function autoEnableTriage(core: LayerCore): Promise<void> {
		try {
			const r = await core.php?.app<{ changed?: boolean, reason?: string }>('POST', 'apps/mail/api/atrium-agent/triage-auto-enable', { body: {} })
			if (r?.changed) console.log('mail classification turned on: first AI provider')
		} catch (e) {
			console.error(`mail classification could not be turned on: ${(e as Error).message}`)
		}
	}

	async function route(core: LayerCore, req: Request, path: string): Promise<Response> {
		const s = get(core)
		const who = await caller(core, req)
		const [a, b, extra] = path.split('/').filter(Boolean).map(decodeURIComponent)
		const m = req.method
		if (a === 'settings' && !b && m === 'GET') return Response.json(await s.overview(who))
		if (a === 'providers' && !b && m === 'POST') {
			const view = await s.create(who, await body(req))
			// V4-26: an instance provider is the moment mail classification can
			// start, so it starts -- unless a person already chose. A personal
			// provider must not flip it: triage_enabled is instance-wide.
			if (view.scope === 'instance' && view.enabled) await autoEnableTriage(core)
			return Response.json(view)
		}
		if (a === 'providers' && b && !extra) {
			if (m === 'PATCH' || m === 'PUT') return Response.json(await s.update(who, b, await body(req)))
			if (m === 'DELETE') {
				await s.remove(who, b)
				return Response.json({ deleted: true })
			}
		}
		if (a === 'test' && !b && m === 'POST') return Response.json(await s.test(who, await body(req)))
		if (a === 'default' && !b && m === 'PUT') {
			const input = await body(req)
			const id = input.provider === null || input.provider === '' || input.provider === undefined ? null : String(input.provider)
			await s.setDefault(who, id, input.scope === 'instance' ? 'instance' : 'user')
			return Response.json(await s.overview(who))
		}
		if (a === 'admin' && !b && m === 'PUT') {
			const input = await body(req)
			if (typeof input.personalProviders !== 'boolean') throw new AgentError('invalid_input', 'personalProviders must be true or false')
			await s.setPersonalAllowed(who, input.personalProviders)
			return Response.json(await s.overview(who))
		}
		throw new AgentError('not_found', `No route ${m} /agent/v1/ai/${path}`)
	}

	let started: LayerCore | null = null
	async function forTask(uid: string, task: string): Promise<AiProvider | null> {
		if (!started) return null
		const s = get(started)
		const cfg = await s.config(uid)
		let route
		try {
			route = resolveRoute(task, { defaultProvider: cfg.defaultProvider ?? undefined }, cfg.providers)
		} catch {
			return null
		}
		const raw = await s.provider(uid, route.provider.id)
		return raw ? getBudget(started).wrap(withModel(raw, route.model), { user: uid, task }) : null
	}

	return {
		tools: () => [],
		settings: () => store,
		budget: () => budget,
		forTask,
		start(core) {
			started = core
			void get(core).migrate().catch((e) => console.error(`ai settings: ${(e as Error).message}`))
		},
		async route(core, req, _url, pathname) {
			if (pathname === TRIAGE_PATH) {
				corrections ??= new Corrections(core.db)
				const c = corrections
				return handleTriage({ settings: get(core), budget: getBudget(core), internal: internalCheck(core.cfg.secret), hints: (uid, input) => c.hints(uid, input) }, req)
			}
			if (!pathname.startsWith('/agent/v1/ai/')) return null
			try {
				return await route(core, req, pathname.slice('/agent/v1/ai/'.length))
			} catch (e) {
				if (e instanceof AiSettingsError) throw new AgentError(e.code, e.message)
				throw e
			}
		},
	}
}
