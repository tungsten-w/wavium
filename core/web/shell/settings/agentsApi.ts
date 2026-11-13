// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner API of the Bun agent layer (/agent/v1/owner): Settings > Agents and approvals.
import { HttpError, request } from '@atrium/sdk'
import type { Action, Agent, AgentAction, Approval, ConnectInfo, Modes, Preset } from './agentsModel'

/** The owner API answers {error: {code, message}}; turn that into a readable Error. */
async function owner<T>(path: string, opts: { method?: string, body?: unknown } = {}): Promise<T> {
	try {
		return await request<T>(`/agent/v1/owner/${path}`, { ...opts, headers: { 'OCS-APIRequest': 'true' } })
	} catch (e) {
		if (e instanceof HttpError) {
			const err = (e.body as { error?: { message?: string } } | null)?.error
			throw new Error(err?.message ?? `HTTP ${e.status}`)
		}
		throw e
	}
}

export const api = {
	agents: () => owner<{ agents: Agent[] }>('agents').then((r) => r.agents),
	areas: () => owner<{ areas: Record<string, Action[]>, tools: Record<string, number> }>('areas'),
	create: (body: { name: string, description: string, preset?: Preset }) => owner<{ agent: Agent, connect: ConnectInfo }>('agents', { method: 'POST', body }),
	update: (uid: string, body: Partial<Pick<Agent, 'displayName' | 'description' | 'paused' | 'wakes' | 'webhookUrl' | 'notifyApprovals'>>) =>
		owner<Agent>(`agents/${encodeURIComponent(uid)}`, { method: 'PATCH', body }),
	remove: (uid: string) => owner(`agents/${encodeURIComponent(uid)}`, { method: 'DELETE' }),
	setAccess: (uid: string, body: { preset?: Preset, areas?: Record<string, Modes | null> }) => owner<Agent>(`agents/${encodeURIComponent(uid)}/access`, { method: 'PUT', body }),
	newSecret: (uid: string) => owner<{ webhookSecret: string }>(`agents/${encodeURIComponent(uid)}/webhook-secret`, { method: 'POST', body: {} }),
	newToken: (uid: string, name: string) => owner<{ id: number, name: string, connect: ConnectInfo }>(`agents/${encodeURIComponent(uid)}/tokens`, { method: 'POST', body: { name } }),
	revokeToken: (uid: string, id: number) => owner(`agents/${encodeURIComponent(uid)}/tokens/${id}`, { method: 'DELETE' }),
	approvals: (status?: string, limit = 50) => owner<{ requests: Approval[] }>(`approvals?${new URLSearchParams({ ...(status ? { status } : {}), limit: String(limit) })}`).then((r) => r.requests),
	actions: (cursor?: string, limit = 20) => owner<{ actions: AgentAction[], next_cursor: string | null }>(`actions?${new URLSearchParams({ ...(cursor ? { cursor } : {}), limit: String(limit) })}`),
	undo: (id: string) => owner<AgentAction>(`actions/${encodeURIComponent(id)}/undo`, { method: 'POST', body: {} }),
	decide: (rid: string, decision: 'approve' | 'reject', note?: string) => owner<Approval>(`approvals/${encodeURIComponent(rid)}/${decision}`, { method: 'POST', body: { note: note ?? null } }),
}

