// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Client of the Google Messages sidecar (services/gmessages, ADR 0010).
// Internal network only, `Authorization: Bearer <ATRIUM_GMESSAGES_SECRET>`.
import { AgentError } from '../util'
import type { SideConversation, SideMessage } from './store'

export interface SideStatus { state: string, qr?: string, emoji?: string, phone?: string, error?: string }

export interface SideEvent {
	type: 'qr' | 'paired' | 'session' | 'message' | 'conversation' | 'phone_offline' | 'phone_online' | 'logged_out' | 'pair_failed'
	uid: string
	qr?: string
	emoji?: string
	session?: unknown
	phone?: string
	message?: SideMessage
	conversation?: SideConversation
	error?: string
}

export interface Sidecar {
	status(uid: string): Promise<SideStatus>
	pairQr(uid: string): Promise<{ qr: string }>
	pairGoogle(uid: string, cookies: Record<string, string>): Promise<{ emoji: string }>
	connect(uid: string, session: unknown): Promise<SideStatus>
	unpair(uid: string): Promise<void>
	conversations(uid: string, count?: number): Promise<SideConversation[]>
	messages(uid: string, conversation: string, count?: number): Promise<SideMessage[]>
	start(uid: string, number: string): Promise<SideConversation>
	send(uid: string, conversation: string, text: string, tmpId: string): Promise<void>
	markRead(uid: string, conversation: string, message: string): Promise<void>
	media(uid: string, mediaId: string, key: string): Promise<Uint8Array>
	/** Reads the event stream until `signal` aborts; reconnects by itself. */
	listen(onEvent: (e: SideEvent) => void, signal: AbortSignal, onConnect?: () => void): Promise<void>
}

export function httpSidecar(baseUrl: string, secret: string, fetcher: typeof fetch = fetch): Sidecar {
	const base = baseUrl.replace(/\/+$/, '')
	const auth = { Authorization: `Bearer ${secret}` }
	const u = (uid: string, path: string) => `${base}/v1/users/${encodeURIComponent(uid)}${path}`

	async function call<T>(method: string, url: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
		let res: Response
		try {
			res = await fetcher(url, {
				method,
				headers: { ...auth, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(timeoutMs),
			})
		} catch (e) {
			throw new AgentError('unavailable', `The Messages service does not answer (${(e as Error).message})`)
		}
		if (!res.ok) {
			let msg = `HTTP ${res.status}`
			let code = ''
			try {
				const j = await res.json() as { error?: { code?: string, message?: string } }
				msg = j.error?.message ?? msg
				code = j.error?.code ?? ''
			} catch { /* not JSON */ }
			if (code === 'not_paired') throw new AgentError('conflict', 'No phone is linked', 'not_paired')
			if (code === 'not_found') throw new AgentError('not_found', msg)
			if (code === 'invalid_input') throw new AgentError('invalid_input', msg)
			throw new AgentError('unavailable', `Phone: ${msg}`)
		}
		return res.json() as Promise<T>
	}

	return {
		status: (uid) => call('GET', u(uid, '/status')),
		pairQr: (uid) => call('POST', u(uid, '/pair/qr'), undefined, 60_000),
		pairGoogle: (uid, cookies) => call('POST', u(uid, '/pair/google'), { cookies }, 90_000),
		connect: (uid, session) => call('PUT', u(uid, '/session'), { session }, 60_000),
		unpair: async (uid) => { await call('DELETE', u(uid, '/session')) },
		conversations: async (uid, count = 50) => (await call<{ conversations: SideConversation[] }>('GET', u(uid, `/conversations?count=${count}`))).conversations ?? [],
		messages: async (uid, conv, count = 50) => (await call<{ messages: SideMessage[] }>('GET', u(uid, `/conversations/${encodeURIComponent(conv)}/messages?count=${count}`))).messages ?? [],
		start: (uid, number) => call('POST', u(uid, '/conversations'), { number }),
		send: async (uid, conversation_id, text, tmp_id) => { await call('POST', u(uid, '/send'), { conversation_id, text, tmp_id }) },
		markRead: async (uid, conversation_id, message_id) => { await call('POST', u(uid, '/read'), { conversation_id, message_id }) },
		async media(uid, media_id, key) {
			const res = await fetcher(u(uid, '/media'), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ media_id, key }), signal: AbortSignal.timeout(60_000) })
			if (!res.ok) throw new AgentError('unavailable', `Phone: media HTTP ${res.status}`)
			return new Uint8Array(await res.arrayBuffer())
		},
		async listen(onEvent, signal, onConnect) {
			let wait = 1000
			while (!signal.aborted) {
				try {
					const res = await fetcher(`${base}/v1/events`, { headers: auth, signal })
					if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
					wait = 1000
					onConnect?.()
					const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
					let buf = ''
					for (;;) {
						const { value, done } = await reader.read()
						if (done) break
						buf += value
						let i: number
						while ((i = buf.indexOf('\n\n')) >= 0) {
							const chunk = buf.slice(0, i)
							buf = buf.slice(i + 2)
							for (const line of chunk.split('\n')) {
								if (!line.startsWith('data: ')) continue
								try { onEvent(JSON.parse(line.slice(6)) as SideEvent) } catch (e) { console.error(`messages: bad event: ${(e as Error).message}`) }
							}
						}
					}
				} catch (e) {
					if (signal.aborted) return
					console.error(`messages: event stream: ${(e as Error).message}; retry in ${wait / 1000}s`)
				}
				await new Promise((r) => setTimeout(r, wait))
				wait = Math.min(wait * 2, 60_000)
			}
		},
	}
}
