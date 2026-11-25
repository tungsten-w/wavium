// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Talking to one of your own agents from the assistant panel (V4-39).
// Server: server/agent/chat. Unlike the built-in assistant, there is no stream
// and no AI provider here: the message waits in a thread until the agent picks
// it up on its own machine, and its answer appears when it answers. The panel
// polls, because an agent that runs outside Wavium cannot push.
import { HttpError, request } from '@atrium/sdk'

export interface TalkableAgent { uid: string, name: string, paused: boolean, waiting: number, lastAt: number }
export interface ChatMessage { id: number, from: 'you' | 'agent', text: string, at: number, taken: boolean }

/** How often the thread is re-read while the panel shows it. */
export const POLL_MS = 4000
/** Where the panel remembers who you were talking to. */
export const WHO_KEY = 'atrium-assistant-who'
/** Settings > AI asks the shell to open the panel on an agent with this event. */
export const OPEN_EVENT = 'atrium:talk-to-agent'

/**
 * The agent layer answers {error: {code, message}}. The SDK's generic reader
 * looks for a string in `error` and finds an object, so an unwrapped failure
 * reaches the panel as "[object Object]". Take the message out here, like
 * Settings > AI does with the same shape.
 */
async function chat<T>(path: string, opts: { method?: string, body?: unknown } = {}): Promise<T> {
	try {
		return await request<T>(path, { ...opts, headers: { 'OCS-APIRequest': 'true' } })
	} catch (e) {
		if (e instanceof HttpError) {
			const msg = (e.body as { error?: { message?: string } } | null)?.error?.message
			throw new Error(msg ?? `HTTP ${e.status}`)
		}
		throw e
	}
}

export const chatApi = {
	agents: () => chat<{ agents: TalkableAgent[] }>('/agent/v1/chat'),
	thread: (uid: string, after = 0) => chat<{ agent: { uid: string, name: string, paused: boolean }, messages: ChatMessage[] }>(
		`/agent/v1/chat/${encodeURIComponent(uid)}${after > 0 ? `?after=${after}` : ''}`),
	send: (uid: string, text: string) => chat<{ message: ChatMessage }>(`/agent/v1/chat/${encodeURIComponent(uid)}`, { method: 'POST', body: { text } }),
}

/** Adds what came back without ever showing a message twice, and keeps the order. */
export function merge(have: ChatMessage[], fresh: ChatMessage[]): ChatMessage[] {
	if (!fresh.length) return have
	const by = new Map(have.map((m) => [m.id, m]))
	for (const m of fresh) by.set(m.id, m)
	return [...by.values()].sort((a, b) => a.id - b.id)
}

/** The id to ask for next, so polling only carries what is new. */
export const lastId = (msgs: ChatMessage[]): number => msgs.reduce((max, m) => Math.max(max, m.id), 0)

/**
 * What to say under the thread. An agent outside Wavium answers in its own
 * time, so the honest thing is to say where the message is, not to pretend
 * someone is typing.
 */
export function waitingLine(msgs: ChatMessage[], agent: { name: string, paused: boolean }): string | null {
	const last = msgs[msgs.length - 1]
	if (!last || last.from === 'agent') return null
	if (agent.paused) return `${agent.name} is paused, so it will not read this until you resume it (Settings > Agents).`
	return last.taken
		? `${agent.name} has your message and is working on it. Its answer appears here.`
		: `Waiting for ${agent.name} to pick this up. It checks in regularly.`
}

/** Remembers who the panel was last showing; "assistant" is the built-in one. */
export function readWho(): string {
	try { return localStorage.getItem(WHO_KEY) ?? 'assistant' } catch { return 'assistant' }
}

export function saveWho(who: string): void {
	try { localStorage.setItem(WHO_KEY, who) } catch { /* not remembered */ }
}

/** Open the assistant panel on one agent, from anywhere in the shell. */
export function talkTo(uid: string): void {
	saveWho(uid)
	window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { uid } }))
}
