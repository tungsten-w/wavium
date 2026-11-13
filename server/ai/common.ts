// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What every HTTP provider shares once its config is validated.
import { AiError } from './errors'
import type { HttpCtx } from './http'
import type { AiProvider, AiRequest, ConnectionTest, ProviderKind, Usage } from './types'

export interface Resolved {
	id: string
	kind: ProviderKind
	baseUrl: string
	apiKey?: string
	headers: Record<string, string>
	http: HttpCtx
	/** The request's model, else the default one, else AiError('invalid'). */
	model(req: AiRequest): string
}

export async function testConnection(listModels: () => Promise<string[]>): Promise<ConnectionTest> {
	try {
		return { ok: true, models: await listModels() }
	} catch (e) {
		if (e instanceof AiError) return { ok: false, error: { code: e.code, message: e.message } }
		return { ok: false, error: { code: 'unavailable', message: e instanceof Error ? e.message : String(e) } }
	}
}

export function baseProvider(r: Resolved, p: Pick<AiProvider, 'complete' | 'stream' | 'listModels'>): AiProvider {
	return { id: r.id, kind: r.kind, ...p, testConnection: () => testConnection(p.listModels) }
}

/** Tokens spent before a stream failed go with the error, so budgets still count them. */
export function withUsage(e: unknown, usage: Usage): unknown {
	if (e instanceof AiError) e.usage = { ...usage }
	else if (e instanceof Error && Object.isExtensible(e) && !('usage' in e)) Object.assign(e, { usage: { ...usage } })
	return e
}

export const noUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, reported: false })

/** listModels answers are {data: [{id}]} for every supported API; anything else is a broken server. */
export function modelIds(provider: string, j: any): string[] {
	if (!Array.isArray(j?.data)) throw new AiError('unavailable', `${provider}: unexpected model list`, provider)
	return j.data.flatMap((m: any) => (typeof m?.id === 'string' ? [m.id] : []))
}
