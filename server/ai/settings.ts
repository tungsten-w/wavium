// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > AI (PLAN P2-2): the AI providers Atrium may call, stored in
// `<prefix>atrium_ai_providers`.
//
// - Two scopes: the instance (set by an admin, usable by every user) and one
//   user (their own key). An admin can turn personal providers off.
// - API keys are encrypted at rest (AES-256-GCM, key derived from the instance
//   secret, bound to the provider id) and never sent back: the UI gets
//   `hasKey` and the last 4 characters.
// - A personal provider's base URL may not point to the server's own network
//   (same guard as agent webhooks, P1-5), checked when saved and before every
//   request. Instance providers are trusted (an admin may use a LAN Ollama).
// - The mock provider is offered only when ATRIUM_AI_MOCK=1 (dev stack, tests).
//
// Features (triage, summaries...) call `config(uid)` or `provider(uid)`.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { Db } from '../agent/db'
import { assertPublicWebhook, BlockedWebhook, type WebhookPolicy, webhookPolicy } from '../agent/netguard'
import { AiError } from './errors'
import { createProvider, KINDS, resolveConfig } from './index'
import type { AiProvider, ConnectionTest, FetchFn, ProviderConfig, ProviderKind } from './types'

export type Scope = 'instance' | 'user'

/** What the settings page sees. Never holds the key. */
export interface ProviderView {
	id: string
	scope: Scope
	label: string
	kind: ProviderKind
	/** Instance providers: shown to admins only (it may name internal hosts). */
	baseUrl: string | null
	defaultModel: string | null
	/** Models offered to the features (empty = any). */
	models: string[]
	enabled: boolean
	hasKey: boolean
	/** Last 4 characters of the key, for keys long enough to keep it secret. */
	keyHint: string | null
	updatedAt: number
	/** The caller may edit or delete it. */
	editable: boolean
}

/** A usable provider, key decrypted: for the server only. */
export interface StoredProvider extends ProviderConfig {
	id: string
	scope: Scope
	owner: string | null
	label: string
	models: string[]
}

export interface ResolvedAiConfig {
	providers: StoredProvider[]
	/** The user's choice, else the instance default, else the first usable one. */
	defaultProvider: string | null
}

export interface ProviderInput {
	scope?: Scope
	label?: unknown
	kind?: unknown
	baseUrl?: unknown
	/** string = set, null = remove, undefined = keep. */
	apiKey?: unknown
	defaultModel?: unknown
	models?: unknown
	enabled?: unknown
}

export interface AiCaller { uid: string, isAdmin: boolean }

/** A refusal meant for the settings page (maps to HTTP 400/403/404). */
export class AiSettingsError extends Error {
	constructor(public code: 'invalid_input' | 'forbidden' | 'not_found', message: string) {
		super(message)
	}
}

const MAX_PROVIDERS = 20
const MAX_MODELS = 50
const MAX_KEY = 4096

// --- Key encryption -----------------------------------------------------------

export interface KeyCipher {
	seal(plain: string, id: string): string
	open(sealed: string, id: string): string
}

/**
 * AES-256-GCM with a key derived (HKDF-SHA256) from the instance secret.
 * Format `v1:<base64 iv|ciphertext|tag>`. The provider id is the associated
 * data: a sealed key copied to another row does not open.
 */
export function keyCipher(secret: string): KeyCipher {
	if (!secret) throw new Error('keyCipher: empty instance secret')
	const key = Buffer.from(hkdfSync('sha256', secret, 'atrium', 'atrium-ai-keys/v1', 32))
	return {
		seal(plain, id) {
			const iv = randomBytes(12)
			const c = createCipheriv('aes-256-gcm', key, iv)
			c.setAAD(Buffer.from(id))
			const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
			return 'v1:' + Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')
		},
		open(sealed, id) {
			if (!sealed.startsWith('v1:')) throw new Error('unknown key format')
			const raw = Buffer.from(sealed.slice(3), 'base64')
			if (raw.length < 28) throw new Error('sealed key too short')
			const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
			d.setAAD(Buffer.from(id))
			d.setAuthTag(raw.subarray(raw.length - 16))
			return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8')
		},
	}
}

/** Last 4 characters, only for keys of 16+ characters (else nothing). */
export const keyHint = (key: string): string | null => (key.length >= 16 ? key.slice(-4) : null)

// --- Guard for personal providers ---------------------------------------------

/** ATRIUM_AI_ALLOW: same syntax as ATRIUM_WEBHOOK_ALLOW (hosts, *.suffix, CIDR). */
export const aiPolicy = (allow = process.env.ATRIUM_AI_ALLOW): WebhookPolicy => webhookPolicy(allow)

async function assertPublicBase(url: string, policy: WebhookPolicy, unresolvedOk: boolean): Promise<void> {
	try {
		await assertPublicWebhook(url, policy, { unresolvedOk })
	} catch (e) {
		if (!(e instanceof BlockedWebhook)) throw e
		throw new AiSettingsError('invalid_input', e.message.replace('webhook URL', 'base URL')
			.replace('ATRIUM_WEBHOOK_ALLOW', 'ATRIUM_AI_ALLOW, or add the provider for the whole instance'))
	}
}

/** fetch that re-checks every URL (DNS may change after saving). */
export function guardedFetch(policy: WebhookPolicy, inner: FetchFn): FetchFn {
	return async (url, init) => {
		try {
			await assertPublicWebhook(url, policy)
		} catch (e) {
			const msg = e instanceof BlockedWebhook ? e.message.replace('webhook URL', 'base URL') : 'base URL host does not resolve'
			throw new AiError('invalid', msg, 'ai')
		}
		return inner(url, init)
	}
}

// --- Store ---------------------------------------------------------------------

interface Row {
	id: string
	owner_uid: string
	label: string
	kind: string
	base_url: string | null
	default_model: string | null
	models: string | null
	key_enc: string | null
	key_hint: string | null
	enabled: unknown
	created_at: unknown
	updated_at: unknown
}

const num = (v: unknown) => Number(v ?? 0)
const bool = (v: unknown) => v === true || v === 1 || v === '1' || v === 't' || v === 'true'

export interface AiSettingsOptions {
	/** Offer the mock kind (ATRIUM_AI_MOCK=1). */
	allowMock?: boolean
	policy?: WebhookPolicy
	fetch?: FetchFn
	now?: () => number
}

export class AiSettings {
	private ready: Promise<void> | null = null
	private cipher: KeyCipher
	private allowMock: boolean
	private policy: WebhookPolicy
	private fetch: FetchFn
	private now: () => number

	constructor(private db: Db, secret: string, opts: AiSettingsOptions = {}) {
		this.cipher = keyCipher(secret)
		this.allowMock = opts.allowMock ?? process.env.ATRIUM_AI_MOCK === '1'
		this.policy = opts.policy ?? aiPolicy()
		this.fetch = opts.fetch ?? ((u, init) => fetch(u, init))
		this.now = opts.now ?? Date.now
	}

	private T = (n: string) => this.db.t(n)

	/** Creates the tables (idempotent); every public method waits for it. */
	migrate(): Promise<void> {
		this.ready ??= (async () => {
			await this.db.q(`CREATE TABLE IF NOT EXISTS ${this.T('atrium_ai_providers')} (
				id VARCHAR(32) PRIMARY KEY,
				owner_uid VARCHAR(64) NOT NULL,
				label VARCHAR(100) NOT NULL,
				kind VARCHAR(32) NOT NULL,
				base_url TEXT NULL,
				default_model VARCHAR(200) NULL,
				models TEXT NULL,
				key_enc TEXT NULL,
				key_hint VARCHAR(8) NULL,
				enabled SMALLINT NOT NULL DEFAULT 1,
				created_at BIGINT NOT NULL,
				updated_at BIGINT NOT NULL)`)
			await this.db.q(`CREATE INDEX IF NOT EXISTS ${this.T('atrium_ai_providers_owner')} ON ${this.T('atrium_ai_providers')} (owner_uid)`)
			// owner_uid '' = instance-wide.
			await this.db.q(`CREATE TABLE IF NOT EXISTS ${this.T('atrium_ai_prefs')} (
				owner_uid VARCHAR(64) NOT NULL,
				k VARCHAR(64) NOT NULL,
				v TEXT NOT NULL,
				PRIMARY KEY (owner_uid, k))`)
		})().catch((e) => { this.ready = null; throw e })
		return this.ready
	}

	/** Kinds offered on the settings page. */
	kinds(): Array<{ kind: ProviderKind, baseUrl: string | null, needsKey: boolean }> {
		return (Object.keys(KINDS) as ProviderKind[])
			.filter((k) => k !== 'mock' || this.allowMock)
			.map((k) => ({ kind: k, baseUrl: KINDS[k].baseUrl ?? null, needsKey: KINDS[k].needsKey }))
	}

	async isAdmin(uid: string): Promise<boolean> {
		const rows = await this.db.q(`SELECT 1 AS x FROM ${this.T('group_user')} WHERE gid = 'admin' AND uid = $1`, [uid])
		return rows.length > 0
	}

	private async pref(owner: string, k: string): Promise<string | null> {
		const rows = await this.db.q<{ v: string }>(`SELECT v FROM ${this.T('atrium_ai_prefs')} WHERE owner_uid = $1 AND k = $2`, [owner, k])
		return rows[0]?.v ?? null
	}

	private async setPref(owner: string, k: string, v: string | null): Promise<void> {
		if (v === null) {
			await this.db.q(`DELETE FROM ${this.T('atrium_ai_prefs')} WHERE owner_uid = $1 AND k = $2`, [owner, k])
			return
		}
		await this.db.q(`INSERT INTO ${this.T('atrium_ai_prefs')} (owner_uid, k, v) VALUES ($1, $2, $3)
			ON CONFLICT (owner_uid, k) DO UPDATE SET v = excluded.v`, [owner, k, v])
	}

	/** Admin switch: may users add their own providers? (default yes) */
	async personalAllowed(): Promise<boolean> {
		await this.migrate()
		return (await this.pref('', 'personal_providers')) !== '0'
	}

	private async rows(where: string, params: unknown[]): Promise<Row[]> {
		return this.db.q<Row>(`SELECT * FROM ${this.T('atrium_ai_providers')} WHERE ${where} ORDER BY CASE WHEN owner_uid = '' THEN 0 ELSE 1 END, created_at, id`, params)
	}

	private view(r: Row, caller: AiCaller): ProviderView {
		const scope: Scope = r.owner_uid === '' ? 'instance' : 'user'
		const editable = scope === 'instance' ? caller.isAdmin : r.owner_uid === caller.uid
		return {
			id: r.id,
			scope,
			label: r.label,
			kind: r.kind as ProviderKind,
			baseUrl: scope === 'user' || caller.isAdmin ? r.base_url : null,
			defaultModel: r.default_model,
			models: r.models ? JSON.parse(r.models) as string[] : [],
			enabled: bool(r.enabled),
			hasKey: !!r.key_enc,
			keyHint: r.key_hint,
			updatedAt: num(r.updated_at),
			editable,
		}
	}

	/** Everything the settings page shows for this caller. */
	async overview(caller: AiCaller) {
		await this.migrate()
		const [instance, mine, personal, userDefault, instanceDefault] = await Promise.all([
			this.rows(`owner_uid = ''`, []),
			this.rows('owner_uid = $1', [caller.uid]),
			this.personalAllowed(),
			this.pref(caller.uid, 'default_provider'),
			this.pref('', 'default_provider'),
		])
		const resolved = await this.config(caller.uid)
		return {
			isAdmin: caller.isAdmin,
			personalProviders: personal,
			kinds: this.kinds(),
			instance: instance.map((r) => this.view(r, caller)),
			mine: mine.map((r) => this.view(r, caller)),
			defaultProvider: userDefault,
			instanceDefault,
			effectiveDefault: resolved.defaultProvider,
		}
	}

	private async owned(caller: AiCaller, id: string): Promise<Row> {
		const [r] = await this.rows('id = $1', [id])
		if (!r) throw new AiSettingsError('not_found', `No AI provider ${id}`)
		if (r.owner_uid === '' ? !caller.isAdmin : r.owner_uid !== caller.uid) {
			// Someone else's personal provider looks absent; an instance one is visible but read-only.
			if (r.owner_uid !== '') throw new AiSettingsError('not_found', `No AI provider ${id}`)
			throw new AiSettingsError('forbidden', 'Only an admin can change instance-wide providers')
		}
		return r
	}

	/** Checks and normalises input; `prev` = the row being edited. Returns columns + the plain key to store. */
	private async check(input: ProviderInput, scope: Scope, prev: Row | null) {
		const str = (v: unknown, name: string, max: number): string | null => {
			if (v === undefined || v === null) return null
			if (typeof v !== 'string') throw new AiSettingsError('invalid_input', `${name} must be a string`)
			const s = v.trim()
			if (s.length > max) throw new AiSettingsError('invalid_input', `${name} is too long (max ${max})`)
			return s || null
		}
		const kind = (input.kind === undefined && prev ? prev.kind : str(input.kind, 'kind', 32)) as ProviderKind | null
		if (!kind || !(kind in KINDS)) throw new AiSettingsError('invalid_input', `kind must be one of ${Object.keys(KINDS).join(', ')}`)
		if (kind === 'mock' && !this.allowMock && prev?.kind !== 'mock') throw new AiSettingsError('invalid_input', 'The mock provider is only available on test instances')
		const label = (input.label === undefined && prev ? prev.label : str(input.label, 'label', 100)) ?? kind
		const baseUrl = input.baseUrl === undefined && prev ? prev.base_url : str(input.baseUrl, 'baseUrl', 2000)
		const defaultModel = input.defaultModel === undefined && prev ? prev.default_model : str(input.defaultModel, 'defaultModel', 200)
		let models: string[]
		if (input.models === undefined) models = prev?.models ? JSON.parse(prev.models) as string[] : []
		else {
			const list = typeof input.models === 'string' ? input.models.split(/[\s,]+/) : input.models
			if (!Array.isArray(list)) throw new AiSettingsError('invalid_input', 'models must be a list of model names')
			models = [...new Set(list.map((m) => str(m, 'model', 200)).filter((m): m is string => !!m))]
			if (models.length > MAX_MODELS) throw new AiSettingsError('invalid_input', `At most ${MAX_MODELS} models`)
		}
		const enabled = input.enabled === undefined ? (prev ? bool(prev.enabled) : true) : input.enabled === true
		// Key: undefined keeps, null/'' removes, a string replaces.
		let newKey: string | null | undefined
		if (input.apiKey === undefined) newKey = undefined
		else if (input.apiKey === null || input.apiKey === '') newKey = null
		else if (typeof input.apiKey !== 'string' || input.apiKey.trim().length > MAX_KEY) throw new AiSettingsError('invalid_input', 'apiKey must be a string')
		else newKey = input.apiKey.trim()
		if (prev && newKey === undefined && kind !== prev.kind && prev.key_enc) {
			// A key never follows a provider to another vendor by accident.
			throw new AiSettingsError('invalid_input', 'Enter the API key again when changing the provider kind')
		}
		const hasKey = newKey === undefined ? !!prev?.key_enc : newKey !== null
		// Same checks as at call time (kind, key presence, URL shape), with a stand-in key.
		if (kind !== 'mock') try {
			resolveConfig({ kind, baseUrl: baseUrl ?? undefined, apiKey: hasKey ? 'x' : undefined, id: label })
		} catch (e) {
			throw new AiSettingsError('invalid_input', e instanceof Error ? e.message : String(e))
		}
		if (scope === 'user' && kind !== 'mock') {
			await assertPublicBase(baseUrl || KINDS[kind].baseUrl!, this.policy, true)
		}
		return { kind, label, baseUrl, defaultModel, models, enabled, newKey }
	}

	async create(caller: AiCaller, input: ProviderInput): Promise<ProviderView> {
		await this.migrate()
		const scope: Scope = input.scope === 'instance' ? 'instance' : 'user'
		if (scope === 'instance' && !caller.isAdmin) throw new AiSettingsError('forbidden', 'Only an admin can add instance-wide providers')
		if (scope === 'user' && !(await this.personalAllowed())) throw new AiSettingsError('forbidden', 'Personal AI providers are turned off on this instance')
		const owner = scope === 'instance' ? '' : caller.uid
		const [{ n }] = await this.db.q<{ n: unknown }>(`SELECT count(*) AS n FROM ${this.T('atrium_ai_providers')} WHERE owner_uid = $1`, [owner])
		if (num(n) >= MAX_PROVIDERS) throw new AiSettingsError('invalid_input', `At most ${MAX_PROVIDERS} providers`)
		const c = await this.check(input, scope, null)
		const id = 'aip_' + randomBytes(9).toString('base64url')
		const now = this.now()
		await this.db.q(`INSERT INTO ${this.T('atrium_ai_providers')}
			(id, owner_uid, label, kind, base_url, default_model, models, key_enc, key_hint, enabled, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`, [
			id, owner, c.label, c.kind, c.baseUrl, c.defaultModel, JSON.stringify(c.models),
			c.newKey ? this.cipher.seal(c.newKey, id) : null, c.newKey ? keyHint(c.newKey) : null, c.enabled ? 1 : 0, now,
		])
		const [r] = await this.rows('id = $1', [id])
		return this.view(r, caller)
	}

	async update(caller: AiCaller, id: string, input: ProviderInput): Promise<ProviderView> {
		await this.migrate()
		const prev = await this.owned(caller, id)
		const c = await this.check(input, prev.owner_uid === '' ? 'instance' : 'user', prev)
		const keyCols = c.newKey === undefined ? [prev.key_enc, prev.key_hint]
			: c.newKey === null ? [null, null] : [this.cipher.seal(c.newKey, id), keyHint(c.newKey)]
		// Placeholders in order of appearance: Bun's SQLite binds them that way.
		await this.db.q(`UPDATE ${this.T('atrium_ai_providers')} SET label = $1, kind = $2, base_url = $3, default_model = $4,
			models = $5, key_enc = $6, key_hint = $7, enabled = $8, updated_at = $9 WHERE id = $10`, [
			c.label, c.kind, c.baseUrl, c.defaultModel, JSON.stringify(c.models), keyCols[0], keyCols[1], c.enabled ? 1 : 0, this.now(), id,
		])
		const [r] = await this.rows('id = $1', [id])
		return this.view(r, caller)
	}

	async remove(caller: AiCaller, id: string): Promise<void> {
		await this.migrate()
		await this.owned(caller, id)
		await this.db.q(`DELETE FROM ${this.T('atrium_ai_providers')} WHERE id = $1`, [id])
		// Forget it as a default.
		await this.db.q(`DELETE FROM ${this.T('atrium_ai_prefs')} WHERE k = 'default_provider' AND v = $1`, [id])
	}

	/** Personal choice of default provider (null = follow the instance). */
	async setDefault(caller: AiCaller, id: string | null, scope: Scope = 'user'): Promise<void> {
		await this.migrate()
		if (scope === 'instance' && !caller.isAdmin) throw new AiSettingsError('forbidden', 'Only an admin can set the instance default')
		if (id !== null) {
			const [r] = await this.rows('id = $1', [id])
			const visible = r && (r.owner_uid === '' || (scope === 'user' && r.owner_uid === caller.uid))
			if (!visible) throw new AiSettingsError('not_found', `No AI provider ${id}`)
		}
		await this.setPref(scope === 'instance' ? '' : caller.uid, 'default_provider', id)
	}

	async setPersonalAllowed(caller: AiCaller, on: boolean): Promise<void> {
		await this.migrate()
		if (!caller.isAdmin) throw new AiSettingsError('forbidden', 'Only an admin can change this')
		await this.setPref('', 'personal_providers', on ? '1' : '0')
	}

	private stored(r: Row): StoredProvider {
		let apiKey: string | undefined
		if (r.key_enc) {
			try {
				apiKey = this.cipher.open(r.key_enc, r.id)
			} catch {
				// Instance secret changed or row tampered with: unusable until the key is entered again.
				apiKey = undefined
			}
		}
		return {
			id: r.id,
			scope: r.owner_uid === '' ? 'instance' : 'user',
			owner: r.owner_uid || null,
			label: r.label,
			kind: r.kind as ProviderKind,
			baseUrl: r.base_url ?? undefined,
			apiKey,
			defaultModel: r.default_model ?? undefined,
			models: r.models ? JSON.parse(r.models) as string[] : [],
		}
	}

	/** The providers `uid` may use (enabled, key decrypted) and their default. For server code only. */
	async config(uid: string): Promise<ResolvedAiConfig> {
		await this.migrate()
		const personal = await this.personalAllowed()
		const rows = personal ? await this.rows(`owner_uid = '' OR owner_uid = $1`, [uid]) : await this.rows(`owner_uid = ''`, [])
		const providers = rows.filter((r) => bool(r.enabled) && (r.kind !== 'mock' || this.allowMock)).map((r) => this.stored(r))
			// A provider that needs a key and has none (or cannot be decrypted) is not usable.
			.filter((p) => !KINDS[p.kind]?.needsKey || !!p.apiKey)
		const ids = new Set(providers.map((p) => p.id))
		const [mine, inst] = await Promise.all([this.pref(uid, 'default_provider'), this.pref('', 'default_provider')])
		const defaultProvider = [mine, inst].find((x) => x !== null && ids.has(x))
			?? providers.find((p) => p.scope === 'instance')?.id ?? providers[0]?.id ?? null
		return { providers, defaultProvider }
	}

	private build(p: ProviderConfig & { scope: Scope }): AiProvider {
		const f = p.scope === 'user' && p.kind !== 'mock' ? guardedFetch(this.policy, this.fetch) : this.fetch
		return createProvider(p, { fetch: f })
	}

	/** A ready provider for `uid`: the given id or their default. Null when none is set up. */
	async provider(uid: string, id?: string): Promise<AiProvider | null> {
		const { providers, defaultProvider } = await this.config(uid)
		const p = providers.find((x) => x.id === (id ?? defaultProvider))
		return p ? this.build(p) : null
	}

	/**
	 * "Test connection": lists the models (never spends tokens). Tests a saved
	 * provider, or a draft from the form; a draft that edits a saved one may
	 * leave the key out to reuse the stored key.
	 */
	async test(caller: AiCaller, input: ProviderInput & { id?: unknown }): Promise<ConnectionTest> {
		await this.migrate()
		const prev = typeof input.id === 'string' && input.id ? await this.owned(caller, input.id) : null
		const scope: Scope = prev ? (prev.owner_uid === '' ? 'instance' : 'user') : input.scope === 'instance' ? 'instance' : 'user'
		if (!prev && scope === 'instance' && !caller.isAdmin) throw new AiSettingsError('forbidden', 'Only an admin can add instance-wide providers')
		let c: Awaited<ReturnType<AiSettings['check']>>
		try {
			c = await this.check(input, scope, prev)
		} catch (e) {
			if (e instanceof AiSettingsError && e.code === 'invalid_input') return { ok: false, error: { code: 'invalid', message: e.message } }
			throw e
		}
		const apiKey = c.newKey === undefined ? (prev ? this.stored(prev).apiKey : undefined) : c.newKey ?? undefined
		let provider: AiProvider
		try {
			provider = this.build({ kind: c.kind, id: c.label, baseUrl: c.baseUrl ?? undefined, apiKey, defaultModel: c.defaultModel ?? undefined, scope, timeoutMs: 15_000 })
		} catch (e) {
			return { ok: false, error: { code: 'invalid', message: e instanceof Error ? e.message : String(e) } }
		}
		const res = await provider.testConnection()
		// Long lists (OpenRouter: hundreds) are cut for the page.
		if (res.models && res.models.length > 500) res.models = res.models.slice(0, 500)
		return res
	}
}
