// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Messages owner API (server/agent/messages, /agent/v1/messages).
import { HttpError, request } from '@atrium/sdk'

export interface Participant { id: string, name: string, number: string, is_me: boolean }
export interface Conversation {
	id: string
	name: string
	contact: string | null
	is_group: boolean
	kind: string
	unread: boolean
	/** unix ms */
	last_at: number
	read_only: boolean
	participants: Participant[]
	last_text: string | null
	last_from_me: boolean
}
export interface Message {
	id: string
	conversation_id: string
	at: number
	from_me: boolean
	sender_name: string
	sender_number: string
	text: string
	status: string
	media: Array<{ index: number, name: string, mime: string, size: number }>
	one_time_code: boolean
}
export interface Status {
	state: 'unpaired' | 'pairing' | 'connecting' | 'connected' | 'phone_offline' | 'logged_out' | 'error' | 'demo'
	available: boolean
	demo: boolean
	phone: string | null
	linked_at: string | null
	offline_since: string | null
	error: string | null
	qr: string | null
	emoji: string | null
	counts: { conversations: number, messages: number }
}
export interface AgentPref { uid: string, name: string, show_codes: boolean }

const base = '/agent/v1/messages'
const H = { 'OCS-APIRequest': 'true' }

async function api<T>(path: string, opts: { method?: string, body?: unknown, signal?: AbortSignal } = {}): Promise<T> {
	try {
		return await request<T>(base + path, { ...opts, headers: H })
	} catch (e) {
		if (e instanceof HttpError) {
			const msg = (e.body as { error?: { message?: string } } | undefined)?.error?.message
			if (msg) throw new Error(msg)
		}
		throw e
	}
}

export const getStatus = () => api<Status>('/status')
export const linkQr = () => api<{ qr: string }>('/link/qr', { method: 'POST' })
export const linkGoogle = (cookies: string) => api<{ emoji: string }>('/link/google', { method: 'POST', body: { cookies } })
export const unlink = () => api<{ unlinked: boolean }>('/link', { method: 'DELETE' })
export const listConversations = (q = '', unread = false) =>
	api<{ conversations: Conversation[] }>(`/conversations?${new URLSearchParams({ ...(q ? { q } : {}), ...(unread ? { unread: '1' } : {}) })}`).then((r) => r.conversations)
export const openConversation = (number: string) => api<Conversation>('/conversations', { method: 'POST', body: { number } })
export const listMessages = (id: string, before?: number) =>
	api<{ conversation: Conversation, messages: Message[] }>(`/conversations/${encodeURIComponent(id)}/messages${before ? `?before=${before}` : ''}`)
export const markRead = (id: string) => api<{ read: boolean }>(`/conversations/${encodeURIComponent(id)}/read`, { method: 'POST' })
export const send = (conversation_id: string, text: string) => api<{ message_id: string, status: string }>('/send', { method: 'POST', body: { conversation_id, text } })
export const search = (q: string) => api<{ results: Array<Message & { conversation_name: string }> }>(`/search?q=${encodeURIComponent(q)}`).then((r) => r.results)
export const agentPrefs = () => api<{ agents: AgentPref[] }>('/agents').then((r) => r.agents)
export const setAgentPref = (uid: string, show_codes: boolean) => api<AgentPref>(`/agents/${encodeURIComponent(uid)}`, { method: 'PUT', body: { show_codes } })
export const mediaUrl = (msg: string, idx: number) => `${base}/media/${encodeURIComponent(msg)}/${idx}`
