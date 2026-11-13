// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One error type for every provider. The codes are what budgets and automatic
// pauses (P2-3) act on, as in TriageService: budget -> pause to midnight,
// auth -> pause 1 h, rate_limit / unavailable -> backoff. Keep them stable.
import type { Usage } from './types'

export type AiErrorCode = 'auth' | 'budget' | 'rate_limit' | 'invalid' | 'unavailable'

export class AiError extends Error {
	/** Tokens already spent when a stream failed midway (budgets still count them). */
	usage?: Usage

	constructor(
		public code: AiErrorCode,
		message: string,
		public provider: string,
		public status?: number,
		/** Seconds, from Retry-After (or retry-after-ms), when the provider sent one. */
		public retryAfter?: number,
	) {
		super(message)
		this.name = 'AiError'
	}

	toJSON() {
		return {
			code: this.code,
			message: this.message,
			provider: this.provider,
			...(this.status !== undefined ? { status: this.status } : {}),
			...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}),
			...(this.usage ? { usage: this.usage } : {}),
		}
	}
}

/** Retry-After is seconds or an HTTP date. */
export function parseRetryAfter(v: string | null, now = Date.now()): number | undefined {
	if (!v) return undefined
	if (/^\s*\d+(\.\d+)?\s*$/.test(v)) return Math.ceil(Number(v))
	const at = Date.parse(v)
	return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000))
}

/** OpenAI also sends retry-after-ms, more precise; it wins when present. */
export function retryAfterOf(headers?: Headers): number | undefined {
	const ms = headers?.get('retry-after-ms')
	if (ms && /^\s*\d+(\.\d+)?\s*$/.test(ms)) return Math.ceil(Number(ms) / 1000)
	return parseRetryAfter(headers?.get('retry-after') ?? null)
}

/** The error object of a provider body: {error: {...}} (OpenAI, Anthropic, Mistral) or the body itself. */
function errorObject(body: unknown): { message?: unknown, type?: unknown, code?: unknown, detail?: unknown } {
	if (body && typeof body === 'object') {
		const e = (body as any).error
		if (e && typeof e === 'object') return e
		if (typeof e === 'string') return { message: e }
		return body as any
	}
	return {}
}

// Anthropic error types carry the meaning of a status (also sent mid-stream).
const ANTHROPIC_TYPES: Record<string, number> = {
	invalid_request_error: 400, authentication_error: 401, billing_error: 402, permission_error: 403,
	not_found_error: 404, request_too_large: 413, rate_limit_error: 429, api_error: 500, overloaded_error: 529,
}

/**
 * Status + parsed body -> code. Quota is not always a 402: OpenAI answers 429
 * insufficient_quota, Anthropic 400 "credit balance is too low". Those never
 * get better with a retry, so they are budget. Decided on the structured
 * fields, not on free text (a plain 429 message links to the billing page).
 */
function classify(status: number | undefined, e: ReturnType<typeof errorObject>): AiErrorCode {
	const type = typeof e.type === 'string' ? e.type : ''
	const code = typeof e.code === 'string' ? e.code : ''
	const message = typeof e.message === 'string' ? e.message : ''
	const s = status ?? ANTHROPIC_TYPES[type] ?? (typeof e.code === 'number' ? e.code : undefined)
	if (code === 'insufficient_quota' || type === 'insufficient_quota' || type === 'billing_error') return 'budget'
	if (type === 'invalid_request_error' && /credit balance is too low/i.test(message)) return 'budget'
	if (s === undefined) return code === 'rate_limit_exceeded' || type === 'rate_limit_exceeded' ? 'rate_limit' : 'unavailable'
	if (s === 401 || s === 403) return 'auth'
	if (s === 402) return 'budget'
	if (s === 429) return 'rate_limit'
	if (s === 408 || s >= 500) return 'unavailable'
	// Redirects are not followed (the key must not travel to another origin).
	return 'invalid'
}

/** Builds the AiError for an HTTP error (status set) or a mid-stream error event (status undefined). */
export function providerError(provider: string, status: number | undefined, body: unknown, redact: (s: string) => string, headers?: Headers): AiError {
	const e = errorObject(body)
	const raw = e.message ?? e.detail ?? e.type ?? (typeof body === 'string' ? body : '')
	const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
	const detail = redact(text).replace(/\s+/g, ' ').trim().slice(0, 300)
	const code = classify(status, e)
	const msg = `${provider}: ${status !== undefined ? `HTTP ${status}` : 'stream error'}${detail ? ': ' + detail : ''}`
	const retry = code === 'rate_limit' || code === 'unavailable' ? retryAfterOf(headers) : undefined
	return new AiError(code, msg, provider, status, retry)
}

export function httpError(provider: string, status: number, body: string, headers: Headers, redact: (s: string) => string): AiError {
	let parsed: unknown = body
	try { parsed = JSON.parse(body) } catch {}
	return providerError(provider, status, parsed, redact, headers)
}

/** Replaces the key (and any Bearer token) by "***" in text that may end up in logs. */
export function redactor(apiKey?: string): (s: string) => string {
	return (s) => {
		let out = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***')
		if (apiKey && apiKey.length >= 4) out = out.split(apiKey).join('***')
		return out
	}
}
