// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Messages tables (ADR 0010), on the agent layer's database:
//   atrium_msg_links          one row per user: the phone link (pairing session sealed)
//   atrium_msg_conversations  conversations seen on the phone
//   atrium_msg_messages       every message ever seen: kept even if deleted on the phone
//   atrium_msg_media          pictures and files of messages (local copy)
//   atrium_msg_agent_prefs    per user and agent: may it see one-time codes?
import { type Db, bool, num } from '../db'
import { isOneTimeCode } from './otp'

export interface Participant { id: string, name: string, number: string, is_me: boolean }
export interface SideConversation {
	id: string, name: string, is_group: boolean, unread: boolean, last_at: number, kind: string
	read_only: boolean, outgoing_id: string, participants: Participant[]
}
export interface SideMedia { id: string, name: string, mime: string, size: number, key: string }
export interface SideMessage {
	id: string, conversation_id: string, at: number, from_me: boolean, sender_id: string
	sender_name: string, sender_number: string, text: string, status: string, media: SideMedia[], tmp_id?: string
}

export type LinkState = 'unpaired' | 'pairing' | 'connecting' | 'connected' | 'phone_offline' | 'logged_out' | 'error' | 'demo'

export interface Link {
	uid: string
	state: LinkState
	session: string | null
	phone: string | null
	offline_since: number | null
	linked_at: number | null
	error: string | null
}

export interface ConversationRow {
	id: string
	name: string
	is_group: boolean
	kind: string
	unread: boolean
	last_at: number
	read_only: boolean
	outgoing_id: string
	participants: Participant[]
	last_text: string | null
	last_from_me: boolean
}

export interface MessageRow {
	id: string
	conversation_id: string
	at: number
	from_me: boolean
	sender_name: string
	sender_number: string
	text: string
	status: string
	media: Array<{ index: number, name: string, mime: string, size: number }>
	one_time_code: boolean
}

const nowSec = () => Math.floor(Date.now() / 1000)

export class MessageStore {
	private ready?: Promise<void>
	constructor(private db: Db) {}

	ensure(): Promise<void> {
		this.ready ??= (async () => {
			const { db } = this
			const blob = db.dialect === 'pg' ? 'BYTEA' : 'BLOB'
			await db.q(`CREATE TABLE IF NOT EXISTS ${db.t('atrium_msg_links')} (
				uid VARCHAR(64) PRIMARY KEY,
				state VARCHAR(20) NOT NULL,
				session_sealed TEXT,
				phone VARCHAR(200),
				offline_since BIGINT,
				linked_at BIGINT,
				error TEXT,
				updated_at BIGINT NOT NULL)`)
			await db.q(`CREATE TABLE IF NOT EXISTS ${db.t('atrium_msg_conversations')} (
				uid VARCHAR(64) NOT NULL,
				conv_id VARCHAR(200) NOT NULL,
				name VARCHAR(300) NOT NULL,
				is_group SMALLINT NOT NULL DEFAULT 0,
				kind VARCHAR(10) NOT NULL DEFAULT 'sms',
				unread SMALLINT NOT NULL DEFAULT 0,
				last_at BIGINT NOT NULL DEFAULT 0,
				read_only SMALLINT NOT NULL DEFAULT 0,
				outgoing_id VARCHAR(200) NOT NULL DEFAULT '',
				participants TEXT NOT NULL,
				PRIMARY KEY (uid, conv_id))`)
			await db.q(`CREATE TABLE IF NOT EXISTS ${db.t('atrium_msg_messages')} (
				uid VARCHAR(64) NOT NULL,
				msg_id VARCHAR(200) NOT NULL,
				conv_id VARCHAR(200) NOT NULL,
				at BIGINT NOT NULL,
				from_me SMALLINT NOT NULL,
				sender_name VARCHAR(300) NOT NULL DEFAULT '',
				sender_number VARCHAR(100) NOT NULL DEFAULT '',
				body TEXT NOT NULL,
				status VARCHAR(20) NOT NULL,
				media TEXT NOT NULL DEFAULT '[]',
				otp SMALLINT NOT NULL DEFAULT 0,
				tmp_id VARCHAR(64),
				PRIMARY KEY (uid, msg_id))`)
			await db.q(`CREATE INDEX IF NOT EXISTS ${db.t('atrium_msg_messages_conv')} ON ${db.t('atrium_msg_messages')} (uid, conv_id, at)`)
			await db.q(`CREATE TABLE IF NOT EXISTS ${db.t('atrium_msg_media')} (
				uid VARCHAR(64) NOT NULL,
				msg_id VARCHAR(200) NOT NULL,
				idx INTEGER NOT NULL,
				mime VARCHAR(200) NOT NULL,
				content ${blob} NOT NULL,
				PRIMARY KEY (uid, msg_id, idx))`)
			await db.q(`CREATE TABLE IF NOT EXISTS ${db.t('atrium_msg_agent_prefs')} (
				uid VARCHAR(64) NOT NULL,
				agent_uid VARCHAR(64) NOT NULL,
				show_codes SMALLINT NOT NULL DEFAULT 0,
				PRIMARY KEY (uid, agent_uid))`)
		})()
		this.ready.catch(() => { this.ready = undefined })
		return this.ready
	}

	// --- link ---------------------------------------------------------------

	async link(uid: string): Promise<Link | null> {
		await this.ensure()
		const [r] = await this.db.q(`SELECT * FROM ${this.db.t('atrium_msg_links')} WHERE uid = $1`, [uid])
		if (!r) return null
		return {
			uid, state: String(r.state) as LinkState, session: (r.session_sealed as string | null) ?? null, phone: (r.phone as string | null) ?? null,
			offline_since: r.offline_since === null ? null : num(r.offline_since), linked_at: r.linked_at === null ? null : num(r.linked_at),
			error: (r.error as string | null) ?? null,
		}
	}

	async linked(): Promise<Link[]> {
		await this.ensure()
		const rows = await this.db.q<{ uid: string }>(`SELECT uid FROM ${this.db.t('atrium_msg_links')} WHERE session_sealed IS NOT NULL`)
		return (await Promise.all(rows.map((r) => this.link(r.uid)))).filter((l): l is Link => l !== null)
	}

	async setLink(uid: string, patch: Partial<Omit<Link, 'uid'>>): Promise<void> {
		await this.ensure()
		const cur = await this.link(uid) ?? { uid, state: 'unpaired', session: null, phone: null, offline_since: null, linked_at: null, error: null }
		const next = { ...cur, ...patch }
		await this.db.q(`INSERT INTO ${this.db.t('atrium_msg_links')} (uid, state, session_sealed, phone, offline_since, linked_at, error, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (uid) DO UPDATE SET state = excluded.state, session_sealed = excluded.session_sealed, phone = excluded.phone,
				offline_since = excluded.offline_since, linked_at = excluded.linked_at, error = excluded.error, updated_at = excluded.updated_at`,
		[uid, next.state, next.session, next.phone, next.offline_since, next.linked_at, next.error, nowSec()])
	}

	// --- conversations ------------------------------------------------------

	async upsertConversation(uid: string, c: SideConversation): Promise<void> {
		await this.ensure()
		await this.db.q(`INSERT INTO ${this.db.t('atrium_msg_conversations')} (uid, conv_id, name, is_group, kind, unread, last_at, read_only, outgoing_id, participants)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT (uid, conv_id) DO UPDATE SET name = excluded.name, is_group = excluded.is_group, kind = excluded.kind, unread = excluded.unread,
				last_at = CASE WHEN excluded.last_at > ${this.db.t('atrium_msg_conversations')}.last_at THEN excluded.last_at ELSE ${this.db.t('atrium_msg_conversations')}.last_at END,
				read_only = excluded.read_only, outgoing_id = excluded.outgoing_id, participants = excluded.participants`,
		[uid, c.id, (c.name || '').slice(0, 300), c.is_group ? 1 : 0, c.kind === 'rcs' ? 'rcs' : 'sms', c.unread ? 1 : 0, Math.max(0, Math.floor(c.last_at || 0)), c.read_only ? 1 : 0, c.outgoing_id ?? '', JSON.stringify(c.participants ?? [])])
	}

	async hasConversation(uid: string, id: string): Promise<boolean> {
		await this.ensure()
		return (await this.db.q(`SELECT 1 FROM ${this.db.t('atrium_msg_conversations')} WHERE uid = $1 AND conv_id = $2`, [uid, id])).length > 0
	}

	async setUnread(uid: string, id: string, unread: boolean): Promise<void> {
		await this.db.q(`UPDATE ${this.db.t('atrium_msg_conversations')} SET unread = $1 WHERE uid = $2 AND conv_id = $3`, [unread ? 1 : 0, uid, id])
	}

	private convRow(r: Record<string, unknown>): ConversationRow {
		let participants: Participant[] = []
		try { participants = JSON.parse(String(r.participants)) } catch { /* broken row */ }
		return {
			id: String(r.conv_id), name: String(r.name), is_group: bool(r.is_group), kind: String(r.kind), unread: bool(r.unread),
			last_at: num(r.last_at), read_only: bool(r.read_only), outgoing_id: String(r.outgoing_id ?? ''), participants,
			last_text: r.last_text === undefined || r.last_text === null ? null : String(r.last_text), last_from_me: bool(r.last_from_me),
		}
	}

	async conversations(uid: string, opts: { query?: string, unreadOnly?: boolean, limit?: number } = {}): Promise<ConversationRow[]> {
		await this.ensure()
		const C = this.db.t('atrium_msg_conversations')
		const M = this.db.t('atrium_msg_messages')
		const params: unknown[] = [uid]
		let where = 'c.uid = $1'
		if (opts.unreadOnly) where += ' AND c.unread = 1'
		if (opts.query) {
			params.push(`%${opts.query.toLowerCase().replace(/[%_\\]/g, (x) => '\\' + x)}%`)
			where += ` AND (lower(c.name) LIKE $${params.length} ESCAPE '\\' OR lower(c.participants) LIKE $${params.length} ESCAPE '\\')`
		}
		params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500))
		const rows = await this.db.q(`SELECT c.*,
			(SELECT m.body FROM ${M} m WHERE m.uid = c.uid AND m.conv_id = c.conv_id ORDER BY m.at DESC LIMIT 1) AS last_text,
			(SELECT m.from_me FROM ${M} m WHERE m.uid = c.uid AND m.conv_id = c.conv_id ORDER BY m.at DESC LIMIT 1) AS last_from_me
			FROM ${C} c WHERE ${where} ORDER BY c.last_at DESC LIMIT $${params.length}`, params)
		return rows.map((r) => this.convRow(r))
	}

	async conversation(uid: string, id: string): Promise<ConversationRow | null> {
		await this.ensure()
		const [r] = await this.db.q(`SELECT * FROM ${this.db.t('atrium_msg_conversations')} WHERE uid = $1 AND conv_id = $2`, [uid, id])
		return r ? this.convRow(r) : null
	}

	// --- messages -----------------------------------------------------------

	/** Stores a message; true when it is new. A message never goes away (phone deletions are ignored). */
	async upsertMessage(uid: string, m: SideMessage): Promise<boolean> {
		await this.ensure()
		const M = this.db.t('atrium_msg_messages')
		const media = (m.media ?? []).map((x, index) => ({ index, id: x.id, name: x.name, mime: x.mime, size: x.size, key: x.key }))
		const existing = await this.db.q(`SELECT 1 FROM ${M} WHERE uid = $1 AND msg_id = $2`, [uid, m.id])
		if (existing.length) {
			await this.db.q(`UPDATE ${M} SET status = $1 WHERE uid = $2 AND msg_id = $3`, [m.status, uid, m.id])
			return false
		}
		// The echo of a message sent from Wavium replaces its placeholder (same tmp_id).
		if (m.tmp_id) await this.db.q(`DELETE FROM ${M} WHERE uid = $1 AND tmp_id = $2 AND msg_id LIKE 'tmp:%'`, [uid, m.tmp_id])
		await this.db.q(`INSERT INTO ${M} (uid, msg_id, conv_id, at, from_me, sender_name, sender_number, body, status, media, otp, tmp_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (uid, msg_id) DO NOTHING`,
		[uid, m.id, m.conversation_id, Math.floor(m.at), m.from_me ? 1 : 0, (m.sender_name ?? '').slice(0, 300), (m.sender_number ?? '').slice(0, 100),
			m.text ?? '', m.status || 'received', JSON.stringify(media), !m.from_me && isOneTimeCode(m.text ?? '') ? 1 : 0, m.tmp_id ?? null])
		await this.db.q(`UPDATE ${this.db.t('atrium_msg_conversations')} SET last_at = $1 WHERE uid = $2 AND conv_id = $3 AND last_at < $1`, [Math.floor(m.at), uid, m.conversation_id])
		return true
	}

	private msgRow(r: Record<string, unknown>): MessageRow {
		let media: MessageRow['media'] = []
		try { media = (JSON.parse(String(r.media)) as Array<{ index: number, name: string, mime: string, size: number }>).map(({ index, name, mime, size }) => ({ index, name, mime, size })) } catch { /* none */ }
		return {
			id: String(r.msg_id), conversation_id: String(r.conv_id), at: num(r.at), from_me: bool(r.from_me), sender_name: String(r.sender_name ?? ''),
			sender_number: String(r.sender_number ?? ''), text: String(r.body ?? ''), status: String(r.status), media, one_time_code: bool(r.otp),
		}
	}

	async messages(uid: string, conv: string, opts: { before?: number, limit?: number } = {}): Promise<MessageRow[]> {
		await this.ensure()
		const params: unknown[] = [uid, conv]
		let where = 'uid = $1 AND conv_id = $2'
		if (opts.before) { params.push(opts.before); where += ` AND at < $${params.length}` }
		params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200))
		const rows = await this.db.q(`SELECT * FROM ${this.db.t('atrium_msg_messages')} WHERE ${where} ORDER BY at DESC LIMIT $${params.length}`, params)
		return rows.map((r) => this.msgRow(r)).reverse()
	}

	async message(uid: string, id: string): Promise<(MessageRow & { media_keys: Array<{ id: string, key: string, mime: string }> }) | null> {
		await this.ensure()
		const [r] = await this.db.q(`SELECT * FROM ${this.db.t('atrium_msg_messages')} WHERE uid = $1 AND msg_id = $2`, [uid, id])
		if (!r) return null
		let keys: Array<{ id: string, key: string, mime: string }> = []
		try { keys = JSON.parse(String(r.media)) } catch { /* none */ }
		return { ...this.msgRow(r), media_keys: keys }
	}

	async search(uid: string, query: string, limit = 20): Promise<Array<MessageRow & { conversation_name: string }>> {
		await this.ensure()
		const like = `%${query.toLowerCase().replace(/[%_\\]/g, (x) => '\\' + x)}%`
		const rows = await this.db.q(`SELECT m.*, c.name AS conv_name FROM ${this.db.t('atrium_msg_messages')} m
			LEFT JOIN ${this.db.t('atrium_msg_conversations')} c ON c.uid = m.uid AND c.conv_id = m.conv_id
			WHERE m.uid = $1 AND (lower(m.body) LIKE $2 ESCAPE '\\' OR lower(m.sender_name) LIKE $2 ESCAPE '\\' OR lower(c.name) LIKE $2 ESCAPE '\\')
			ORDER BY m.at DESC LIMIT $3`, [uid, like, Math.min(Math.max(limit, 1), 100)])
		return rows.map((r) => ({ ...this.msgRow(r), conversation_name: String(r.conv_name ?? '') }))
	}

	/** Conversations whose last message is from someone else and still unread: they wait for an answer. */
	async waiting(uid: string): Promise<ConversationRow[]> {
		return (await this.conversations(uid, { unreadOnly: true, limit: 50 })).filter((c) => !c.last_from_me && c.last_text !== null)
	}

	async counts(uid: string): Promise<{ conversations: number, messages: number }> {
		await this.ensure()
		const [c] = await this.db.q<{ n: unknown }>(`SELECT count(*) AS n FROM ${this.db.t('atrium_msg_conversations')} WHERE uid = $1`, [uid])
		const [m] = await this.db.q<{ n: unknown }>(`SELECT count(*) AS n FROM ${this.db.t('atrium_msg_messages')} WHERE uid = $1`, [uid])
		return { conversations: num(c.n), messages: num(m.n) }
	}

	// --- media --------------------------------------------------------------

	async media(uid: string, msg: string, idx: number): Promise<{ mime: string, content: Uint8Array } | null> {
		await this.ensure()
		const [r] = await this.db.q(`SELECT mime, content FROM ${this.db.t('atrium_msg_media')} WHERE uid = $1 AND msg_id = $2 AND idx = $3`, [uid, msg, idx])
		return r ? { mime: String(r.mime), content: r.content as Uint8Array } : null
	}

	async saveMedia(uid: string, msg: string, idx: number, mime: string, content: Uint8Array): Promise<void> {
		await this.ensure()
		await this.db.q(`INSERT INTO ${this.db.t('atrium_msg_media')} (uid, msg_id, idx, mime, content) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (uid, msg_id, idx) DO NOTHING`,
			[uid, msg, idx, mime.slice(0, 200), content])
	}

	// --- agents -------------------------------------------------------------

	async showCodes(uid: string, agent: string): Promise<boolean> {
		await this.ensure()
		const [r] = await this.db.q(`SELECT show_codes FROM ${this.db.t('atrium_msg_agent_prefs')} WHERE uid = $1 AND agent_uid = $2`, [uid, agent])
		return r ? bool(r.show_codes) : false
	}

	async setShowCodes(uid: string, agent: string, show: boolean): Promise<void> {
		await this.ensure()
		await this.db.q(`INSERT INTO ${this.db.t('atrium_msg_agent_prefs')} (uid, agent_uid, show_codes) VALUES ($1, $2, $3)
			ON CONFLICT (uid, agent_uid) DO UPDATE SET show_codes = excluded.show_codes`, [uid, agent, show ? 1 : 0])
	}
}
