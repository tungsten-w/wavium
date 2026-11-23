// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mail reads, straight from Atrium's mail tables (accounts, folders, messages,
// recipients, stored bodies, classification). Writes go through PHP (write.ts).
import { bool, type Db, num } from '../db'
import { AgentError, iso, parseIso, round2 } from '../util'
import { messageKey, parseMessageKey, parseThreadKey, syncKeys, threadKey } from './keys'

export const CATEGORIES = ['personal', 'work', 'admin', 'orders', 'security', 'social', 'newsletter', 'ads', 'spam', 'other']
export const URGENCIES = ['never', 'whenever', 'this_week', 'today', 'now']
export const DEFAULT_CURATED_HIDES = ['ads', 'spam', 'newsletter', 'social']
export const CURATED_PREF_KEY = 'curated-hides'

export type Role = 'inbox' | 'archive' | 'sent' | 'drafts' | 'trash' | 'junk' | 'other'

export interface Account { id: number, email: string, name: string, archiveId: number | null, trashId: number | null, junkId: number | null, sentId: number | null, draftsId: number | null }
export interface Folder { id: number, accountId: number, name: string, role: Role, messages: number, unseen: number }

/** The categories hidden by the user's Curated setting (Mail preference). */
export async function curatedHides(db: Db, uid: string): Promise<string[]> {
	const rows = await db.q<{ configvalue: string }>(`SELECT configvalue FROM ${db.t('preferences')} WHERE userid = $1 AND appid = 'mail' AND configkey = $2`, [uid, CURATED_PREF_KEY])
	if (!rows.length) return DEFAULT_CURATED_HIDES
	try {
		const v = JSON.parse(rows[0].configvalue)
		return Array.isArray(v) ? v.filter((c) => CATEGORIES.includes(c)) : DEFAULT_CURATED_HIDES
	} catch {
		return DEFAULT_CURATED_HIDES
	}
}

export async function accountsOf(db: Db, uid: string): Promise<Account[]> {
	const rows = await db.q<Record<string, unknown>>(`SELECT id, email, name, archive_mailbox_id, trash_mailbox_id, junk_mailbox_id, sent_mailbox_id, drafts_mailbox_id
		FROM ${db.t('mail_accounts')} WHERE user_id = $1 ORDER BY id`, [uid])
	const n = (v: unknown) => (v === null || v === undefined ? null : num(v))
	return rows.map((r) => ({
		id: num(r.id), email: String(r.email ?? ''), name: String(r.name ?? ''),
		archiveId: n(r.archive_mailbox_id), trashId: n(r.trash_mailbox_id), junkId: n(r.junk_mailbox_id), sentId: n(r.sent_mailbox_id), draftsId: n(r.drafts_mailbox_id),
	}))
}

export function roleOf(account: Account, mailboxId: number, specialUse: string | null, hasArchiveFolder: boolean): Role {
	if (mailboxId === account.archiveId) return 'archive'
	if (mailboxId === account.trashId) return 'trash'
	if (mailboxId === account.junkId) return 'junk'
	if (mailboxId === account.sentId) return 'sent'
	if (mailboxId === account.draftsId) return 'drafts'
	let uses: string[] = []
	try { uses = JSON.parse(specialUse ?? '[]') } catch { /* none */ }
	uses = uses.map((u) => String(u).toLowerCase().replace(/^\\/, ''))
	for (const u of ['inbox', 'archive', 'sent', 'drafts', 'trash', 'junk']) if (uses.includes(u)) return u as Role
	// Gmail: "All Mail" is the archive when there is no archive folder.
	if (uses.includes('all') && account.archiveId === null && !hasArchiveFolder) return 'archive'
	return 'other'
}

export async function foldersOf(db: Db, accounts: Account[]): Promise<Folder[]> {
	if (!accounts.length) return []
	const ids = accounts.map((a) => a.id)
	const rows = await db.q<Record<string, unknown>>(`SELECT id, account_id, name, special_use, messages, unseen FROM ${db.t('mail_mailboxes')}
		WHERE account_id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')}) ORDER BY account_id, name`, ids)
	const byAccount = new Map(accounts.map((a) => [a.id, a]))
	const hasArchive = new Set<number>()
	for (const r of rows) if (String(r.special_use ?? '').toLowerCase().includes('archive')) hasArchive.add(num(r.account_id))
	return rows.map((r) => {
		const account = byAccount.get(num(r.account_id))!
		return {
			id: num(r.id), accountId: account.id, name: String(r.name),
			role: roleOf(account, num(r.id), r.special_use as string | null, hasArchive.has(account.id)),
			messages: num(r.messages), unseen: num(r.unseen),
		}
	})
}

export interface MailScope { accounts: Account[], folders: Folder[], folderById: Map<number, Folder> }

export async function mailScope(db: Db, uid: string): Promise<MailScope> {
	const accounts = await accountsOf(db, uid)
	const folders = await foldersOf(db, accounts)
	return { accounts, folders, folderById: new Map(folders.map((f) => [f.id, f])) }
}

const ROLE_ORDER: Role[] = ['inbox', 'archive', 'other', 'sent', 'drafts', 'junk', 'trash']
const rolePref = (r: Role) => ROLE_ORDER.indexOf(r)

const folderView = (f: Folder | undefined) => (f ? { id: f.id, role: f.role, name: f.name } : null)
const addr = (r: { label?: unknown, email?: unknown }) => ({ name: String(r.label ?? '') === String(r.email ?? '') ? '' : String(r.label ?? ''), address: String(r.email ?? '') })

export function compactClassification(t: Record<string, unknown>) {
	if (!t.t_category) return null
	return {
		category: t.t_category,
		urgency: t.t_urgency,
		needs_reply: round2(t.t_needs_reply),
		needs_action: round2(t.t_needs_action),
		suspicious: round2(t.t_suspicious),
	}
}

export function fullClassification(t: Record<string, unknown>) {
	if (!t.t_category) return null
	return {
		schema: String(t.t_version ?? 'mail-v2'),
		category: t.t_category,
		category_confidence: round2(t.t_category_confidence),
		urgency: t.t_urgency,
		urgency_score: round2(t.t_urgency_score),
		needs_reply: round2(t.t_needs_reply),
		needs_action: round2(t.t_needs_action),
		has_deadline: round2(t.t_has_deadline),
		written_by_person: round2(t.t_written_by_person),
		suspicious: round2(t.t_suspicious),
		classified_at: iso(t.t_classified_at as number),
	}
}

function selectCols(db: Db): string {
	return `m.id, m.uid, m.message_id, m.mailbox_id, m.subject, m.sent_at, m.flag_seen, m.flag_flagged, m.flag_answered, m.flag_forwarded,
		m.flag_attachments, CASE WHEN b.attachments IS NOT NULL AND b.attachments <> '' THEN 1 ELSE 0 END AS b_has_att, m.flag_important, m.flag_junk, m.preview_text, m.in_reply_to, m.thread_root_id, m.server_gone_at,
		k.account_id, k.msg_hash, k.thread_hash,
		t.version AS t_version, t.category AS t_category, t.category_confidence AS t_category_confidence, t.urgency AS t_urgency,
		t.urgency_score AS t_urgency_score, t.needs_reply AS t_needs_reply, t.needs_action AS t_needs_action, t.has_deadline AS t_has_deadline,
		t.written_by_person AS t_written_by_person, t.suspicious AS t_suspicious, t.classified_at AS t_classified_at
	FROM ${db.t('mail_messages')} m
	JOIN ${db.t('atrium_agent_mailkeys')} k ON k.id = m.id
	LEFT JOIN ${db.t('mail_triage')} t ON t.account_id = k.account_id AND t.msg_hash = k.msg_hash
	LEFT JOIN ${db.t('mail_bodies')} b ON b.account_id = k.account_id AND b.msg_hash = k.msg_hash`
}

export type Row = Record<string, unknown>

const hasAtt = (r: Row): boolean => bool(r.flag_attachments) || num(r.b_has_att) === 1

export async function recipientsFor(db: Db, ids: number[]): Promise<Map<number, { from: ReturnType<typeof addr> | null, to: ReturnType<typeof addr>[], cc: ReturnType<typeof addr>[], bcc: ReturnType<typeof addr>[] }>> {
	const out = new Map<number, { from: ReturnType<typeof addr> | null, to: ReturnType<typeof addr>[], cc: ReturnType<typeof addr>[], bcc: ReturnType<typeof addr>[] }>()
	for (const id of ids) out.set(id, { from: null, to: [], cc: [], bcc: [] })
	if (!ids.length) return out
	const rows = await db.q<Row>(`SELECT message_id, type, label, email FROM ${db.t('mail_recipients')} WHERE message_id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')}) ORDER BY id`, ids)
	for (const r of rows) {
		const o = out.get(num(r.message_id))
		if (!o) continue
		const a = addr(r)
		const type = num(r.type)
		if (type === 0) o.from ??= a
		else if (type === 1) o.to.push(a)
		else if (type === 2) o.cc.push(a)
		else if (type === 3) o.bcc.push(a)
	}
	return out
}

export function listRow(r: Row, scope: MailScope, rcpt: Awaited<ReturnType<typeof recipientsFor>>) {
	const account = num(r.account_id)
	const hash = String(r.msg_hash)
	const p = rcpt.get(num(r.id))
	return {
		message_key: messageKey(account, hash),
		thread_key: threadKey(account, String(r.thread_hash ?? hash)),
		account: account,
		folder: folderView(scope.folderById.get(num(r.mailbox_id))),
		date: iso(r.sent_at as number),
		from: p?.from ?? null,
		to: p?.to ?? [],
		subject: String(r.subject ?? ''),
		snippet: String(r.preview_text ?? '').slice(0, 300),
		flags: { seen: bool(r.flag_seen), starred: bool(r.flag_flagged), answered: bool(r.flag_answered), forwarded: bool(r.flag_forwarded), important: bool(r.flag_important) },
		has_attachments: hasAtt(r),
		classification: compactClassification(r),
	}
}

/** Several rows can be one mail (Gmail: INBOX + All Mail); keep the best folder. */
function dedupe(rows: Row[], scope: MailScope): Row[] {
	const best = new Map<string, Row>()
	const order: string[] = []
	for (const r of rows) {
		const key = `${num(r.account_id)}:${r.msg_hash}`
		const cur = best.get(key)
		if (!cur) { best.set(key, r); order.push(key); continue }
		const rf = scope.folderById.get(num(r.mailbox_id))?.role ?? 'other'
		const cf = scope.folderById.get(num(cur.mailbox_id))?.role ?? 'other'
		if (rolePref(rf) < rolePref(cf)) best.set(key, r)
	}
	return order.map((k) => best.get(k)!)
}

export interface ListInput {
	account?: number
	folder?: string | number
	after?: string
	before?: string
	from?: string
	to?: string
	subject?: string
	text?: string
	category?: string | string[]
	curated?: boolean
	urgency_min?: string
	needs_reply?: boolean
	needs_action?: boolean
	seen?: boolean
	starred?: boolean
	has_attachments?: boolean
	limit?: number
	cursor?: string
}

function encodeCursor(sentAt: number, id: number): string {
	return 'm_' + Buffer.from(`${sentAt}:${id}`).toString('base64url')
}

function decodeCursor(c: string): { sentAt: number, id: number } {
	const m = /^m_([A-Za-z0-9_-]+)$/.exec(c)
	const parts = m ? Buffer.from(m[1], 'base64url').toString().split(':') : []
	if (parts.length !== 2 || !parts.every((p) => /^-?\d+$/.test(p))) throw new AgentError('invalid_input', 'Bad cursor', 'bad_cursor')
	return { sentAt: Number(parts[0]), id: Number(parts[1]) }
}

const like = (s: string) => '%' + s.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%'

export function resolveFolders(scope: MailScope, input: ListInput): Folder[] {
	let folders = scope.folders
	if (input.account !== undefined) {
		if (!scope.accounts.some((a) => a.id === input.account)) throw new AgentError('not_found', `No mail account ${input.account}`)
		folders = folders.filter((f) => f.accountId === input.account)
	}
	if (input.folder === undefined) return folders.filter((f) => f.role === 'inbox' || f.role === 'archive')
	if (typeof input.folder === 'number' || /^\d+$/.test(String(input.folder))) {
		const f = scope.folderById.get(Number(input.folder))
		if (!f || !folders.includes(f)) throw new AgentError('not_found', `No folder ${input.folder}`)
		return [f]
	}
	const role = String(input.folder)
	if (!['inbox', 'archive', 'sent', 'drafts', 'trash', 'junk', 'other', 'all'].includes(role)) throw new AgentError('invalid_input', `Unknown folder role ${role}`)
	return role === 'all' ? folders : folders.filter((f) => f.role === role)
}

export async function listMessages(db: Db, grantor: string, input: ListInput) {
	await syncKeys(db)
	const scope = await mailScope(db, grantor)
	const folders = resolveFolders(scope, input)
	const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
	if (!folders.length) return { messages: [], next_cursor: null }
	const params: unknown[] = []
	const p = (v: unknown) => { params.push(v); return `$${params.length}` }
	const where: string[] = [`m.mailbox_id IN (${folders.map((f) => p(f.id)).join(', ')})`, `(m.flag_deleted IS NULL OR m.flag_deleted = ${p(false)})`]
	if (input.after) { const t = parseIso(input.after); if (t === null) throw new AgentError('invalid_input', 'after: not a date'); where.push(`m.sent_at >= ${p(t)}`) }
	if (input.before) { const t = parseIso(input.before); if (t === null) throw new AgentError('invalid_input', 'before: not a date'); where.push(`m.sent_at < ${p(t)}`) }
	if (input.subject) where.push(`lower(m.subject) LIKE ${p(like(input.subject))} ESCAPE '\\'`)
	const R = db.t('mail_recipients')
	if (input.from) { const x = p(like(input.from)); where.push(`EXISTS (SELECT 1 FROM ${R} r WHERE r.message_id = m.id AND r.type = 0 AND (lower(r.email) LIKE ${x} ESCAPE '\\' OR lower(r.label) LIKE ${x} ESCAPE '\\'))`) }
	if (input.to) { const x = p(like(input.to)); where.push(`EXISTS (SELECT 1 FROM ${R} r WHERE r.message_id = m.id AND r.type IN (1, 2, 3) AND (lower(r.email) LIKE ${x} ESCAPE '\\' OR lower(r.label) LIKE ${x} ESCAPE '\\'))`) }
	if (input.text) {
		const x = p(like(input.text))
		where.push(`(lower(m.subject) LIKE ${x} ESCAPE '\\' OR lower(m.preview_text) LIKE ${x} ESCAPE '\\' OR EXISTS (SELECT 1 FROM ${db.t('mail_bodies')} b WHERE b.account_id = k.account_id AND b.msg_hash = k.msg_hash AND lower(b.body) LIKE ${x} ESCAPE '\\'))`)
	}
	if (input.category !== undefined) {
		const cats = Array.isArray(input.category) ? input.category : [input.category]
		for (const c of cats) if (!CATEGORIES.includes(c)) throw new AgentError('invalid_input', `Unknown category ${c}`)
		where.push(cats.length ? `t.category IN (${cats.map((c) => p(c)).join(', ')})` : '1 = 0')
	}
	if (input.curated !== undefined) {
		// Curated hides categories, so mail the classifier has not seen yet is
		// shown, not hidden -- the same rule the UI's Curated chip follows. It used
		// to need a category, which made every mail invisible to agents on an
		// instance with no AI set up.
		const hides = await curatedHides(db, grantor)
		const list = hides.length ? hides.map((c) => p(c)).join(', ') : null
		if (input.curated) where.push(list ? `(t.category IS NULL OR t.category NOT IN (${list}))` : '1 = 1')
		else where.push(list ? `(t.category IS NOT NULL AND t.category IN (${list}))` : '1 = 0')
	}
	if (input.urgency_min !== undefined) {
		const i = URGENCIES.indexOf(input.urgency_min)
		if (i < 0) throw new AgentError('invalid_input', `urgency_min must be one of ${URGENCIES.join(', ')}`)
		where.push(`t.urgency IN (${URGENCIES.slice(i).map((u) => p(u)).join(', ')})`)
	}
	if (input.needs_reply !== undefined) where.push(input.needs_reply ? `t.needs_reply >= 0.5` : `(t.needs_reply IS NULL OR t.needs_reply < 0.5)`)
	if (input.needs_action !== undefined) where.push(input.needs_action ? `t.needs_action >= 0.5` : `(t.needs_action IS NULL OR t.needs_action < 0.5)`)
	if (input.seen !== undefined) where.push(`m.flag_seen = ${p(input.seen)}`)
	if (input.has_attachments !== undefined) where.push(input.has_attachments ? `(m.flag_attachments = ${p(true)} OR (b.attachments IS NOT NULL AND b.attachments <> ''))` : `((m.flag_attachments IS NULL OR m.flag_attachments = ${p(false)}) AND (b.attachments IS NULL OR b.attachments = ''))`)
	if (input.cursor) {
		const c = decodeCursor(input.cursor)
		where.push(`(m.sent_at < ${p(c.sentAt)} OR (m.sent_at = ${p(c.sentAt)} AND m.id < ${p(c.id)}))`)
	}
	const fetch = limit * 3 + 5
	const rows = await db.q<Row>(`SELECT ${selectCols(db)} WHERE ${where.join(' AND ')} ORDER BY m.sent_at DESC, m.id DESC LIMIT ${p(fetch)}`, params)
	// Take rows until `limit` distinct mails, plus later copies of those mails.
	const taken: Row[] = []
	const keys = new Set<string>()
	let last: Row | null = null
	for (const r of rows) {
		const key = `${num(r.account_id)}:${r.msg_hash}`
		if (!keys.has(key)) {
			if (keys.size >= limit) break
			keys.add(key)
		}
		taken.push(r)
		last = r
	}
	const unique = dedupe(taken, scope)
	const rcpt = await recipientsFor(db, unique.map((r) => num(r.id)))
	const more = rows.length > taken.length || rows.length === fetch
	return {
		messages: unique.map((r) => listRow(r, scope, rcpt)),
		next_cursor: more && last ? encodeCursor(num(last.sent_at), num(last.id)) : null,
	}
}

/** Every row of one mail (all folders), best folder first. */
export async function rowsForKey(db: Db, grantor: string, key: string): Promise<{ rows: Row[], scope: MailScope, account: Account }> {
	const { account: accountId, hash } = parseMessageKey(key)
	await syncKeys(db)
	const scope = await mailScope(db, grantor)
	const account = scope.accounts.find((a) => a.id === accountId)
	if (!account) throw new AgentError('not_found', `No mail ${key}`)
	const rows = await db.q<Row>(`SELECT ${selectCols(db)} WHERE k.account_id = $1 AND k.msg_hash = $2 ORDER BY m.id`, [accountId, hash])
	const mine = rows.filter((r) => scope.folderById.has(num(r.mailbox_id)))
	if (!mine.length) throw new AgentError('not_found', `No mail ${key}`)
	mine.sort((a, b) => rolePref(scope.folderById.get(num(a.mailbox_id))!.role) - rolePref(scope.folderById.get(num(b.mailbox_id))!.role))
	return { rows: mine, scope, account }
}

export interface StoredBody { body: string | null, reader_body: string | null, reader_meta: Record<string, unknown> | null, headers: string | null }

export async function storedBody(db: Db, account: number, hash: string): Promise<StoredBody | null> {
	const rows = await db.q<Row>(`SELECT body, reader_body, reader_meta, headers FROM ${db.t('mail_bodies')} WHERE account_id = $1 AND msg_hash = $2`, [account, hash])
	if (!rows.length) return null
	let meta: Record<string, unknown> | null = null
	try { meta = rows[0].reader_meta ? JSON.parse(String(rows[0].reader_meta)) : null } catch { /* none */ }
	return { body: rows[0].body as string | null, reader_body: rows[0].reader_body as string | null, reader_meta: meta, headers: rows[0].headers as string | null }
}

export interface AttachmentMeta { attachment_id: string, filename: string, content_type: string, size: number, inline: boolean }

export function attachmentsFromMeta(meta: Record<string, unknown> | null): AttachmentMeta[] {
	const out = new Map<string, AttachmentMeta>()
	for (const [list, inline] of [[meta?.attachments, false], [meta?.inlineAttachments, true]] as const) {
		if (!Array.isArray(list)) continue
		for (const a of list as Array<Record<string, unknown>>) {
			const id = String(a.id ?? '')
			if (!id || out.has(id)) continue
			out.set(id, { attachment_id: id, filename: String(a.fileName ?? `part-${id}`), content_type: String(a.mime ?? 'application/octet-stream'), size: num(a.size), inline })
		}
	}
	return [...out.values()]
}

export function pageText(text: string, offset: number, maxChars: number) {
	const start = Math.max(0, Math.min(offset, text.length))
	const slice = text.slice(start, start + maxChars)
	return { body: slice, body_length: text.length, offset: start, body_truncated: start + slice.length < text.length }
}

export type BodyFetcher = (grantor: string, messageDbId: number) => Promise<void>

/**
 * Classification stores only the text body; the reader copy (html, attachment
 * list, reply-to) is written when the mail is first opened. Fetch if either is
 * missing, or a freshly classified mail shows no attachments.
 */
export const needsFetch = (stored: StoredBody | null): boolean => !stored || stored.body === null || stored.reader_meta === null

/** One mail with its stored body (fetched from the server once if Atrium has none). */
export async function getMessage(db: Db, grantor: string, input: { message_key: string, html?: boolean, max_chars?: number, offset?: number }, fetchBody: BodyFetcher | null) {
	const { rows, scope, account } = await rowsForKey(db, grantor, input.message_key)
	const r = rows[0]
	const hash = String(r.msg_hash)
	let stored = await storedBody(db, account.id, hash)
	if (needsFetch(stored) && fetchBody && !r.server_gone_at) {
		try {
			await fetchBody(grantor, num(r.id))
			stored = await storedBody(db, account.id, hash)
		} catch (e) {
			console.error(`agent mail body ${input.message_key}: ${(e as Error).message}`)
		}
	}
	const rcpt = (await recipientsFor(db, [num(r.id)])).get(num(r.id))!
	const text = stored?.body ?? String(r.preview_text ?? '')
	const meta = stored?.reader_meta ?? null
	const replyTo = Array.isArray(meta?.replyTo) ? (meta!.replyTo as Array<Record<string, unknown>>).map(addr) : []
	return {
		message_key: input.message_key,
		thread_key: threadKey(account.id, String(r.thread_hash ?? hash)),
		account: { id: account.id, email: account.email },
		folder: folderView(scope.folderById.get(num(r.mailbox_id))),
		folders: rows.map((x) => folderView(scope.folderById.get(num(x.mailbox_id)))),
		date: iso(r.sent_at as number),
		from: rcpt.from,
		to: rcpt.to,
		cc: rcpt.cc,
		bcc: rcpt.bcc,
		reply_to: replyTo,
		subject: String(r.subject ?? ''),
		message_id: r.message_id ?? null,
		in_reply_to: r.in_reply_to ?? null,
		flags: { seen: bool(r.flag_seen), starred: bool(r.flag_flagged), answered: bool(r.flag_answered), forwarded: bool(r.flag_forwarded), important: bool(r.flag_important), junk: bool(r.flag_junk) },
		has_attachments: hasAtt(r),
		attachments: attachmentsFromMeta(meta),
		classification: fullClassification(r),
		only_in_atrium: r.server_gone_at !== null && r.server_gone_at !== undefined,
		body_source: stored?.body !== null && stored?.body !== undefined ? 'stored' : 'preview',
		...pageText(text, input.offset ?? 0, Math.min(Math.max(input.max_chars ?? 8000, 1), 200_000)),
		...(input.html ? { html: stored?.reader_body ?? null } : {}),
	}
}

export async function getThread(db: Db, grantor: string, input: { thread_key: string, max_chars?: number }) {
	const { account: accountId, hash } = parseThreadKey(input.thread_key)
	await syncKeys(db)
	const scope = await mailScope(db, grantor)
	if (!scope.accounts.some((a) => a.id === accountId)) throw new AgentError('not_found', `No thread ${input.thread_key}`)
	const rows = await db.q<Row>(`SELECT ${selectCols(db)} WHERE k.account_id = $1 AND (k.thread_hash = $2 OR (k.thread_hash IS NULL AND k.msg_hash = $2))
		AND (m.flag_deleted IS NULL OR m.flag_deleted = $3) ORDER BY m.sent_at, m.id LIMIT 500`, [accountId, hash, false])
	const mine = dedupe(rows.filter((r) => scope.folderById.has(num(r.mailbox_id))), scope)
	if (!mine.length) throw new AgentError('not_found', `No thread ${input.thread_key}`)
	const rcpt = await recipientsFor(db, mine.map((r) => num(r.id)))
	const maxChars = Math.min(Math.max(input.max_chars ?? 2000, 1), 50_000)
	const messages = []
	for (const r of mine) {
		const stored = await storedBody(db, accountId, String(r.msg_hash))
		const text = stored?.body ?? String(r.preview_text ?? '')
		messages.push({ ...listRow(r, scope, rcpt), cc: rcpt.get(num(r.id))?.cc ?? [], body_source: stored?.body ? 'stored' : 'preview', ...pageText(text, 0, maxChars) })
	}
	return { thread_key: input.thread_key, messages }
}

export async function accountsTool(db: Db, grantor: string) {
	const scope = await mailScope(db, grantor)
	return {
		accounts: scope.accounts.map((a) => ({
			id: a.id,
			email: a.email,
			name: a.name,
			folders: scope.folders.filter((f) => f.accountId === a.id).map((f) => ({ id: f.id, name: f.name, role: f.role, messages: f.messages, unseen: f.unseen })),
		})),
	}
}
