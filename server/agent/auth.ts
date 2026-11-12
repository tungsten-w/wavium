// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Who is calling: Bun forwards the caller's own auth headers to PHP
// (GET /ocs/v2.php/core/atrium/agent/whoami) and caches the answer ~60 s,
// so PHP stays the one place that checks passwords, tokens and sessions.
import type { PhpCaller } from './phpcall'
import { AgentError, sha256Hex } from './util'

export interface Caller {
	uid: string
	displayName: string
	isAgent: boolean
	/** The request used an agent token (not a password or a full app password). */
	agentToken: boolean
	owner: string | null
}

const TTL_MS = 60_000

export class Auth {
	private cache = new Map<string, { at: number, caller: Caller | null }>()

	constructor(private php: PhpCaller) {}

	/** The caller for these headers, or null when they do not log anyone in. */
	async resolve(headers: Record<string, string>): Promise<Caller | null> {
		const key = sha256Hex(JSON.stringify(headers))
		const hit = this.cache.get(key)
		if (hit && Date.now() - hit.at < TTL_MS) return hit.caller
		let caller: Caller | null = null
		try {
			caller = await this.php.ocs<Caller>('GET', 'core/atrium/agent/whoami', { headers, internal: false })
		} catch (e) {
			if (!(e instanceof AgentError) || e.code !== 'auth') throw e
		}
		if (this.cache.size > 1000) this.cache.clear()
		this.cache.set(key, { at: Date.now(), caller })
		return caller
	}

	/** An agent calling with an agent token (Bearer or Basic). */
	async agent(req: Request): Promise<Caller> {
		const authz = req.headers.get('authorization')
		if (!authz) throw new AgentError('auth', 'Send Authorization: Bearer <agent token>')
		const caller = await this.resolve({ authorization: authz })
		if (!caller) throw new AgentError('auth', 'Invalid or revoked token')
		if (!caller.isAgent) throw new AgentError('forbidden', `${caller.uid} is not an agent account`)
		if (!caller.agentToken) throw new AgentError('forbidden', 'Use an agent token from Settings > Agents, not a password or a full app password')
		return caller
	}

	/**
	 * A person using the web UI (session cookie) or their own app password, for
	 * the owner APIs (Settings > Agents, approvals). Writes need the OCS-APIRequest
	 * header, which a cross-site form cannot send (same CSRF rule as Nextcloud's OCS).
	 */
	async owner(req: Request): Promise<Caller> {
		const headers: Record<string, string> = {}
		for (const name of ['authorization', 'cookie', 'requesttoken']) {
			const v = req.headers.get(name)
			if (v) headers[name] = v
		}
		if (!headers.authorization && !headers.cookie) throw new AgentError('auth', 'Not logged in')
		if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.get('ocs-apirequest') !== 'true') {
			throw new AgentError('forbidden', 'Missing OCS-APIRequest header')
		}
		if (req.headers.get('sec-fetch-site') === 'cross-site') throw new AgentError('forbidden', 'Cross-site request')
		const caller = await this.resolve(headers)
		if (!caller) throw new AgentError('auth', 'Not logged in')
		if (caller.isAgent || caller.agentToken) throw new AgentError('forbidden', 'Agents cannot manage agents')
		return caller
	}

	/** Forget cached answers (after revoking a token). */
	clear(): void {
		this.cache.clear()
	}
}
