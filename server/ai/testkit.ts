// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test helpers: a fake fetch that records requests and replays canned
// responses, and SSE bodies cut into awkward chunks.
import type { FetchFn } from './types'

export interface Call { url: string, method: string, headers: Record<string, string>, body: any, signal?: AbortSignal | null, redirect?: RequestRedirect }

type Canned = Response | Error | ((c: Call) => Response | Promise<Response>)

export function fakeFetch(...canned: Canned[]): { fetch: FetchFn, calls: Call[] } {
	const calls: Call[] = []
	const fetch: FetchFn = async (url, init = {}) => {
		const headers = Object.fromEntries(new Headers(init.headers).entries())
		const c: Call = { url, method: init.method ?? 'GET', headers, body: init.body ? JSON.parse(String(init.body)) : undefined, signal: init.signal, redirect: init.redirect }
		calls.push(c)
		const next = canned.shift()
		if (!next) throw new Error('fakeFetch: no canned response left')
		if (next instanceof Error) throw next
		return typeof next === 'function' ? next(c) : next
	}
	return { fetch, calls }
}

export const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** SSE text from [event, data] pairs (event null = no event line). */
export const sse = (events: Array<[string | null, unknown]>, eol = '\n'): string =>
	events.map(([ev, data]) => (ev ? `event: ${ev}${eol}` : '') + `data: ${typeof data === 'string' ? data : JSON.stringify(data)}${eol}${eol}`).join('')

/** A streamed body cut every `size` bytes, so lines and UTF-8 chars get split. */
export function chunked(text: string, size = 7): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text)
	let i = 0
	return new ReadableStream({
		pull(ctrl) {
			if (i >= bytes.length) return ctrl.close()
			ctrl.enqueue(bytes.slice(i, i + size))
			i += size
		},
	})
}

export const sseRes = (text: string, size = 7): Response =>
	new Response(chunked(text, size), { status: 200, headers: { 'content-type': 'text/event-stream' } })

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []
	for await (const x of it) out.push(x)
	return out
}
