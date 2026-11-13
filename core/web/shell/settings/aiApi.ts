// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > AI API of the Bun agent layer (/agent/v1/ai, P2-2).
import { HttpError, request } from '@atrium/sdk'
import type { AiOverview, ConnectionTest, ProviderView, Scope } from './aiModel'

async function ai<T>(path: string, opts: { method?: string, body?: unknown } = {}): Promise<T> {
	try {
		return await request<T>(`/agent/v1/ai/${path}`, { ...opts, headers: { 'OCS-APIRequest': 'true' } })
	} catch (e) {
		if (e instanceof HttpError) {
			const err = (e.body as { error?: { message?: string } } | null)?.error
			throw new Error(err?.message ?? `HTTP ${e.status}`)
		}
		throw e
	}
}

export const aiApi = {
	overview: () => ai<AiOverview>('settings'),
	create: (body: Record<string, unknown>) => ai<ProviderView>('providers', { method: 'POST', body }),
	update: (id: string, body: Record<string, unknown>) => ai<ProviderView>(`providers/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
	remove: (id: string) => ai(`providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
	test: (body: Record<string, unknown>) => ai<ConnectionTest>('test', { method: 'POST', body }),
	setDefault: (provider: string | null, scope: Scope = 'user') => ai<AiOverview>('default', { method: 'PUT', body: { provider, scope } }),
	setPersonal: (on: boolean) => ai<AiOverview>('admin', { method: 'PUT', body: { personalProviders: on } }),
}
