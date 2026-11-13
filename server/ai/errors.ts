// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One error type for every provider. The codes are what budgets and automatic
// pauses (P2-3) act on, as in TriageService: budget -> pause to midnight,
// auth -> pause 1 h, rate_limit / unavailable -> backoff. Keep them stable.

export type AiErrorCode = 'auth' | 'budget' | 'rate_limit' | 'invalid' | 'unavailable'

export class AiError extends Error {
	constructor(
		public code: AiErrorCode,
		message: string,
		public provider: string,
		public status?: number,
		/** Seconds, from Retry-After, when the provider sent one. */
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

/** The human part of a provider error body ({error: {message}} or {message} or {detail}). */
function bodyMessage(body: string): string {
	try {
		const j = JSON.parse(body)
		const m = j?.error?.message ?? j?.message ?? j?.detail ?? (typeof j?.error === 'string' ? j.error : undefined)
		if (typeof m === 'string') return m
		if (m !== undefined) return JSON.stringify(m)
	} catch {}
	return body
}

// Quota is not always a 402: OpenAI answers 429 insufficient_quota, Anthropic
// 400 "credit balance is too low". Retrying those never helps, so they are budget.
const QUOTA = /insufficient[_ ]quota|credit balance|billing|exceeded your current quota|out of credits/i

export function httpError(provider: string, status: number, body: string, headers: Headers, redact: (s: string) => string): AiError {
	const detail = redact(bodyMessage(body)).replace(/\s+/g, ' ').trim().slice(0, 300)
	const msg = `${provider}: HTTP ${status}${detail ? ': ' + detail : ''}`
	if (status === 401 || status === 403) return new AiError('auth', msg, provider, status)
	if (status === 402 || ((status === 429 || status === 400) && QUOTA.test(body))) return new AiError('budget', msg, provider, status)
	if (status === 429) return new AiError('rate_limit', msg, provider, status, parseRetryAfter(headers.get('retry-after')))
	if (status === 408 || status >= 500) return new AiError('unavailable', msg, provider, status, parseRetryAfter(headers.get('retry-after')))
	return new AiError('invalid', msg, provider, status)
}

/** Replaces the key (and any Bearer token) by "***" in text that may end up in logs. */
export function redactor(apiKey?: string): (s: string) => string {
	return (s) => {
		let out = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***')
		if (apiKey && apiKey.length >= 4) out = out.split(apiKey).join('***')
		return out
	}
}
