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
	return { id: r.id, kind: r.kind, ...trackUsage(p), testConnection: () => testConnection(p.listModels) }
}

/**
 * Tokens spent before a stream failed: reported through req.onUsage, and kept
 * on our own AiError. A caller's abort reason is never written to: it is not
 * ours and may be shared by several calls (their usage would be mixed up).
 */
export function withUsage(e: unknown, usage: Usage, onUsage?: (u: Usage) => void): unknown {
	if (e instanceof AiError) e.usage = { ...usage }
	reportUsage(onUsage, usage)
	return e
}

/** Calls the request's onUsage; a throwing callback never breaks the call. */
export function reportUsage(onUsage: ((u: Usage) => void) | undefined, usage: Usage): void {
	try { onUsage?.({ ...usage }) } catch { /* the caller's bookkeeping, not ours */ }
}

/** Successful paths: complete() results and the stream's final 'done' event report their usage. */
export function trackUsage(p: Pick<AiProvider, 'complete' | 'stream' | 'listModels'>): Pick<AiProvider, 'complete' | 'stream' | 'listModels'> {
	return {
		listModels: p.listModels,
		async complete(req) {
			const r = await p.complete(req)
			reportUsage(req.onUsage, r.usage)
			return r
		},
		async *stream(req) {
			for await (const ev of p.stream(req)) {
				if (ev.type === 'done') reportUsage(req.onUsage, ev.result.usage)
				yield ev
			}
		},
	}
}

export const noUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, reported: false })

/** listModels answers are {data: [{id}]} for every supported API; anything else is a broken server. */
export function modelIds(provider: string, j: any): string[] {
	if (!Array.isArray(j?.data)) throw new AiError('unavailable', `${provider}: unexpected model list`, provider)
	return j.data.flatMap((m: any) => (typeof m?.id === 'string' ? [m.id] : []))
}
