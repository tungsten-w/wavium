// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Who is calling: Bun forwards the caller's own auth headers to PHP
// (GET /ocs/v2.php/core/atrium/agent/whoami) and caches the answer up to 60 s,
// so PHP stays the one place that checks passwords, tokens and sessions.
//
// Revocation: every token, app password and web session is a row of
// <prefix>authtoken, and revoking, logging out, wiping or deleting a user
// deletes or changes rows there; disabling a user sets core/enabled=false.
// The cache keeps a cheap fingerprint of those (authFingerprint), re-read at
// most once a second, and drops every cached answer when it changes. So a
// revoked token is refused within ~1 s, whichever page or command revoked it.
import type { Db } from './db'
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
/** How often the revocation fingerprint is re-read. */
const FINGERPRINT_MS = 1_000
/** Cache lifetime when the fingerprint cannot be read (DB down, old schema). */
const FALLBACK_TTL_MS = 5_000

/** Changes whenever a token/session is added, removed or changed, or a user is disabled. */
export async function authFingerprint(db: Db): Promise<string> {
	const [tok] = await db.q<{ n: unknown, m: unknown, t: unknown }>(
		`SELECT count(*) AS n, coalesce(max(id), 0) AS m, coalesce(sum(type), 0) AS t FROM ${db.t('authtoken')}`)
	const [off] = await db.q<{ n: unknown }>(
		`SELECT count(*) AS n FROM ${db.t('preferences')} WHERE appid = 'core' AND configkey = 'enabled' AND configvalue = 'false'`)
	return `${tok.n}/${tok.m}/${tok.t}/${off.n}`
}

export class Auth {
	private cache = new Map<string, { at: number, caller: Caller | null }>()
	private fp: { at: number, value: string | null } = { at: 0, value: null }
	private fpPending: Promise<boolean> | null = null

	/** `fingerprint`: see authFingerprint; without it, answers live 5 s. */
	constructor(private php: PhpCaller, private fingerprint?: () => Promise<string>, private now: () => number = Date.now) {}

	/** Re-reads the fingerprint (at most once a second); clears the cache on change. False = unknown. */
	private async fresh(): Promise<boolean> {
		if (!this.fingerprint) return false
		if (this.now() - this.fp.at < FINGERPRINT_MS) return this.fp.value !== null
		this.fpPending ??= (async () => {
			let value: string | null = null
			try {
				value = await this.fingerprint!()
			} catch (e) {
				console.error(`agent auth fingerprint: ${(e as Error).message}`)
			}
			if (value === null || value !== this.fp.value) this.cache.clear()
			this.fp = { at: this.now(), value }
			return value !== null
		})().finally(() => { this.fpPending = null })
		return this.fpPending
	}

	/** The caller for these headers, or null when they do not log anyone in. */
	async resolve(headers: Record<string, string>): Promise<Caller | null> {
		const key = sha256Hex(JSON.stringify(headers))
		const ttl = (await this.fresh()) ? TTL_MS : FALLBACK_TTL_MS
		const hit = this.cache.get(key)
		if (hit && this.now() - hit.at < ttl) return hit.caller
		let caller: Caller | null = null
		try {
			caller = await this.php.ocs<Caller>('GET', 'core/atrium/agent/whoami', { headers, internal: false })
		} catch (e) {
			if (!(e instanceof AgentError) || e.code !== 'auth') throw e
		}
		if (this.cache.size > 1000) this.cache.clear()
		this.cache.set(key, { at: this.now(), caller })
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
