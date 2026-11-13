// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What every HTTP provider shares once its config is validated.
import { AiError } from './errors'
import type { HttpCtx } from './http'
import type { AiProvider, AiRequest, ConnectionTest, ProviderKind } from './types'

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
