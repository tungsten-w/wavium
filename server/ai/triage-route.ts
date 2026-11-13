// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// POST /agent/v1/internal/ai/triage (PLAN P2-4): Mail's TriageService asks the
// provider layer to classify one mail, in place of tollgate's decisions API.
//
// Internal only: the caller must send X-Atrium-Internal (HMAC of the instance
// secret, like Bun -> PHP calls; checked by `deps.internal`, wired in
// server/agent/ai.ts). PHP reaches the Bun server on the private network
// (ATRIUM_SERVER_URL, see TriageService).
//
// Body {uid, input, questions}: `uid` owns the mail account; their AI settings
// (Settings > AI: their default provider or the instance one) and their budget
// apply, task "triage" (small model, P2-5).
//
// Answers, so TriageService keeps its own logic:
//   200 decisions {answers, model, provider, providerLabel, usage}
//   409 not_configured   no provider for this user, or no model for triage
//   402 budget           cap reached / no credit; `until` = when to retry
//   401 unauthorized     the provider refused the key (paused 1 h)
//   429 / 503            rate limit, provider down or paused; `until` when known
//   422 invalid          the model kept answering badly (counts an attempt)
//   400 / 403            bad body / not internal
import { Budget, BudgetBlocked } from './budget'
import { AiError } from './errors'
import { resolveRoute, withModel } from './routing'
import type { AiSettings } from './settings'
import { classify, parseQuestions } from './triage'

export const TRIAGE_PATH = '/agent/v1/internal/ai/triage'

export interface TriageDeps {
	settings: AiSettings
	budget: Budget
	/** True when the request carries the internal header. */
	internal: (req: Request) => boolean
	now?: () => number
}

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status })

/** AiError -> the status TriageService acts on. */
export function errorStatus(e: AiError, now: number): { status: number, body: Record<string, unknown> } {
	const until = e instanceof BudgetBlocked ? e.until : e.retryAfter !== undefined ? now + e.retryAfter : undefined
	const base = { message: e.message, provider: e.provider, ...(until !== undefined ? { until } : {}) }
	const reason = e instanceof BudgetBlocked ? e.reason : e.code
	switch (reason) {
	case 'budget': case 'daily_cap': case 'monthly_cap': return { status: 402, body: { code: 'budget', reason, ...base } }
	case 'auth': return { status: 401, body: { code: 'unauthorized', ...base } }
	case 'rate_limit': return { status: 429, body: { code: 'rate_limit', ...base } }
	case 'invalid': return { status: 422, body: { code: 'invalid', ...base } }
	default: return { status: 503, body: { code: 'unavailable', ...base } }
	}
}

export async function handleTriage(deps: TriageDeps, req: Request): Promise<Response> {
	const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
	if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
	if (!deps.internal(req)) return json(403, { code: 'forbidden', message: 'internal only' })
	let body: any
	try { body = await req.json() } catch { return json(400, { code: 'invalid_input', message: 'Body must be JSON' }) }
	const uid = body?.uid
	if (typeof uid !== 'string' || uid === '') return json(400, { code: 'invalid_input', message: 'uid is required' })
	if (typeof body.input !== 'string' || body.input.trim() === '') return json(400, { code: 'invalid_input', message: 'input is required' })
	let questions
	try { questions = parseQuestions(body.questions) } catch (e) { return json(400, { code: 'invalid_input', message: (e as Error).message }) }

	const cfg = await deps.settings.config(uid)
	let route
	try {
		route = resolveRoute('triage', { defaultProvider: cfg.defaultProvider ?? undefined }, cfg.providers)
	} catch (e) {
		return json(409, { code: 'not_configured', message: `No AI for mail triage: ${(e as Error).message}. Add one in Settings > AI.` })
	}
	const raw = await deps.settings.provider(uid, route.provider.id)
	if (!raw) return json(409, { code: 'not_configured', message: 'No AI for mail triage. Add one in Settings > AI.' })
	const ai = deps.budget.wrap(withModel(raw, route.model), { user: uid, task: 'triage' })
	try {
		const label = (route.provider as { label?: string }).label || route.provider.id
		return json(200, { ...await classify(ai, body.input, questions, req.signal), providerLabel: label, route: { model: route.model, modelFrom: route.modelFrom } })
	} catch (e) {
		if (e instanceof AiError) {
			const { status, body: b } = errorStatus(e, now())
			return json(status, b)
		}
		throw e
	}
}
