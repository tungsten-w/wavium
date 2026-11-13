// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Request limits of the Bun web server, from the environment.
//
// - ATRIUM_MAX_BODY: largest request body (uploads). Same syntax as PHP sizes
//   ("10G", "512M", "1024K", bytes). Defaults to PHP_UPLOAD_LIMIT, else 10G, so
//   Bun never refuses what PHP would accept. "0" = no limit. Bigger bodies get 413.
// - ATRIUM_IDLE_TIMEOUT: seconds a connection may send/receive nothing before it
//   is closed (slow or stuck clients). 1..255 (Bun's maximum), default 60.
// - ATRIUM_PHP_TIMEOUT: idle seconds allowed while PHP (or the agent layer) works
//   on a request whose body was fully received. Default 0 = no idle cut there:
//   PHP-FPM's request_terminate_timeout bounds it. Otherwise 1..255.

export interface Limits {
	maxBody: number
	idleTimeout: number
	phpTimeout: number
}

const UNITS: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }

/** "10G" -> bytes. "0" -> Infinity (no limit). Throws on anything else. */
export function parseSize(text: string): number {
	const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)b?\s*$/i.exec(text)
	if (!m) throw new Error(`not a size: "${text}" (examples: 10G, 512M, 1048576)`)
	const n = Math.floor(Number(m[1]) * UNITS[m[2].toLowerCase()])
	return n === 0 ? Infinity : n
}

function seconds(name: string, text: string | undefined, fallback: number, allowZero: boolean): number {
	if (text === undefined || text.trim() === '') return fallback
	const n = Number(text)
	if (!Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > 255) {
		throw new Error(`${name} must be a whole number of seconds, ${allowZero ? 0 : 1}..255 (got "${text}")`)
	}
	return n
}

export function loadLimits(env: Record<string, string | undefined> = process.env): Limits {
	const size = env.ATRIUM_MAX_BODY?.trim() || env.PHP_UPLOAD_LIMIT?.trim() || '10G'
	let maxBody: number
	try {
		maxBody = parseSize(size)
	} catch (e) {
		throw new Error(`ATRIUM_MAX_BODY: ${(e as Error).message}`)
	}
	return {
		// Bun wants a number: "no limit" is the largest safe integer.
		maxBody: Number.isFinite(maxBody) ? maxBody : Number.MAX_SAFE_INTEGER,
		idleTimeout: seconds('ATRIUM_IDLE_TIMEOUT', env.ATRIUM_IDLE_TIMEOUT, 60, false),
		phpTimeout: seconds('ATRIUM_PHP_TIMEOUT', env.ATRIUM_PHP_TIMEOUT, 0, true),
	}
}
