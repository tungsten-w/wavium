// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Calls from the agent layer into PHP, straight over FastCGI (no HTTP hop).
// Internal calls carry X-Atrium-Internal (HMAC of the instance secret, see
// lib/private/Agent/InternalAuth.php); outside requests can never send it.
import { servePhp, type PhpTarget } from '../php'
import { AgentError, hmacHex } from './util'

export interface PhpCaller {
	/** OCS call (`/ocs/v2.php/<path>`); returns `ocs.data`. Throws AgentError on failure. */
	ocs<T = unknown>(method: string, path: string, opts?: CallOpts): Promise<T>
	/** App route through index.php (`/index.php/<path>`); returns the parsed JSON body. */
	app<T = unknown>(method: string, path: string, opts?: CallOpts): Promise<T>
	/** Raw response (for binary content). */
	raw(method: string, script: string, pathInfo: string, opts?: CallOpts): Promise<Response>
}

export interface CallOpts {
	query?: Record<string, string | number | undefined>
	body?: unknown
	/** Caller headers to pass through (Authorization, Cookie, ...). */
	headers?: Record<string, string>
	/** Send the internal secret header (default true). */
	internal?: boolean
}

export const internalHeaderValue = (secret: string): string => hmacHex(secret, 'atrium-agent-internal')

export function phpCaller(php: PhpTarget, secret: string, baseUrl: string): PhpCaller {
	const internal = internalHeaderValue(secret)
	const host = new URL(baseUrl).host || 'localhost'

	async function raw(method: string, script: string, pathInfo: string, opts: CallOpts = {}): Promise<Response> {
		const url = new URL(`http://${host}${script}${pathInfo}`)
		for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
		const headers: Record<string, string> = { host, accept: 'application/json', 'ocs-apirequest': 'true', ...opts.headers }
		let body: string | undefined
		if (opts.body !== undefined) {
			body = JSON.stringify(opts.body)
			headers['content-type'] = 'application/json'
			headers['content-length'] = String(Buffer.byteLength(body))
		}
		const req = new Request(url, { method, headers, body })
		return servePhp(php, req, url, script, pathInfo, '127.0.0.1', opts.internal === false ? {} : { internal: { 'X-Atrium-Internal': internal } })
	}

	async function json<T>(res: Response, ocs: boolean): Promise<T> {
		const text = await res.text()
		let parsed: unknown
		try {
			parsed = text === '' ? null : JSON.parse(text)
		} catch {
			throw new AgentError('unavailable', `PHP answered ${res.status} with non-JSON`)
		}
		const data = ocs ? (parsed as { ocs?: { data?: unknown } })?.ocs?.data : parsed
		if (res.status >= 200 && res.status < 300) return data as T
		const message = (data as { message?: string })?.message ?? `PHP answered ${res.status}`
		const reason = (data as { reason?: string })?.reason
		const code = res.status === 400 ? 'invalid_input' : res.status === 401 ? 'auth' : res.status === 403 ? 'forbidden'
			: res.status === 404 ? 'not_found' : res.status === 409 ? 'conflict' : 'unavailable'
		throw new AgentError(code, message, reason)
	}

	return {
		raw,
		ocs: async (method, path, opts) => json(await raw(method, '/ocs/v2.php', '/' + path.replace(/^\//, ''), { ...opts, query: { format: 'json', ...opts?.query } }), true),
		app: async (method, path, opts) => json(await raw(method, '/index.php', '/' + path.replace(/^\//, ''), opts), false),
	}
}
