// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HTTP plumbing shared by the providers: timeout, caller abort, size limits,
// no redirects, and turning every failure into an AiError. The key only ever
// travels in headers.
import { AiError, httpError } from './errors'
import { SseLimitError, type SseOptions } from './sse'
import type { FetchFn } from './types'

export interface HttpCtx {
	provider: string
	fetch: FetchFn
	timeoutMs: number
	redact: (s: string) => string
}

// Base URLs are user-set (P2-2): a server must not make us hold unbounded data.
export const MAX_ERROR_BODY = 64 * 1024
export const MAX_JSON_BODY = 8 * 1024 * 1024

export interface Sent {
	res: Response
	/** Hooks for readSse: the timeout runs only while waiting for the server, not while the caller handles an event. */
	sse: SseOptions
	done(): void
	/** done() plus dropping the connection: for streams the caller stopped reading. */
	close(): void
	/** Maps an error thrown while reading the body. */
	fail(e: unknown): unknown
}

class BodyLimitError extends RangeError {}

/** Reads at most `max` bytes. Over it: truncates (`truncate`) or throws BodyLimitError. */
export async function readCapped(res: Response, max: number, truncate = false): Promise<string> {
	if (!res.body) return ''
	const reader = res.body.getReader()
	const parts: Uint8Array[] = []
	let n = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			n += value.length
			if (n > max) {
				if (!truncate) throw new BodyLimitError(`answer over ${max} bytes`)
				parts.push(value.slice(0, value.length - (n - max)))
				await reader.cancel().catch(() => {})
				break
			}
			parts.push(value)
		}
	} finally {
		reader.releaseLock()
	}
	return new TextDecoder().decode(Buffer.concat(parts))
}

export async function send(ctx: HttpCtx, url: string, init: RequestInit, signal?: AbortSignal): Promise<Sent> {
	const ctrl = new AbortController()
	let timedOut = false
	let timer: ReturnType<typeof setTimeout> | undefined
	const arm = () => {
		clearTimeout(timer)
		timer = setTimeout(() => { timedOut = true; ctrl.abort() }, ctx.timeoutMs)
	}
	const disarm = () => clearTimeout(timer)
	const onAbort = () => ctrl.abort(signal?.reason)
	const done = () => { disarm(); signal?.removeEventListener('abort', onAbort) }
	// A caller abort is rethrown as is (the caller asked for it); our own
	// timeout and network failures are "unavailable", worth a retry later.
	const fail = (e: unknown): unknown => {
		done()
		if (e instanceof AiError) return e
		if (signal?.aborted) return signal.reason ?? e
		if (timedOut) return new AiError('unavailable', `${ctx.provider}: no answer within ${Math.round(ctx.timeoutMs / 1000)} s`, ctx.provider)
		if (e instanceof BodyLimitError || e instanceof SseLimitError) return new AiError('unavailable', `${ctx.provider}: ${e.message}`, ctx.provider)
		const why = e instanceof Error ? e.message : String(e)
		return new AiError('unavailable', `${ctx.provider}: network error: ${ctx.redact(why)}`, ctx.provider)
	}
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
	signal?.addEventListener('abort', onAbort, { once: true })
	arm()
	let res: Response
	try {
		// Never follow a redirect: the key and custom headers would go along to
		// wherever it points, and it would bypass checks on the configured URL.
		res = await ctx.fetch(url, { ...init, redirect: 'manual', signal: ctrl.signal })
	} catch (e) {
		throw fail(e)
	}
	if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
		await res.body?.cancel().catch(() => {})
		done()
		throw new AiError('invalid', `${ctx.provider}: HTTP ${res.status}: the server redirects (not followed); check the base URL`, ctx.provider, res.status || undefined)
	}
	if (!res.ok) {
		let body = ''
		try { body = await readCapped(res, MAX_ERROR_BODY, true) } catch {}
		done()
		throw httpError(ctx.provider, res.status, body, res.headers, ctx.redact)
	}
	return { res, sse: { beforeRead: arm, afterRead: disarm }, done, fail, close: () => { done(); ctrl.abort() } }
}

/** POST/GET and parse a JSON answer. */
export async function json<T = any>(ctx: HttpCtx, url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
	const s = await send(ctx, url, init, signal)
	let text: string
	try {
		text = await readCapped(s.res, MAX_JSON_BODY)
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

export const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
