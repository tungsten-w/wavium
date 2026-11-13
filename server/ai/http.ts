// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HTTP plumbing shared by the providers: timeout, caller abort, and turning
// every failure into an AiError. The key only ever travels in headers.
import { AiError, httpError } from './errors'
import type { FetchFn } from './types'

export interface HttpCtx {
	provider: string
	fetch: FetchFn
	timeoutMs: number
	redact: (s: string) => string
}

export interface Sent {
	res: Response
	/** Restarts the timeout; streams call it on every chunk (idle timeout). */
	touch(): void
	done(): void
	/** done() plus dropping the connection: for streams the caller stopped reading. */
	close(): void
	/** Maps an error thrown while reading the body. */
	fail(e: unknown): unknown
}

export async function send(ctx: HttpCtx, url: string, init: RequestInit, signal?: AbortSignal): Promise<Sent> {
	const ctrl = new AbortController()
	let timedOut = false
	let timer: ReturnType<typeof setTimeout> | undefined
	const touch = () => {
		clearTimeout(timer)
		timer = setTimeout(() => { timedOut = true; ctrl.abort() }, ctx.timeoutMs)
	}
	const onAbort = () => ctrl.abort(signal?.reason)
	const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
	// A caller abort is rethrown as is (the caller asked for it); our own
	// timeout and network failures are "unavailable", worth a retry later.
	const fail = (e: unknown): unknown => {
		done()
		if (e instanceof AiError) return e
		if (signal?.aborted) return signal.reason ?? e
		if (timedOut) return new AiError('unavailable', `${ctx.provider}: no answer within ${Math.round(ctx.timeoutMs / 1000)} s`, ctx.provider)
		const why = e instanceof Error ? e.message : String(e)
		return new AiError('unavailable', `${ctx.provider}: network error: ${ctx.redact(why)}`, ctx.provider)
	}
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
	signal?.addEventListener('abort', onAbort, { once: true })
	touch()
	let res: Response
	try {
		res = await ctx.fetch(url, { ...init, signal: ctrl.signal })
	} catch (e) {
		throw fail(e)
	}
	if (!res.ok) {
		let body = ''
		try { body = await res.text() } catch {}
		done()
		throw httpError(ctx.provider, res.status, body, res.headers, ctx.redact)
	}
	return { res, touch, done, fail, close: () => { done(); ctrl.abort() } }
}

/** POST/GET and parse a JSON answer. */
export async function json<T = any>(ctx: HttpCtx, url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
	const s = await send(ctx, url, init, signal)
	let text: string
	try {
		text = await s.res.text()
	} catch (e) {
		throw s.fail(e)
	}
	s.done()
	try {
		return JSON.parse(text) as T
	} catch {
		throw new AiError('unavailable', `${ctx.provider}: answer is not JSON`, ctx.provider, s.res.status)
	}
}

/** Joins a base URL and a path without doubling slashes. */
export const join = (base: string, path: string): string => base.replace(/\/+$/, '') + path

/** Tool-call arguments are a JSON string on the wire; small local models sometimes send broken JSON. */
export function parseArgs(s: string | undefined): unknown {
	if (!s) return {}
	try {
		return JSON.parse(s)
	} catch {
		// Keep the raw text: the tool's input validation rejects it with a clear message.
		return s
	}
}
