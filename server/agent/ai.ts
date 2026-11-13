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
// Keys go in, never out. The settings store lives in server/ai/settings.ts.
import { AiSettings, AiSettingsError, type AiCaller } from '../ai/settings'
import type { AgentModule, LayerCore } from './index'
import { AgentError } from './util'

export interface AiModule extends AgentModule {
	/** The settings store, once the layer started (for features: triage, summaries...). */
	settings(): AiSettings | null
}

export function aiModule(make?: (core: LayerCore) => AiSettings): AiModule {
	let store: AiSettings | null = null
	const get = (core: LayerCore) => (store ??= make ? make(core) : new AiSettings(core.db, core.cfg.secret))

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

	async function route(core: LayerCore, req: Request, path: string): Promise<Response> {
		const s = get(core)
		const who = await caller(core, req)
		const [a, b, extra] = path.split('/').filter(Boolean).map(decodeURIComponent)
		const m = req.method
		if (a === 'settings' && !b && m === 'GET') return Response.json(await s.overview(who))
		if (a === 'providers' && !b && m === 'POST') return Response.json(await s.create(who, await body(req)))
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

	return {
		tools: () => [],
		settings: () => store,
		start(core) {
			void get(core).migrate().catch((e) => console.error(`ai settings: ${(e as Error).message}`))
		},
		async route(core, req, _url, pathname) {
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
