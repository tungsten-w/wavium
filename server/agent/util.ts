// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Small shared helpers for the agent layer: errors, ids, times, HMAC.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export type ErrorCode = 'invalid_input' | 'forbidden' | 'not_found' | 'conflict' | 'unavailable' | 'auth'

const STATUS: Record<ErrorCode, number> = {
	invalid_input: 400,
	auth: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	unavailable: 503,
}

/** A tool or API error with a stable code (ADR 0009: `{error: {code, reason?, message}}`). */
export class AgentError extends Error {
	constructor(public code: ErrorCode, message: string, public reason?: string) {
		super(message)
	}

	get status(): number {
		return STATUS[this.code]
	}

	toJSON() {
		return { error: { code: this.code, ...(this.reason ? { reason: this.reason } : {}), message: this.message } }
	}
}

export const errorResponse = (e: AgentError): Response => Response.json(e.toJSON(), { status: e.status })

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** ULID-like id: time-sortable, 26 chars, e.g. "01J9Z3...". */
export function ulid(at = Date.now()): string {
	let time = ''
	let t = at
	for (let i = 0; i < 10; i++) {
		time = CROCKFORD[t % 32] + time
		t = Math.floor(t / 32)
	}
	const rand = randomBytes(16)
	let tail = ''
	for (let i = 0; i < 16; i++) tail += CROCKFORD[rand[i] % 32]
	return time + tail
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url')

export const nowSec = (): number => Math.floor(Date.now() / 1000)

/** Unix seconds -> "2026-11-08T10:00:03Z" (null stays null). */
export function iso(sec: number | string | null | undefined): string | null {
	if (sec === null || sec === undefined || sec === '') return null
	return new Date(Number(sec) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** ISO date/time -> unix seconds, or null if it does not parse. */
export function parseIso(s: string): number | null {
	const ms = Date.parse(s)
	return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

export const hmacHex = (key: string, data: string): string => createHmac('sha256', key).update(data).digest('hex')

export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a)
	const y = Buffer.from(b)
	return x.length === y.length && timingSafeEqual(x, y)
}

export const sha256Hex = (data: string): string => new Bun.CryptoHasher('sha256').update(data).digest('hex')

/** Stable JSON (sorted keys) for hashing frozen payloads. */
export function stableJson(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v)
	if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']'
	const o = v as Record<string, unknown>
	return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}'
}

export const round2 = (n: unknown): number | null => (n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100)
