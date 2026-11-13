// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What an agent may do (ADR 0009 section 1): per grantor and area, one mode per
// action: off, allowed, or approval (only delete/send/share can need approval).
// Plus the agent-wide settings (paused, wakes, webhook, approval pings).
import { type Db, bool, num } from './db'
import { assertPublicWebhook, BlockedWebhook, type WebhookPolicy, webhookPolicy } from './netguard'
import { AgentError, nowSec, randomToken } from './util'

export type Action = 'read' | 'write' | 'delete' | 'send' | 'share'
export type Mode = 'off' | 'allowed' | 'approval'
export type Modes = Partial<Record<Action, Mode>>

export const ACTIONS: Action[] = ['read', 'write', 'delete', 'send', 'share']
const GATEABLE: Action[] = ['delete', 'send', 'share']

/**
 * Clean a modes object for an area that has `available` actions: unknown
 * actions dropped, read/write never "approval", write implies read, and
 * delete/send/share left out mean "approval" (the safe default).
 */
export function normalizeModes(input: Record<string, unknown>, available: Action[]): Required<Pick<Modes, Action>> & Modes {
	const out: Modes = {}
	for (const action of available) {
		const v = input[action]
		let mode: Mode = v === 'allowed' || v === 'approval' ? v : v === 'off' ? 'off'
			: GATEABLE.includes(action) ? 'approval' : 'off'
		if (!GATEABLE.includes(action) && mode === 'approval') mode = 'allowed'
		out[action] = mode
	}
	if (out.write === 'allowed' && 'read' in out) out.read = 'allowed'
	// Without read nothing else makes sense (the agent does not even see the tools).
	if (out.read !== 'allowed') for (const a of available) out[a] = 'off'
	return out as never
}

export function modeOf(modes: Modes | undefined, action: Action): Mode {
	return modes?.[action] ?? 'off'
}

export type AccessMap = Record<string, Modes>

export async function getAccess(db: Db, agent: string, grantor: string): Promise<AccessMap> {
	const rows = await db.q<{ area: string, modes: string }>(
		`SELECT area, modes FROM ${db.t('atrium_agent_access')} WHERE agent_uid = $1 AND grantor_uid = $2`, [agent, grantor])
	const out: AccessMap = {}
	for (const r of rows) {
		try { out[r.area] = JSON.parse(r.modes) } catch { /* broken row: no access */ }
	}
	return out
}

/** Every grantor that gave this agent read access to an area. */
export async function grantorsFor(db: Db, agent: string): Promise<Map<string, AccessMap>> {
	const rows = await db.q<{ grantor_uid: string, area: string, modes: string }>(
		`SELECT grantor_uid, area, modes FROM ${db.t('atrium_agent_access')} WHERE agent_uid = $1`, [agent])
	const out = new Map<string, AccessMap>()
	for (const r of rows) {
		let modes: Modes
		try { modes = JSON.parse(r.modes) } catch { continue }
		if (!out.has(r.grantor_uid)) out.set(r.grantor_uid, {})
		out.get(r.grantor_uid)![r.area] = modes
	}
	return out
}

export async function setAccess(db: Db, agent: string, grantor: string, area: string, modes: Modes | null): Promise<void> {
	const T = db.t('atrium_agent_access')
	if (modes === null || modes.read !== 'allowed') {
		await db.q(`DELETE FROM ${T} WHERE agent_uid = $1 AND grantor_uid = $2 AND area = $3`, [agent, grantor, area])
		return
	}
	await db.q(`INSERT INTO ${T} (agent_uid, grantor_uid, area, modes, updated_at) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (agent_uid, grantor_uid, area) DO UPDATE SET modes = excluded.modes, updated_at = excluded.updated_at`,
	[agent, grantor, area, JSON.stringify(modes), nowSec()])
}

export async function dropAgent(db: Db, agent: string): Promise<void> {
	await db.q(`DELETE FROM ${db.t('atrium_agent_access')} WHERE agent_uid = $1`, [agent])
	await db.q(`DELETE FROM ${db.t('atrium_agent_settings')} WHERE uid = $1`, [agent])
}

/** Token scopes matching the "allowed" cells (approval cells stay out: DAV/OCS cannot ask). */
export function tokenScopes(access: AccessMap): string[] {
	const out: string[] = []
	for (const [area, modes] of Object.entries(access)) {
		for (const action of ACTIONS) if (modes[action] === 'allowed') out.push(`${area}:${action}`)
	}
	return out.sort()
}

export type Preset = 'mail' | 'todo' | 'everything'

/** Presets of the settings page. Unknown areas in `areas` are skipped. */
export function presetAccess(preset: Preset, areas: Record<string, Action[]>): AccessMap {
	const pick = preset === 'mail' ? ['mail'] : preset === 'todo' ? ['daily_todo'] : Object.keys(areas)
	const out: AccessMap = {}
	for (const area of pick) {
		const available = areas[area]
		if (!available) continue
		out[area] = normalizeModes({ read: 'allowed', write: 'allowed' }, available)
	}
	return out
}

export interface AgentSettings {
	uid: string
	paused: boolean
	wakes: boolean
	webhookUrl: string | null
	webhookSecret: string | null
	notifyApprovals: boolean
	doorbellError: string | null
	doorbellErrorAt: number | null
}

export async function getSettings(db: Db, uid: string): Promise<AgentSettings> {
	const rows = await db.q<Record<string, unknown>>(`SELECT * FROM ${db.t('atrium_agent_settings')} WHERE uid = $1`, [uid])
	const r = rows[0]
	if (!r) {
		return { uid, paused: false, wakes: false, webhookUrl: null, webhookSecret: null, notifyApprovals: true, doorbellError: null, doorbellErrorAt: null }
	}
	return {
		uid,
		paused: bool(r.paused),
		wakes: bool(r.wakes),
		webhookUrl: (r.webhook_url as string | null) ?? null,
		webhookSecret: (r.webhook_secret as string | null) ?? null,
		notifyApprovals: bool(r.notify_approvals),
		doorbellError: (r.doorbell_error as string | null) ?? null,
		doorbellErrorAt: r.doorbell_error_at === null || r.doorbell_error_at === undefined ? null : num(r.doorbell_error_at),
	}
}

export function validWebhookUrl(url: string): boolean {
	try {
		const u = new URL(url)
		return u.protocol === 'http:' || u.protocol === 'https:'
	} catch {
		return false
	}
}

export async function updateSettings(db: Db, uid: string, patch: Partial<Omit<AgentSettings, 'uid'>>, policy: WebhookPolicy = webhookPolicy()): Promise<AgentSettings> {
	const cur = await getSettings(db, uid)
	const next = { ...cur, ...patch }
	if (next.webhookUrl !== null && next.webhookUrl !== '' && !validWebhookUrl(next.webhookUrl)) {
		throw new AgentError('invalid_input', 'The webhook URL must be http(s)')
	}
	// A new URL must not point inside (P1-5). A name that does not resolve yet is
	// accepted; the doorbell checks again before every POST.
	if (patch.webhookUrl) {
		try {
			await assertPublicWebhook(patch.webhookUrl, policy, { unresolvedOk: true })
		} catch (e) {
			if (e instanceof BlockedWebhook) throw new AgentError('invalid_input', e.message)
			throw e
		}
	}
	if (next.webhookUrl === '') next.webhookUrl = null
	if (!next.webhookSecret) next.webhookSecret = 'whsec_' + randomToken(24)
	await db.q(`INSERT INTO ${db.t('atrium_agent_settings')} (uid, paused, wakes, webhook_url, webhook_secret, notify_approvals, doorbell_error, doorbell_error_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (uid) DO UPDATE SET paused = excluded.paused, wakes = excluded.wakes, webhook_url = excluded.webhook_url,
			webhook_secret = excluded.webhook_secret, notify_approvals = excluded.notify_approvals,
			doorbell_error = excluded.doorbell_error, doorbell_error_at = excluded.doorbell_error_at, updated_at = excluded.updated_at`,
	[uid, next.paused ? 1 : 0, next.wakes ? 1 : 0, next.webhookUrl, next.webhookSecret, next.notifyApprovals ? 1 : 0,
		next.doorbellError, next.doorbellErrorAt, nowSec()])
	return next
}
