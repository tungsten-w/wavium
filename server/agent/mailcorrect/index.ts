// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Why is this mail here?" > Wrong (V4-10, IDEAS 5). The person corrects the
// classifier on one mail: the mail's classification changes at once (the
// Curated view follows), and the correction is kept per sender address and
// handed to the classifier as a fixed sentence for the next mails from that
// sender (server/ai/triage.ts hintsBlock): never text from the mail itself.
//
// Owner route (session, OCS-APIRequest): POST /agent/v1/mail/triage-correct
//   {db_id, category?, needs_reply?: boolean, needs_action?: boolean}
import type { Db } from '../db'
import type { AgentModule, LayerCore } from '../index'
import { CATEGORIES } from '../mail/read'
import { AgentError, nowSec } from '../util'

const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i

export interface Correction { sender: string, category: string | null, needs_reply: boolean | null, needs_action: boolean | null }

export class Corrections {
	private ready?: Promise<void>
	constructor(private db: Db) {}

	ensure(): Promise<void> {
		this.ready ??= this.db.q(`CREATE TABLE IF NOT EXISTS ${this.db.t('atrium_mail_corrections')} (
			uid VARCHAR(64) NOT NULL,
			sender VARCHAR(255) NOT NULL,
			category VARCHAR(32),
			needs_reply SMALLINT,
			needs_action SMALLINT,
			at BIGINT NOT NULL,
			PRIMARY KEY (uid, sender))`).then(() => {})
		this.ready.catch(() => { this.ready = undefined })
		return this.ready
	}

	async save(uid: string, c: Correction): Promise<void> {
		await this.ensure()
		const prev = await this.get(uid, c.sender)
		const merged = { category: c.category ?? prev?.category ?? null, needs_reply: c.needs_reply ?? prev?.needs_reply ?? null, needs_action: c.needs_action ?? prev?.needs_action ?? null }
		const b = (v: boolean | null) => (v === null ? null : v ? 1 : 0)
		await this.db.q(`INSERT INTO ${this.db.t('atrium_mail_corrections')} (uid, sender, category, needs_reply, needs_action, at) VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (uid, sender) DO UPDATE SET category = excluded.category, needs_reply = excluded.needs_reply, needs_action = excluded.needs_action, at = excluded.at`,
		[uid, c.sender, merged.category, b(merged.needs_reply), b(merged.needs_action), nowSec()])
	}

	async get(uid: string, sender: string): Promise<Correction | null> {
		await this.ensure()
		const [r] = await this.db.q<Record<string, unknown>>(`SELECT * FROM ${this.db.t('atrium_mail_corrections')} WHERE uid = $1 AND sender = $2`, [uid, sender])
		if (!r) return null
		const b = (v: unknown) => (v === null || v === undefined ? null : Number(v) === 1)
		return { sender, category: (r.category as string | null) ?? null, needs_reply: b(r.needs_reply), needs_action: b(r.needs_action) }
	}

	/** Hints for one mail (the triage input starts with headers, "From: Name <addr>"). */
	async hints(uid: string, input: string): Promise<string[]> {
		const from = /^From:.*?<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?\s*$/im.exec(input)?.[1]?.toLowerCase()
		if (!from || !EMAIL.test(from)) return []
		const c = await this.get(uid, from)
		const h = c ? sentence(c) : null
		return h ? [h] : []
	}
}

/** "Mail from a@b.c is orders and does not need a reply." (the only shapes the prompt accepts) */
export function sentence(c: Correction): string | null {
	const need = c.needs_reply !== null ? `${c.needs_reply ? 'needs' : 'does not need'} a reply`
		: c.needs_action !== null ? `${c.needs_action ? 'needs' : 'does not need'} an action` : null
	if (c.category) return `Mail from ${c.sender} is ${c.category}${need ? ` and ${need}` : ''}.`
	return need ? `Mail from ${c.sender} ${need}.` : null
}

export async function correct(db: Db, store: Corrections, uid: string, input: Record<string, unknown>) {
	const dbId = Number(input.db_id)
	if (!Number.isInteger(dbId) || dbId <= 0) throw new AgentError('invalid_input', 'db_id: a mail id')
	const category = input.category === undefined ? null : String(input.category)
	if (category !== null && !CATEGORIES.includes(category)) throw new AgentError('invalid_input', `category: one of ${CATEGORIES.join(', ')}`)
	const flag = (k: string) => (input[k] === undefined ? null : input[k] === true ? true : input[k] === false ? false : (() => { throw new AgentError('invalid_input', `${k}: true or false`) })())
	const needsReply = flag('needs_reply')
	const needsAction = flag('needs_action')
	if (category === null && needsReply === null && needsAction === null) throw new AgentError('invalid_input', 'Nothing to correct')

	// The mail must be the person's own.
	const [m] = await db.q<{ message_id: string | null, account_id: unknown }>(`SELECT m.message_id, b.account_id FROM ${db.t('mail_messages')} m
		JOIN ${db.t('mail_mailboxes')} b ON b.id = m.mailbox_id JOIN ${db.t('mail_accounts')} a ON a.id = b.account_id
		WHERE m.id = $1 AND a.user_id = $2`, [dbId, uid])
	if (!m) throw new AgentError('not_found', 'No such mail')
	const hash = new Bun.CryptoHasher('md5').update(m.message_id ? m.message_id : `db:${dbId}`).digest('hex')
	const account = Number(m.account_id)
	const [from] = await db.q<{ email: string | null }>(`SELECT email FROM ${db.t('mail_recipients')} WHERE message_id = $1 AND type = 0 ORDER BY id LIMIT 1`, [dbId])
	const sender = (from?.email ?? '').toLowerCase()

	const T = db.t('mail_triage')
	const sets: string[] = []
	const params: unknown[] = []
	const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`) }
	if (category !== null) { set('category', category); set('category_confidence', 1); if (category !== 'spam') set('suspicious', 0) }
	if (needsReply !== null) set('needs_reply', needsReply ? 1 : 0)
	if (needsAction !== null) set('needs_action', needsAction ? 1 : 0)
	set('model', 'corrected-by-user')
	params.push(account, hash)
	const updated = await db.q(`UPDATE ${T} SET ${sets.join(', ')} WHERE account_id = $${params.length - 1} AND msg_hash = $${params.length} RETURNING id`, params)
	if (!updated.length) {
		await db.q(`INSERT INTO ${T} (account_id, msg_hash, version, model, category, category_confidence, needs_reply, needs_action, classified_at)
			VALUES ($1, $2, 'user', 'corrected-by-user', $3, $4, $5, $6, $7)`,
		[account, hash, category, category ? 1 : null, needsReply === null ? null : needsReply ? 1 : 0, needsAction === null ? null : needsAction ? 1 : 0, nowSec()])
	}
	let remembered = false
	if (EMAIL.test(sender)) {
		await store.save(uid, { sender, category, needs_reply: needsReply, needs_action: needsAction })
		remembered = true
	}
	return { corrected: true, sender: remembered ? sender : null, remembered }
}

export function mailCorrectModule(): AgentModule {
	let store: Corrections | null = null
	return {
		tools: (core: LayerCore) => { store ??= new Corrections(core.db); return [] },
		async route(core, req, _url, path) {
			if (path !== '/agent/v1/mail/triage-correct') return null
			if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
			const who = await core.auth.owner(req)
			let input: Record<string, unknown>
			try { input = await req.json() as Record<string, unknown> } catch { throw new AgentError('invalid_input', 'Body must be JSON') }
			if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AgentError('invalid_input', 'Body must be a JSON object')
			store ??= new Corrections(core.db)
			return Response.json(await correct(core.db, store, who.uid, input))
		},
	}
}
