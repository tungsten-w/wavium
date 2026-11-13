// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// mail.received (ADR 0009): emitted only once a new mail is classified. PHP
// classifies on arrival (ClassifyOnArrivalListener + TriageJob); this watcher
// turns new mail_triage rows of live mail into events, in classification order,
// and alerts the owner when live mail waits for classification (cap, AI
// down, IMAP trouble) instead of emitting anything unclassified.
import { type Db, getMeta, num, setMeta } from '../db'
import { enqueue, type Notifier } from '../events'
import { AgentError, nowSec } from '../util'
import { messageKey } from './keys'
import { curatedHides, fullClassification, listRow, recipientsFor, rowsForKey } from './read'

/** A mail reclassified by hand counts as live only if it is this recent. */
export const LIVE_DAYS = 7
/** Live mail waiting longer than this raises an alert (TriageJob runs every 5 min). */
export const STUCK_AFTER = 10 * 60

const SEEN = 'mail_triage_seen'
const SINCE = 'mail_live_since'
const ALERTED = 'mail_stuck_alerted'

export interface ArrivalOpts { notifier: Notifier | null, statusUrl: string }

export class MailArrivals {
	private timer: ReturnType<typeof setInterval> | null = null
	private busy = false
	private lastStuckCheck = 0
	private broken = 0

	constructor(private db: Db, private opts: ArrivalOpts) {}

	/** First start: only mail queued from now on is "live"; history is not replayed. */
	async init(at = nowSec()): Promise<void> {
		if (await getMeta(this.db, SINCE) !== null) return
		const max = num((await this.db.q<{ m: unknown }>(`SELECT MAX(id) AS m FROM ${this.db.t('mail_triage')}`))[0]?.m)
		await setMeta(this.db, SEEN, String(max))
		await setMeta(this.db, SINCE, String(at))
	}

	start(everyMs = 3000): void {
		this.timer = setInterval(() => { void this.safeTick() }, everyMs)
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = null
	}

	private async safeTick(): Promise<void> {
		if (this.busy || Date.now() < this.broken) return
		this.busy = true
		try {
			await this.init()
			await this.tick()
		} catch (e) {
			// e.g. the Mail tables are missing on an old database: retry later.
			console.error(`agent mail arrivals: ${(e as Error).message}`)
			this.broken = Date.now() + 300_000
		} finally {
			this.busy = false
		}
	}

	async tick(at = nowSec()): Promise<number> {
		const n = await this.emitNew()
		if (at - this.lastStuckCheck >= 60) {
			this.lastStuckCheck = at
			await this.checkStuck(at)
		}
		return n
	}

	/** Emit mail.received for live mail classified since the last tick. */
	async emitNew(): Promise<number> {
		const db = this.db
		const seen = num(await getMeta(db, SEEN))
		const since = num(await getMeta(db, SINCE))
		const rows = await db.q<Record<string, unknown>>(`SELECT t.id AS tid, t.account_id, t.msg_hash, t.category, q.priority, q.enqueued_at, q.sent_at, a.user_id
			FROM ${db.t('mail_triage')} t
			JOIN ${db.t('mail_triage_queue')} q ON q.account_id = t.account_id AND q.msg_hash = t.msg_hash
			JOIN ${db.t('mail_accounts')} a ON a.id = t.account_id
			WHERE t.id > $1 ORDER BY t.id LIMIT 200`, [seen])
		let emitted = 0
		let last = seen
		const hidesOf = new Map<string, string[]>()
		const hasAgents = new Map<string, boolean>()
		for (const r of rows) {
			last = num(r.tid)
			if (!isLive(r, since)) continue
			const owner = String(r.user_id)
			if (!hasAgents.has(owner)) {
				hasAgents.set(owner, (await db.q(`SELECT 1 AS x FROM ${db.t('atrium_agent_access')} WHERE grantor_uid = $1 AND area = 'mail' LIMIT 1`, [owner])).length > 0)
			}
			if (!hasAgents.get(owner)) continue
			const key = messageKey(num(r.account_id), String(r.msg_hash))
			const data = await receivedData(db, owner, key)
			if (!data) continue
			if (!hidesOf.has(owner)) hidesOf.set(owner, await curatedHides(db, owner))
			const category = r.category ? String(r.category) : null
			await enqueue(db, {
				app: 'mail', area: 'mail', type: 'mail.received', grantor: owner,
				wakeHint: category !== null && !hidesOf.get(owner)!.includes(category),
				data, dedupeKey: `mail:${key}`,
			})
			emitted++
		}
		if (last !== seen) await setMeta(db, SEEN, String(last))
		return emitted
	}

	/** Live mail stuck before classification: tell the owner once per episode. */
	async checkStuck(at = nowSec()): Promise<void> {
		const db = this.db
		const since = num(await getMeta(db, SINCE))
		const rows = await db.q<{ n: unknown, parked: unknown }>(`SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'parked' THEN 1 ELSE 0 END) AS parked FROM ${db.t('mail_triage_queue')}
			WHERE status IN ('pending', 'parked') AND priority >= 1 AND enqueued_at >= $1 AND enqueued_at < $2`, [since, at - STUCK_AFTER])
		const n = num(rows[0]?.n)
		const alerted = await getMeta(db, ALERTED)
		if (n > 0 && !alerted) {
			const why = await triageReason(db)
			const parked = num(rows[0]?.parked)
			await setMeta(db, ALERTED, String(at))
			await this.opts.notifier?.notify(
				`${n} new mail${n > 1 ? 's' : ''} not classified`,
				`Agents get no mail.received until they are. ${why}${parked ? ` ${parked} gave up (parked).` : ''}`,
				{ tags: ['warning'], priority: 4, click: this.opts.statusUrl },
			).catch(() => {})
		} else if (n === 0 && alerted) {
			await db.q(`DELETE FROM ${db.t('atrium_agent_meta')} WHERE k = $1`, [ALERTED])
			await this.opts.notifier?.notify('Mail classification caught up', 'Waiting mails were classified and sent to agents.', { tags: ['white_check_mark'], priority: 2, click: this.opts.statusUrl }).catch(() => {})
		}
	}
}

export function isLive(r: Record<string, unknown>, since: number): boolean {
	const enq = num(r.enqueued_at)
	if (enq < since) return false
	const prio = num(r.priority)
	if (prio === 1) return true
	return prio === 2 && num(r.sent_at) >= enq - LIVE_DAYS * 86400
}

/** The ADR 0009 mail.received payload, or null when the mail is gone. */
export async function receivedData(db: Db, owner: string, key: string): Promise<Record<string, unknown> | null> {
	let found
	try {
		found = await rowsForKey(db, owner, key)
	} catch (e) {
		if (e instanceof AgentError && e.code === 'not_found') return null
		throw e
	}
	const { rows, scope, account } = found
	const r = rows[0]
	const rcpt = await recipientsFor(db, [num(r.id)])
	const base = listRow(r, scope, rcpt)
	return {
		message_key: base.message_key,
		thread_key: base.thread_key,
		account: { id: account.id, email: account.email },
		folder: base.folder,
		date: base.date,
		from: base.from,
		to: base.to,
		cc: rcpt.get(num(r.id))?.cc ?? [],
		subject: base.subject,
		snippet: base.snippet,
		has_attachments: base.has_attachments,
		classification: fullClassification(r),
	}
}

async function triageReason(db: Db): Promise<string> {
	const rows = await db.q<{ configvalue: string }>(`SELECT configvalue FROM ${db.t('appconfig')} WHERE appid = 'mail' AND configkey = 'triage_state'`)
	let s: Record<string, unknown> = {}
	try { s = JSON.parse(rows[0]?.configvalue ?? '{}') } catch { /* none */ }
	const state = String(s.state ?? 'unknown')
	const text: Record<string, string> = {
		disabled: 'Classification is turned off.',
		not_configured: 'Classification has no AI: add one in Settings > AI.',
		daily_cap: 'Today’s classification budget is used up.',
		budget_exhausted: 'The classification AI budget is exhausted.',
		unauthorized: 'The classification AI refused its key.',
		backoff: 'Classification is backing off after errors.',
	}
	const err = s.lastError ? ` Last error: ${String(s.lastError).slice(0, 200)}` : ''
	return (text[state] ?? `Classifier state: ${state}.`) + err
}
