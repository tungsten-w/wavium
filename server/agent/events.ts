// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The event log (ADR 0009 section 4). Producers (PHP and TS) insert into
// atrium_agent_event_queue; one writer here moves rows into atrium_agent_events
// in order, so a cursor (the log id) never skips a row that committed late.
// Agents read with events_since; agents with a webhook get a signed doorbell.
import { type AccessMap, getSettings, grantorsFor, modeOf } from './access'
import { type Db, getMeta, num, setMeta } from './db'
import { assertPublicWebhook, BlockedWebhook, type WebhookPolicy, webhookPolicy } from './netguard'
import { AgentError, hmacHex, iso, nowSec, ulid } from './util'

export const RETENTION_SEC = 30 * 86400

export interface NewEvent {
	app: string
	area: string
	type: string
	grantor: string
	/** Only this agent sees it (approval events). */
	agent?: string | null
	/** Could wake an agent that has wakes on (the app's wake rule said yes). */
	wakeHint: boolean
	data: unknown
	/** Same key twice = one event (e.g. "mail:<account>:<hash>"). */
	dedupeKey?: string
}

export async function enqueue(db: Db, e: NewEvent): Promise<void> {
	await db.q(`INSERT INTO ${db.t('atrium_agent_event_queue')} (dedupe_key, app, area, type, grantor_uid, agent_uid, wake_hint, data, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (dedupe_key) DO NOTHING`,
	[e.dedupeKey ?? null, e.app, e.area, e.type, e.grantor, e.agent ?? null, e.wakeHint ? 1 : 0, JSON.stringify(e.data), nowSec()])
}

export const formatCursor = (id: number): string => 'c_' + String(id).padStart(6, '0')

export function parseCursor(c: string): number {
	const m = /^c_(\d+)$/.exec(c)
	if (!m) throw new AgentError('invalid_input', 'Not a cursor (expected "c_<number>")', 'bad_cursor')
	return Number(m[1])
}

interface EventRow {
	id: number | string
	event_id: string
	app: string
	area: string
	type: string
	grantor_uid: string
	agent_uid: string | null
	wake_hint: number | string | boolean
	data: string
	occurred_at: number | string
}

export interface Envelope {
	id: string
	cursor: string
	type: string
	version: 1
	occurred_at: string | null
	app: string
	grantor: string
	wake: boolean
	data: unknown
}

export function envelope(r: EventRow, agentWakes: boolean): Envelope {
	const hint = r.wake_hint === true || Number(r.wake_hint) === 1
	return {
		id: r.event_id,
		cursor: formatCursor(num(r.id)),
		type: r.type,
		version: 1,
		occurred_at: iso(r.occurred_at),
		app: r.app,
		grantor: r.grantor_uid,
		wake: agentWakes && hint,
		data: JSON.parse(r.data),
	}
}

/** SQL condition (and params) for "events this agent may see". */
export function visibility(agent: string, grants: Map<string, AccessMap>, firstParam: number): { sql: string, params: unknown[] } {
	const params: unknown[] = [agent]
	const parts = [`agent_uid = $${firstParam}`]
	for (const [grantor, access] of grants) {
		const areas = Object.keys(access).filter((a) => modeOf(access[a], 'read') === 'allowed')
		if (!areas.length) continue
		params.push(grantor)
		const g = firstParam + params.length - 1
		const list = areas.map((a) => { params.push(a); return `$${firstParam + params.length - 1}` })
		parts.push(`(agent_uid IS NULL AND grantor_uid = $${g} AND area IN (${list.join(', ')}))`)
	}
	return { sql: '(' + parts.join(' OR ') + ')', params }
}

export async function maxEventId(db: Db): Promise<number> {
	const rows = await db.q<{ m: number | string | null }>(`SELECT MAX(id) AS m FROM ${db.t('atrium_agent_events')}`)
	return num(rows[0]?.m)
}

export interface SinceInput { cursor?: string, limit?: number, types?: string[] }

export async function eventsSince(db: Db, agent: string, input: SinceInput): Promise<{ events: Envelope[], next_cursor: string, has_more: boolean }> {
	const max = await maxEventId(db)
	if (input.cursor === undefined || input.cursor === '') {
		return { events: [], next_cursor: formatCursor(max), has_more: false }
	}
	const after = parseCursor(input.cursor)
	const purged = num(await getMeta(db, 'events_purged_to'))
	if (after < purged) {
		throw new AgentError('invalid_input', 'This cursor is older than the 30-day event log. Restart from now (no cursor) and catch up with the normal tools.', 'cursor_expired')
	}
	const limit = Math.min(Math.max(input.limit ?? 100, 1), 500)
	const grants = await grantorsFor(db, agent)
	const vis = visibility(agent, grants, 2)
	const params: unknown[] = [after, ...vis.params]
	let typeSql = ''
	if (input.types?.length) {
		const conds = input.types.map((t) => {
			if (t.endsWith('.*')) { params.push(t.slice(0, -1) + '%'); return `type LIKE $${params.length}` }
			params.push(t); return `type = $${params.length}`
		})
		typeSql = ` AND (${conds.join(' OR ')})`
	}
	params.push(limit + 1)
	const rows = await db.q<EventRow>(`SELECT * FROM ${db.t('atrium_agent_events')} WHERE id > $1 AND ${vis.sql}${typeSql} ORDER BY id LIMIT $${params.length}`, params)
	const hasMore = rows.length > limit
	const page = rows.slice(0, limit)
	const wakes = (await getSettings(db, agent)).wakes
	const events = page.map((r) => envelope(r, wakes))
	// Nothing (more) visible: jump to the end of the log so the next call does not rescan.
	const next = hasMore ? num(page[page.length - 1].id) : Math.max(after, max)
	return { events, next_cursor: formatCursor(next), has_more: hasMore }
}

/** Which agents can see an event (for the doorbell). */
export async function audience(db: Db, r: { grantor_uid: string, area: string, agent_uid: string | null }): Promise<string[]> {
	if (r.agent_uid) return [r.agent_uid]
	const rows = await db.q<{ agent_uid: string, modes: string }>(
		`SELECT agent_uid, modes FROM ${db.t('atrium_agent_access')} WHERE grantor_uid = $1 AND area = $2`, [r.grantor_uid, r.area])
	return rows.filter((x) => { try { return JSON.parse(x.modes).read === 'allowed' } catch { return false } }).map((x) => x.agent_uid)
}

export interface Notifier { notify(title: string, message: string, opts?: { tags?: string[], priority?: number, click?: string }): Promise<void> }

/** The single writer: queue -> log, retention, doorbells. */
export class EventLog {
	private timer: ReturnType<typeof setInterval> | null = null
	private running = false
	private lastPurge = 0
	readonly doorbell: Doorbell

	constructor(private db: Db, notifier: Notifier | null, fetcher: typeof fetch = fetch, policy: WebhookPolicy = webhookPolicy()) {
		this.doorbell = new Doorbell(db, notifier, fetcher, policy)
	}

	start(intervalMs = 1000): void {
		this.timer = setInterval(() => { void this.tick() }, intervalMs)
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = null
	}

	/** Move queued rows into the log (oldest first); returns how many moved. */
	async moveQueued(batch = 200): Promise<number> {
		const Q = this.db.t('atrium_agent_event_queue')
		const E = this.db.t('atrium_agent_events')
		const rows = await this.db.q<Record<string, unknown>>(`SELECT * FROM ${Q} ORDER BY id LIMIT $1`, [batch])
		const ring = new Map<string, boolean>()
		for (const r of rows) {
			const dedupe = (r.dedupe_key as string | null) ?? `q:${num(r.id)}`
			const inserted = await this.db.q<{ id: number | string }>(`INSERT INTO ${E} (event_id, dedupe_key, app, area, type, grantor_uid, agent_uid, wake_hint, data, occurred_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
			['evt_' + ulid(num(r.created_at) * 1000), dedupe, r.app, r.area, r.type, r.grantor_uid, r.agent_uid, num(r.wake_hint), r.data, num(r.created_at)])
			await this.db.q(`DELETE FROM ${Q} WHERE id = $1`, [r.id])
			if (!inserted.length) continue
			for (const agent of await audience(this.db, r as never)) {
				ring.set(agent, (ring.get(agent) ?? false) || num(r.wake_hint) === 1)
			}
		}
		if (ring.size) {
			const cursor = formatCursor(await maxEventId(this.db))
			for (const [agent, hint] of ring) void this.doorbell.ring(agent, cursor, hint)
		}
		return rows.length
	}

	async purge(at = nowSec()): Promise<void> {
		const E = this.db.t('atrium_agent_events')
		const cutoff = at - RETENTION_SEC
		const rows = await this.db.q<{ m: number | string | null }>(`SELECT MAX(id) AS m FROM ${E} WHERE occurred_at < $1`, [cutoff])
		const upTo = num(rows[0]?.m)
		if (!upTo) return
		await this.db.q(`DELETE FROM ${E} WHERE id <= $1`, [upTo])
		await setMeta(this.db, 'events_purged_to', String(upTo))
	}

	async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			while (await this.moveQueued() === 200) { /* drain */ }
			if (Date.now() - this.lastPurge > 3600_000) {
				this.lastPurge = Date.now()
				await this.purge()
			}
		} catch (e) {
			console.error(`agent events: ${(e as Error).message}`)
		} finally {
			this.running = false
		}
	}
}

const BACKOFF_SEC = [5, 15, 60, 300, 900]

/**
 * Signed, coalesced doorbell: at most one POST in flight per agent; a ring
 * during a flight is merged into one follow-up. Body {agent, cursor, wake}.
 */
export interface DoorbellTest { ok: boolean, status: number | null, ms: number, message: string }

/**
 * Settings > Agents > "Test the webhook" (V4-8): one signed POST, with the
 * same guards as a real doorbell (public address checked now, no redirects,
 * 10 s), and a plain-words answer. Not retried, nothing stored.
 */
export async function testDoorbell(db: Db, agent: string, fetcher: typeof fetch, policy: WebhookPolicy = webhookPolicy()): Promise<DoorbellTest> {
	const settings = await getSettings(db, agent)
	if (!settings.webhookUrl) return { ok: false, status: null, ms: 0, message: 'No webhook URL is set for this agent.' }
	if (!settings.webhookSecret) return { ok: false, status: null, ms: 0, message: 'This agent has no webhook secret yet: create one first.' }
	const body = JSON.stringify({ agent, cursor: formatCursor(await maxEventId(db)), wake: false, test: true })
	const ts = nowSec()
	const started = performance.now()
	try {
		await assertPublicWebhook(settings.webhookUrl, policy)
		const res = await fetcher(settings.webhookUrl, {
			method: 'POST', redirect: 'manual', body, signal: AbortSignal.timeout(10_000),
			headers: { 'Content-Type': 'application/json', 'X-Atrium-Timestamp': String(ts), 'X-Atrium-Signature': Doorbell.sign(settings.webhookSecret, ts, body), 'X-Atrium-Test': '1' },
		})
		await res.body?.cancel().catch(() => {})
		const ms = Math.round(performance.now() - started)
		const st = res.status
		if (st >= 200 && st < 300) return { ok: true, status: st, ms, message: `It works: the agent answered ${st} in ${ms} ms.` }
		if (st >= 300 && st < 400) return { ok: false, status: st, ms, message: `Redirected (${st}): redirects are not followed, put the final URL.` }
		if (st === 401 || st === 403) return { ok: false, status: st, ms, message: `Refused (${st}): the agent does not accept the signature. Check the webhook secret, and the clock of the agent's machine.` }
		return { ok: false, status: st, ms, message: `The agent answered ${st}.` }
	} catch (e) {
		const ms = Math.round(performance.now() - started)
		if (e instanceof BlockedWebhook) return { ok: false, status: null, ms, message: `Not sent: ${e.message}` }
		const timeout = (e as Error).name === 'TimeoutError'
		return { ok: false, status: null, ms, message: timeout ? 'No answer within 10 seconds.' : `Could not reach it (${(e as Error).message}).` }
	}
}

export class Doorbell {
	private state = new Map<string, { inFlight: boolean, pending: { cursor: string, wake: boolean } | null, attempt: number }>()

	constructor(private db: Db, private notifier: Notifier | null, private fetcher: typeof fetch, private policy: WebhookPolicy = webhookPolicy()) {}

	static sign(secret: string, timestamp: number, body: string): string {
		return 'sha256=' + hmacHex(secret, `${timestamp}.${body}`)
	}

	async ring(agent: string, cursor: string, hint: boolean): Promise<void> {
		const settings = await getSettings(this.db, agent)
		if (settings.paused || !settings.webhookUrl || !settings.webhookSecret) return
		const wake = settings.wakes && hint
		const s = this.state.get(agent) ?? { inFlight: false, pending: null, attempt: 0 }
		this.state.set(agent, s)
		s.pending = { cursor, wake: wake || (s.pending?.wake ?? false) }
		if (s.inFlight) return
		await this.flush(agent)
	}

	/** For tests: resolves when nothing is in flight or pending. */
	idle(agent: string): boolean {
		const s = this.state.get(agent)
		return !s || (!s.inFlight && !s.pending)
	}

	private async flush(agent: string): Promise<void> {
		const s = this.state.get(agent)!
		while (s.pending) {
			const { cursor, wake } = s.pending
			s.pending = null
			s.inFlight = true
			const settings = await getSettings(this.db, agent)
			if (settings.paused || !settings.webhookUrl || !settings.webhookSecret) { s.inFlight = false; return }
			const body = JSON.stringify({ agent, cursor, wake })
			const ts = nowSec()
			let status = 0
			let blocked: string | null = null
			try {
				// Checked again at every POST: DNS may have changed since it was saved.
				await assertPublicWebhook(settings.webhookUrl, this.policy)
				const res = await this.fetcher(settings.webhookUrl, {
					method: 'POST',
					// A redirect could send the POST inside the network: never followed.
					redirect: 'manual',
					headers: { 'Content-Type': 'application/json', 'X-Atrium-Timestamp': String(ts), 'X-Atrium-Signature': Doorbell.sign(settings.webhookSecret, ts, body) },
					body,
					signal: AbortSignal.timeout(10_000),
				})
				status = res.status
				await res.body?.cancel().catch(() => {})
			} catch (e) {
				status = 0
				if (e instanceof BlockedWebhook) blocked = e.message
			}
			s.inFlight = false
			if (status >= 200 && status < 300) {
				s.attempt = 0
				if (settings.doorbellError) await this.setError(agent, null)
				continue
			}
			if (blocked || (status >= 300 && status < 400) || status === 401 || (status >= 400 && status < 500 && status !== 408 && status !== 429)) {
				// Not retried in a loop: shown on the settings page, owner notified once.
				s.attempt = 0
				const msg = blocked ? `The doorbell was not sent: ${blocked}`
					: status < 400 ? `The doorbell was redirected (${status}); redirects are not followed, set the final URL`
						: status === 401 ? 'The doorbell was refused (401): webhook secret mismatch or clock skew' : `The doorbell was refused (${status})`
				if (settings.doorbellError !== msg) {
					await this.setError(agent, msg)
					await this.notifier?.notify(`Agent ${agent}: doorbell refused`, msg, { tags: ['warning'] }).catch(() => {})
				}
				continue
			}
			// 503, timeouts, connection errors: retry with backoff, newer rings win.
			const delay = BACKOFF_SEC[Math.min(s.attempt, BACKOFF_SEC.length - 1)]
			s.attempt++
			if (s.attempt > 20) { s.attempt = 0; return }
			s.inFlight = true
			setTimeout(() => {
				s.inFlight = false
				s.pending = s.pending ? { cursor: s.pending.cursor, wake: s.pending.wake || wake } : { cursor, wake }
				void this.flush(agent)
			}, delay * 1000)
			return
		}
	}

	private async setError(agent: string, error: string | null): Promise<void> {
		await this.db.q(`UPDATE ${this.db.t('atrium_agent_settings')} SET doorbell_error = $1, doorbell_error_at = $2 WHERE uid = $3`,
			[error, error ? nowSec() : null, agent])
	}
}
