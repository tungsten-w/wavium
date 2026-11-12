// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mail writes. The checks and the frozen payloads live here; the mail work
// itself (IMAP, drafts, the send chain, Trash moves, attachment storage) is done
// by PHP's mail services through apps/mail/lib/Controller/AtriumAgentController.php.
import type { LayerCore } from '../index'
import { type Db, num } from '../db'
import { arr, boolean, int, obj, type Schema, str } from '../schema'
import type { Tool, ToolCtx } from '../tools'
import { AgentError, iso, nowSec, randomToken, stableJson } from '../util'
import { draftKey, parseDraftKey } from './keys'
import { accountsOf, attachmentsFromMeta, mailScope, needsFetch, rowsForKey, storedBody } from './read'

export const INLINE_MAX = 262_144
export const UPLOAD_MAX = 25 * 1024 * 1024
export const UPLOAD_TTL = 24 * 3600
export const LINK_TTL = 15 * 60

export interface PhpAttachment { type: 'local', id: number }
export type BridgeAttachment = PhpAttachment
	| { type: 'file', filename: string, mime: string, base64: string }
	| { type: 'message-attachment', messageId: number, part: string, fileName?: string }
	| { type: 'message', messageId: number }

export interface DraftInput {
	uid: string
	accountId: number
	draftId?: number
	subject: string
	body: string
	to: Array<{ label: string, email: string }>
	cc: Array<{ label: string, email: string }>
	bcc: Array<{ label: string, email: string }>
	attachments: BridgeAttachment[]
	inReplyTo?: string | null
}

/** The PHP side. Each call acts as `uid` (the grantor). */
export interface MailBridge {
	fetchBody(uid: string, id: number): Promise<void>
	flags(uid: string, id: number, flags: { seen?: boolean, flagged?: boolean }): Promise<void>
	move(uid: string, id: number, dest: number): Promise<void>
	trash(uid: string, id: number): Promise<void>
	attachment(uid: string, id: number, part: string): Promise<{ content: Uint8Array, filename: string, contentType: string }>
	saveDraft(input: DraftInput): Promise<number>
	send(uid: string, draftId: number): Promise<void>
	route(core: LayerCore, req: Request, url: URL, path: string): Promise<Response | null>
}

export function phpBridge(core: LayerCore): MailBridge {
	const call = (path: string, body: unknown) => core.php.app<Record<string, unknown>>('POST', `apps/mail/api/atrium-agent/${path}`, { body })
	const bridge: MailBridge = {
		fetchBody: async (uid, id) => { await call('body', { uid, id }) },
		flags: async (uid, id, flags) => { await call('flags', { uid, id, flags }) },
		move: async (uid, id, dest) => { await call('move', { uid, id, dest }) },
		trash: async (uid, id) => { await call('trash', { uid, id }) },
		async attachment(uid, id, part) {
			const res = await core.php.raw('POST', '/index.php', '/apps/mail/api/atrium-agent/attachment', { body: { uid, id, part } })
			if (res.status !== 200) {
				let message = `PHP answered ${res.status}`
				try { message = (await res.json() as { message?: string }).message ?? message } catch { /* not json */ }
				throw new AgentError(res.status === 404 ? 'not_found' : res.status === 403 ? 'forbidden' : 'unavailable', message)
			}
			const cd = res.headers.get('content-disposition') ?? ''
			const name = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1] ?? /filename="([^"]+)"/i.exec(cd)?.[1]
			return { content: new Uint8Array(await res.arrayBuffer()), filename: name ? decodeURIComponent(name) : `part-${part}`, contentType: res.headers.get('content-type') ?? 'application/octet-stream' }
		},
		saveDraft: async (input) => num((await call('draft', input)).id),
		send: async (uid, draftId) => { await call('send', { uid, draftId }) },
		route: (c, req, url, path) => mailRoutes(c, bridge, req, url, path),
	}
	return bridge
}

const attachmentInput: Schema = {
	anyOf: [
		obj({ upload_id: str('From POST /agent/v1/mail/uploads') }, ['upload_id']),
		obj({ message_key: str(), attachment_id: str() }, ['message_key', 'attachment_id']),
		obj({ filename: str(), base64: str('File content, under 256 KB'), content_type: str() }, ['filename', 'base64']),
		obj({ attachment_id: str('Keep an attachment the draft already has') }, ['attachment_id']),
	],
}

const addressList = (d: string): Schema => arr({ anyOf: [str('e-mail address'), obj({ address: str(), name: str() }, ['address'])] }, d, { maxItems: 100 })

export const draftFields = {
	account: int('Mail account id (mail_accounts)'),
	to: addressList('Recipients'),
	cc: addressList('Cc'),
	bcc: addressList('Bcc'),
	subject: str(undefined, { maxLength: 1000 }),
	body: str('Plain text body', { maxLength: 1_000_000 }),
	in_reply_to: str('message_key of the mail this answers'),
	forward_of: str('message_key of a mail to forward (attached as .eml)'),
	attachments: arr(attachmentInput, 'On update: replaces the list; omit to keep it', { maxItems: 50 }),
}

// --- drafts as stored by Mail (LocalMessage) ---

export interface DraftView {
	draft_key: string
	account: number
	subject: string
	body: string
	to: Array<{ name: string, address: string }>
	cc: Array<{ name: string, address: string }>
	bcc: Array<{ name: string, address: string }>
	in_reply_to_message_id: string | null
	attachments: Array<{ attachment_id: string, filename: string, content_type: string }>
	updated_at: string | null
	created_by_agent: boolean
}

export async function readDraft(db: Db, grantor: string, key: string, agent?: string): Promise<DraftView & { localId: number, type: number }> {
	const { account, id } = parseDraftKey(key)
	const accounts = await accountsOf(db, grantor)
	if (!accounts.some((a) => a.id === account)) throw new AgentError('not_found', `No draft ${key}`)
	const rows = await db.q<Record<string, unknown>>(`SELECT id, type, account_id, subject, body_plain, editor_body, in_reply_to_message_id, updated_at FROM ${db.t('mail_local_messages')} WHERE id = $1 AND account_id = $2`, [id, account])
	const r = rows[0]
	if (!r) throw new AgentError('not_found', `No draft ${key}`)
	const rcpt = await db.q<Record<string, unknown>>(`SELECT type, label, email FROM ${db.t('mail_recipients')} WHERE local_message_id = $1 ORDER BY id`, [id])
	const att = await db.q<Record<string, unknown>>(`SELECT id, file_name, mime_type FROM ${db.t('mail_attachments')} WHERE local_message_id = $1 ORDER BY id`, [id])
	const mine = agent ? await db.q(`SELECT 1 AS x FROM ${db.t('atrium_agent_drafts')} WHERE local_id = $1 AND agent_uid = $2`, [id, agent]) : []
	const list = (t: number) => rcpt.filter((x) => num(x.type) === t).map((x) => ({ name: String(x.label ?? '') === String(x.email ?? '') ? '' : String(x.label ?? ''), address: String(x.email ?? '') }))
	return {
		localId: id,
		type: num(r.type),
		draft_key: key,
		account,
		subject: String(r.subject ?? ''),
		body: String(r.body_plain ?? r.editor_body ?? ''),
		to: list(1),
		cc: list(2),
		bcc: list(3),
		in_reply_to_message_id: (r.in_reply_to_message_id as string | null) ?? null,
		attachments: att.map((a) => ({ attachment_id: String(num(a.id)), filename: String(a.file_name ?? ''), content_type: String(a.mime_type ?? '') })),
		updated_at: iso(r.updated_at as number),
		created_by_agent: mine.length > 0,
	}
}

interface AgentDraftRow { local_id: unknown, agent_uid: string, grantor_uid: string, account_id: unknown, discarded_at: unknown, sent_at: unknown }

async function agentDraft(db: Db, localId: number): Promise<AgentDraftRow | null> {
	const rows = await db.q<AgentDraftRow>(`SELECT * FROM ${db.t('atrium_agent_drafts')} WHERE local_id = $1`, [localId])
	return rows[0] ?? null
}

/** What gets approved for a send: exactly what goes out. */
export function sendSnapshot(d: DraftView, fromEmail: string) {
	return {
		draft_key: d.draft_key,
		from: fromEmail,
		to: d.to, cc: d.cc, bcc: d.bcc,
		subject: d.subject,
		body: d.body,
		in_reply_to_message_id: d.in_reply_to_message_id,
		attachments: d.attachments,
	}
}

export function sendSummary(s: ReturnType<typeof sendSnapshot>): string {
	const who = [...s.to, ...s.cc, ...s.bcc].map((a) => a.address)
	const shown = who.slice(0, 3).join(', ') + (who.length > 3 ? ` +${who.length - 3}` : '')
	const att = s.attachments.length ? ` with ${s.attachments.length} attachment${s.attachments.length > 1 ? 's' : ''}` : ''
	return `Send "${s.subject || '(no subject)'}" to ${shown || 'nobody'}${att}`
}

// --- inputs ---

const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/

export function addresses(list: unknown, field: string): Array<{ label: string, email: string }> {
	if (list === undefined) return []
	return (list as Array<string | { address: string, name?: string }>).map((a, i) => {
		const email = (typeof a === 'string' ? a : a.address).trim()
		const label = typeof a === 'string' ? '' : (a.name ?? '').trim()
		if (!EMAIL.test(email)) throw new AgentError('invalid_input', `${field}[${i}]: not an e-mail address`)
		return { label: label || email, email }
	})
}

async function resolveAttachments(ctx: ToolCtx, input: Record<string, unknown>, existing: DraftView | null): Promise<BridgeAttachment[]> {
	const out: BridgeAttachment[] = []
	if (input.attachments === undefined) {
		for (const a of existing?.attachments ?? []) out.push({ type: 'local', id: Number(a.attachment_id) })
	} else {
		for (const [i, raw] of (input.attachments as Array<Record<string, unknown>>).entries()) {
			if (raw.upload_id) {
				const rows = await ctx.db.q<Record<string, unknown>>(`SELECT filename, content_type, content, expires_at FROM ${ctx.db.t('atrium_agent_uploads')} WHERE id = $1 AND agent_uid = $2`, [raw.upload_id, ctx.agent.uid])
				const u = rows[0]
				if (!u || num(u.expires_at) < nowSec()) throw new AgentError('not_found', `attachments[${i}]: upload ${raw.upload_id} does not exist or expired`)
				out.push({ type: 'file', filename: String(u.filename), mime: String(u.content_type), base64: Buffer.from(u.content as Uint8Array).toString('base64') })
			} else if (raw.message_key) {
				const { rows } = await rowsForKey(ctx.db, ctx.grantor, String(raw.message_key))
				out.push({ type: 'message-attachment', messageId: num(rows[0].id), part: String(raw.attachment_id) })
			} else if (raw.base64 !== undefined) {
				const bytes = Buffer.from(String(raw.base64), 'base64')
				if (bytes.length > INLINE_MAX) throw new AgentError('invalid_input', `attachments[${i}]: over 256 KB, upload it first (POST /agent/v1/mail/uploads)`)
				out.push({ type: 'file', filename: String(raw.filename), mime: String(raw.content_type ?? 'application/octet-stream'), base64: bytes.toString('base64') })
			} else if (raw.attachment_id) {
				if (!existing?.attachments.some((a) => a.attachment_id === String(raw.attachment_id))) {
					throw new AgentError('not_found', `attachments[${i}]: the draft has no attachment ${raw.attachment_id}`)
				}
				out.push({ type: 'local', id: Number(raw.attachment_id) })
			}
		}
	}
	if (input.forward_of) {
		const { rows } = await rowsForKey(ctx.db, ctx.grantor, String(input.forward_of))
		out.push({ type: 'message', messageId: num(rows[0].id) })
	}
	return out
}

async function inReplyTo(ctx: ToolCtx, key: unknown, fallback: string | null): Promise<string | null> {
	if (key === undefined) return fallback
	const { rows } = await rowsForKey(ctx.db, ctx.grantor, String(key))
	return (rows[0].message_id as string | null) ?? null
}

/** Best row of a mail for a write (not one that is gone from the server). */
async function rowFor(ctx: ToolCtx, key: string) {
	const found = await rowsForKey(ctx.db, ctx.grantor, key)
	return { ...found, row: found.rows.find((r) => !r.server_gone_at) ?? found.rows[0] }
}

export function mailWrites(bridge: MailBridge): Tool[] {
	const draftSchema = (required: string[], extra: Record<string, Schema> = {}) => obj({ ...extra, ...draftFields }, required)
	return [
		{
			name: 'mail_message_update',
			description: 'Set seen/starred, or move a mail: folder "archive", "inbox" or a folder id. Moving to Trash or Junk is refused here (use mail_message_delete).',
			area: 'mail',
			action: 'write',
			input: obj({ message_key: str(), seen: boolean(), starred: boolean(), folder: { type: ['string', 'integer'] } }, ['message_key']),
			run: async (ctx, input) => {
				const { row, scope, account } = await rowFor(ctx, String(input.message_key))
				const id = num(row.id)
				const flags: { seen?: boolean, flagged?: boolean } = {}
				if (input.seen !== undefined) flags.seen = Boolean(input.seen)
				if (input.starred !== undefined) flags.flagged = Boolean(input.starred)
				let dest: number | null = null
				if (input.folder !== undefined) {
					const f = String(input.folder)
					const target = /^\d+$/.test(f) ? scope.folderById.get(Number(f)) : scope.folders.find((x) => x.accountId === account.id && x.role === f)
					if (!target || target.accountId !== account.id) throw new AgentError('not_found', `No folder ${f} in account ${account.id}`)
					if (target.role === 'trash' || target.role === 'junk') throw new AgentError('forbidden', 'Moving to Trash or Junk is a delete: use mail_message_delete')
					dest = target.id
				}
				if (Object.keys(flags).length) await bridge.flags(ctx.grantor, id, flags)
				if (dest !== null) await bridge.move(ctx.grantor, id, dest)
				return { message_key: input.message_key, updated: true }
			},
		},
		{
			name: 'mail_message_delete',
			description: 'Move a mail to Trash (never a hard delete; Trash is kept 30 days).',
			area: 'mail',
			action: 'delete',
			input: obj({ message_key: str() }, ['message_key']),
			prepare: async (ctx, input) => {
				const { row } = await rowFor(ctx, String(input.message_key))
				return { payload: { message_key: input.message_key }, summary: `Move to Trash: "${String(row.subject ?? '') || '(no subject)'}"`, ref: String(input.message_key) }
			},
			execute: async (ctx, payload) => {
				const p = payload as { message_key: string }
				const { row } = await rowFor(ctx, p.message_key)
				await bridge.trash(ctx.grantor, num(row.id))
				return { message_key: p.message_key, trashed: true }
			},
		},
		{
			name: 'mail_attachment_get',
			description: 'Attachment metadata plus a download URL valid 15 min (GET it with the same token). Content inline as base64 only under 256 KB.',
			area: 'mail',
			input: obj({ message_key: str(), attachment_id: str() }, ['message_key', 'attachment_id']),
			run: async (ctx, input) => {
				const { row, account } = await rowFor(ctx, String(input.message_key))
				const part = String(input.attachment_id)
				let stored = await storedBody(ctx.db, account.id, String(row.msg_hash))
				if (needsFetch(stored) && !row.server_gone_at) {
					await bridge.fetchBody(ctx.grantor, num(row.id)).catch(() => {})
					stored = await storedBody(ctx.db, account.id, String(row.msg_hash))
				}
				const meta = attachmentsFromMeta(stored?.reader_meta ?? null).find((a) => a.attachment_id === part)
				const file = await bridge.attachment(ctx.grantor, num(row.id), part)
				const filename = meta?.filename ?? file.filename
				const contentType = meta?.content_type ?? file.contentType
				const link = await createLink(ctx, 'mail-attachment', { message_key: input.message_key, attachment_id: part, filename, content_type: contentType })
				return {
					attachment_id: part,
					filename,
					content_type: contentType,
					size: file.content.length,
					url: `${ctx.baseUrl}/agent/v1/mail/attachments/${link.id}`,
					expires_at: iso(link.expiresAt),
					...(file.content.length < INLINE_MAX ? { base64: Buffer.from(file.content).toString('base64') } : {}),
				}
			},
		},
		{
			name: 'mail_draft_list',
			description: 'Drafts this agent wrote and has not sent or discarded.',
			area: 'mail',
			input: obj({}),
			run: async (ctx) => {
				const rows = await ctx.db.q<AgentDraftRow>(`SELECT * FROM ${ctx.db.t('atrium_agent_drafts')} WHERE agent_uid = $1 AND grantor_uid = $2 AND discarded_at IS NULL AND sent_at IS NULL ORDER BY local_id DESC`, [ctx.agent.uid, ctx.grantor])
				const drafts = []
				for (const r of rows) {
					try { drafts.push(await readDraft(ctx.db, ctx.grantor, draftKey(num(r.account_id), num(r.local_id)), ctx.agent.uid)) } catch { /* gone */ }
				}
				return { drafts: drafts.filter((d) => d.type === 1).map(({ localId, type, ...d }) => d) }
			},
		},
		{
			name: 'mail_draft_get',
			description: 'One draft by draft_key.',
			area: 'mail',
			input: obj({ draft_key: str() }, ['draft_key']),
			run: async (ctx, input) => {
				const { localId, type, ...d } = await readDraft(ctx.db, ctx.grantor, String(input.draft_key), ctx.agent.uid)
				return { ...d, status: type === 1 ? 'draft' : 'outbox' }
			},
		},
		{
			name: 'mail_draft_create',
			description: 'Write a draft. in_reply_to/forward_of are message keys. Attachments: {upload_id}, {message_key, attachment_id}, or {filename, base64} under 256 KB. Nothing is sent: use mail_send.',
			area: 'mail',
			action: 'write',
			input: draftSchema(['account', 'to', 'subject', 'body']),
			run: async (ctx, input) => {
				const accountId = Number(input.account)
				const scope = await mailScope(ctx.db, ctx.grantor)
				if (!scope.accounts.some((a) => a.id === accountId)) throw new AgentError('not_found', `No mail account ${accountId}`)
				const id = await bridge.saveDraft({
					uid: ctx.grantor, accountId,
					subject: String(input.subject ?? ''), body: String(input.body ?? ''),
					to: addresses(input.to, 'to'), cc: addresses(input.cc, 'cc'), bcc: addresses(input.bcc, 'bcc'),
					attachments: await resolveAttachments(ctx, input, null),
					inReplyTo: await inReplyTo(ctx, input.in_reply_to, null),
				})
				await ctx.db.q(`INSERT INTO ${ctx.db.t('atrium_agent_drafts')} (local_id, agent_uid, grantor_uid, account_id, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (local_id) DO NOTHING`,
					[id, ctx.agent.uid, ctx.grantor, accountId, nowSec()])
				const { localId, type, ...d } = await readDraft(ctx.db, ctx.grantor, draftKey(accountId, id), ctx.agent.uid)
				return d
			},
		},
		{
			name: 'mail_draft_update',
			description: 'Change a draft this agent wrote; omitted fields stay. attachments replaces the list ({attachment_id} keeps one). Pending send approvals for it become void.',
			area: 'mail',
			action: 'write',
			input: draftSchema(['draft_key'], { draft_key: str() }),
			run: async (ctx, input) => {
				const key = String(input.draft_key)
				const cur = await readDraft(ctx.db, ctx.grantor, key, ctx.agent.uid)
				const own = await agentDraft(ctx.db, cur.localId)
				if (!own || own.agent_uid !== ctx.agent.uid) throw new AgentError('forbidden', 'Agents only edit the drafts they wrote')
				if (own.discarded_at || own.sent_at || cur.type !== 1) throw new AgentError('conflict', 'This draft was sent or discarded')
				if (input.account !== undefined && Number(input.account) !== cur.account) throw new AgentError('invalid_input', 'A draft cannot change account; write a new one')
				const keep = (v: unknown, field: string, old: Array<{ name: string, address: string }>) =>
					v === undefined ? old.map((a) => ({ label: a.name || a.address, email: a.address })) : addresses(v, field)
				await bridge.saveDraft({
					uid: ctx.grantor, accountId: cur.account, draftId: cur.localId,
					subject: input.subject === undefined ? cur.subject : String(input.subject),
					body: input.body === undefined ? cur.body : String(input.body),
					to: keep(input.to, 'to', cur.to), cc: keep(input.cc, 'cc', cur.cc), bcc: keep(input.bcc, 'bcc', cur.bcc),
					attachments: await resolveAttachments(ctx, input, cur),
					inReplyTo: await inReplyTo(ctx, input.in_reply_to, cur.in_reply_to_message_id),
				})
				await ctx.approvals.voidRef(ctx.agent.uid, key, 'The draft changed after the request')
				const { localId, type, ...d } = await readDraft(ctx.db, ctx.grantor, key, ctx.agent.uid)
				return d
			},
		},
		{
			name: 'mail_draft_delete',
			description: 'Discard a draft this agent wrote and never sent (kept by Atrium, never hard-deleted). Other drafts are mails in the Drafts folder: use mail_message_delete.',
			area: 'mail',
			action: 'write',
			input: obj({ draft_key: str() }, ['draft_key']),
			run: async (ctx, input) => {
				const key = String(input.draft_key)
				const cur = await readDraft(ctx.db, ctx.grantor, key, ctx.agent.uid)
				const own = await agentDraft(ctx.db, cur.localId)
				if (!own || own.agent_uid !== ctx.agent.uid) throw new AgentError('forbidden', 'Not a draft this agent wrote: use mail_message_delete on its message_key')
				if (own.sent_at || cur.type !== 1) throw new AgentError('conflict', 'This draft was already sent')
				await ctx.db.q(`UPDATE ${ctx.db.t('atrium_agent_drafts')} SET discarded_at = $1 WHERE local_id = $2 AND discarded_at IS NULL`, [nowSec(), cur.localId])
				await ctx.approvals.voidRef(ctx.agent.uid, key, 'The draft was discarded')
				return { draft_key: key, discarded: true }
			},
		},
		{
			name: 'mail_send',
			description: 'Send a draft. Usually needs the owner\'s approval: you get {status: "pending_approval", request_id}; the outcome arrives as approval.executed / approval.failed. Changing the draft afterwards voids the request.',
			area: 'mail',
			action: 'send',
			input: obj({ draft_key: str() }, ['draft_key']),
			prepare: async (ctx, input) => {
				const d = await readDraft(ctx.db, ctx.grantor, String(input.draft_key), ctx.agent.uid)
				if (d.type !== 1) throw new AgentError('conflict', 'Not a draft any more')
				const own = await agentDraft(ctx.db, d.localId)
				if (own?.discarded_at) throw new AgentError('conflict', 'This draft was discarded')
				if (!d.to.length && !d.cc.length && !d.bcc.length) throw new AgentError('invalid_input', 'The draft has no recipients')
				const account = (await accountsOf(ctx.db, ctx.grantor)).find((a) => a.id === d.account)!
				const snap = sendSnapshot(d, account.email)
				return { payload: snap, summary: sendSummary(snap), ref: d.draft_key }
			},
			stillValid: async (ctx, payload) => {
				const p = payload as ReturnType<typeof sendSnapshot>
				try {
					const d = await readDraft(ctx.db, ctx.grantor, p.draft_key)
					const account = (await accountsOf(ctx.db, ctx.grantor)).find((a) => a.id === d.account)
					return d.type === 1 && !!account && stableJson(sendSnapshot(d, account.email)) === stableJson(p)
				} catch {
					return false
				}
			},
			execute: async (ctx, payload) => {
				const p = payload as ReturnType<typeof sendSnapshot>
				const { id } = parseDraftKey(p.draft_key)
				await bridge.send(ctx.grantor, id)
				await ctx.db.q(`UPDATE ${ctx.db.t('atrium_agent_drafts')} SET sent_at = $1 WHERE local_id = $2`, [nowSec(), id])
				return { draft_key: p.draft_key, sent: true }
			},
		},
	]
}

// --- uploads and download links ---

async function createLink(ctx: ToolCtx, kind: string, ref: unknown): Promise<{ id: string, expiresAt: number }> {
	const id = 'lnk_' + randomToken(24)
	const now = nowSec()
	await ctx.db.q(`INSERT INTO ${ctx.db.t('atrium_agent_links')} (id, agent_uid, grantor_uid, kind, ref, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		[id, ctx.agent.uid, ctx.grantor, kind, JSON.stringify(ref), now, now + LINK_TTL])
	return { id, expiresAt: now + LINK_TTL }
}

export async function purgeExpired(db: Db, at = nowSec()): Promise<void> {
	await db.q(`DELETE FROM ${db.t('atrium_agent_links')} WHERE expires_at < $1`, [at])
	await db.q(`DELETE FROM ${db.t('atrium_agent_uploads')} WHERE expires_at < $1`, [at])
}

const safeName = (s: string) => s.replace(/[\r\n"\\/]/g, '_').slice(0, 255) || 'file'

async function mailRoutes(core: LayerCore, bridge: MailBridge, req: Request, _url: URL, path: string): Promise<Response | null> {
	if (path === '/agent/v1/mail/uploads') {
		if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
		const ctx = await core.agentCtx(req, 'mail')
		const len = Number(req.headers.get('content-length') ?? 0)
		if (len > UPLOAD_MAX + 64 * 1024) throw new AgentError('invalid_input', 'Max 25 MB')
		let form: FormData
		try { form = await req.formData() } catch { throw new AgentError('invalid_input', 'Send multipart/form-data with a "file" field') }
		const file = form.get('file')
		if (!(file instanceof File)) throw new AgentError('invalid_input', 'Missing "file" field')
		if (file.size > UPLOAD_MAX) throw new AgentError('invalid_input', 'Max 25 MB')
		const id = 'upl_' + randomToken(18)
		const now = nowSec()
		const type = file.type || 'application/octet-stream'
		const name = safeName(file.name || 'file')
		await ctx.db.q(`INSERT INTO ${ctx.db.t('atrium_agent_uploads')} (id, agent_uid, filename, content_type, size, content, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[id, ctx.agent.uid, name, type, file.size, new Uint8Array(await file.arrayBuffer()), now, now + UPLOAD_TTL])
		return Response.json({ upload_id: id, filename: name, content_type: type, size: file.size, expires_at: iso(now + UPLOAD_TTL) })
	}
	const m = /^\/agent\/v1\/mail\/attachments\/(lnk_[A-Za-z0-9_-]+)$/.exec(path)
	if (m) {
		if (req.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
		const caller = await core.auth.agent(req)
		const rows = await core.db.q<Record<string, unknown>>(`SELECT * FROM ${core.db.t('atrium_agent_links')} WHERE id = $1`, [m[1]])
		const link = rows[0]
		if (!link || link.agent_uid !== caller.uid || num(link.expires_at) < nowSec()) throw new AgentError('not_found', 'Link expired or unknown; call mail_attachment_get again')
		const ctx = await core.agentCtx(req, 'mail', String(link.grantor_uid))
		const ref = JSON.parse(String(link.ref)) as { message_key: string, attachment_id: string, filename?: string, content_type?: string }
		const { row } = await rowFor(ctx, ref.message_key)
		const file = await bridge.attachment(ctx.grantor, num(row.id), ref.attachment_id)
		const filename = safeName(ref.filename ?? file.filename)
		return new Response(file.content, {
			headers: {
				'Content-Type': ref.content_type ?? file.contentType,
				'Content-Disposition': `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
				'Content-Length': String(file.content.length),
			},
		})
	}
	return null
}

