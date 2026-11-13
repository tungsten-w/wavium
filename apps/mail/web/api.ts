// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { appUrl, HttpError, request, type RequestOptions } from '@atrium/sdk'

export interface Address { label: string, email: string }
export interface Account {
	id: number
	accountId: number
	name: string
	emailAddress: string
	imapHost: string
	imapPort: number
	imapSslMode: string
	imapUser: string
	smtpHost: string
	smtpPort: number
	smtpSslMode: string
	smtpUser: string
	signature: string | null
	editorMode: string
	draftsMailboxId: number | null
	sentMailboxId: number | null
	trashMailboxId: number | null
	archiveMailboxId: number | null
	junkMailboxId: number | null
	snoozeMailboxId: number | null
	showSubscribedOnly: boolean
	aliases: { id: number, name: string, emailAddress: string }[]
	isDelegated: boolean
}
export interface Mailbox {
	databaseId: number
	id: string
	name: string
	accountId: number
	displayName: string
	attributes: string[]
	delimiter: string
	specialUse: string[]
	specialRole: string
	mailboxes: Mailbox[]
	syncInBackground: boolean
	unread: number
	total?: number
	shared: boolean
}
export interface MessageFlags {
	seen: boolean
	flagged: boolean
	answered: boolean
	deleted: boolean
	draft: boolean
	forwarded: boolean
	hasAttachments: boolean
	important: boolean
}
export interface Message {
	databaseId: number
	uid: number
	subject: string
	dateInt: number
	flags: MessageFlags
	from: Address[]
	to: Address[]
	cc: Address[]
	bcc: Address[]
	mailboxId: number
	messageId: string
	inReplyTo: string | null
	threadRootId: string | null
	previewText: string | null
	summary: string | null
	encrypted: boolean
	attachments: Attachment[]
	/** Atrium kept this mail after the mail server stopped holding it. */
	goneFromServer?: boolean
	serverGoneAt?: number | null
}
export interface Attachment {
	id: string | number
	fileName: string
	size?: number
	mime?: string
	mimeType?: string
	downloadUrl?: string
	type?: string
}
export interface MessageBody {
	uid: number
	messageId: string
	from: Address[]
	to: Address[]
	replyTo: Address[]
	cc: Address[]
	bcc: Address[]
	subject: string
	dateInt: number
	body: string
	hasHtmlBody: boolean
	attachments: Attachment[]
	inlineAttachments: Attachment[]
	accountId: number
	mailboxId: number
	databaseId: number
	isSenderTrusted: boolean
	signature?: string | null
	/** List-Unsubscribe (P5-5): https link, RFC 8058 one-click, mailto. */
	unsubscribeUrl?: string | null
	isOneClickUnsubscribe?: boolean
	unsubscribeMailto?: string | null
	/** Where the reader body came from: Atrium's copy or the mail server (fetched once, then kept). */
	atriumCopy?: { source: 'atrium' | 'server', goneFromServer: boolean, text: boolean, full: boolean, storedAt?: number | null }
}
export interface LocalMessage {
	id: number
	accountId: number
	sendAt: number | null
	updatedAt: number | null
	subject: string
	bodyPlain: string | null
	bodyHtml: string | null
	editorBody: string | null
	isHtml: boolean
	inReplyToMessageId: string | null
	attachments: Attachment[]
	to: Address[]
	cc: Address[]
	bcc: Address[]
	failed: boolean
	status: number | null
}
export interface AccountInput {
	accountName: string
	emailAddress: string
	imapHost: string
	imapPort: number
	imapSslMode: string
	imapUser: string
	imapPassword?: string
	smtpHost: string
	smtpPort: number
	smtpSslMode: string
	smtpUser: string
	smtpPassword?: string
	authMethod?: string
}
export interface ComposeData {
	accountId: number
	subject: string
	body: string
	to: Address[]
	cc: Address[]
	bcc: Address[]
	attachments?: Attachment[]
	draftId?: number
	inReplyToMessageId?: string
	sendAt?: number | null
}

async function mail<T>(path: string, opts: RequestOptions = {}): Promise<T> {
	const result = await request<T | { status: string, data: T }>(appUrl('mail', `/api${path}`), opts)
	if (result && typeof result === 'object' && 'status' in result && 'data' in result) return result.data
	return result as T
}

export const listAccounts = () => mail<Account[]>('/accounts')
export async function listMailboxes(accountId: number, forceSync = false) {
	return mail<{ id: number, email: string, mailboxes: Mailbox[], delimiter: string }>(`/mailboxes?accountId=${accountId}&forceSync=${forceSync}`)
}
/**
 * Sync a folder with IMAP. `ids` are the messages the page already shows: the
 * answer holds messages newer than those plus changes to them. An empty list
 * makes the server return EVERY message in the folder (thousands on Gmail), so
 * callers that only want the sync use the default `[0]` (no such message: no new ones).
 */
export function syncMailbox(id: number, init = false, ids: number[] = [0]) {
	return mail<{ newMessages: Message[], changedMessages: Message[], vanishedMessages: number[], stats: { total: number, unread: number } }>(`/mailboxes/${id}/sync`, { method: 'POST', body: { ids, init } })
}
/** Exception class name of a Mail ClientException response ({ status: 'fail', data: { type } }). */
export function mailErrorType(e: unknown): string {
	if (!(e instanceof HttpError)) return ''
	const data = (e.body as { data?: { type?: unknown } } | undefined)?.data
	return typeof data?.type === 'string' ? data.type : ''
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/**
 * A folder that was never synced answers 400 MailboxNotCachedException, and one
 * being synced answers MailboxLockedException. Like upstream Mail, run the
 * initial sync (large folders take several rounds) or wait, then retry.
 */
export async function listMessages(mailboxId: number, opts: { cursor?: number, filter?: string, limit?: number } = {}) {
	const q = new URLSearchParams({ mailboxId: String(mailboxId), limit: String(opts.limit ?? 20), view: 'singleton' })
	if (opts.cursor) q.set('cursor', String(opts.cursor))
	if (opts.filter) q.set('filter', opts.filter)
	for (let attempt = 0; ; attempt++) {
		try {
			return await mail<Message[]>(`/messages?${q}`)
		} catch (e) {
			const type = mailErrorType(e)
			if (attempt >= 30 || !/Mailbox(NotCached|Locked)Exception$/.test(type)) throw e
			if (type.endsWith('NotCachedException')) {
				try { await syncMailbox(mailboxId, true) } catch (err) {
					// 428 = still not cached after this round; locked = another sync runs.
					if (!(err instanceof HttpError) || ![409, 428].includes(err.status) && !/Locked/.test(mailErrorType(err))) throw err
					await sleep(1000)
				}
			} else {
				await sleep(1500)
			}
		}
	}
}
export const getMessageBody = (id: number) => mail<MessageBody>(`/messages/${id}/body`)
export const setFlags = (id: number, flags: Partial<Record<'seen' | 'flagged' | 'answered' | 'important', boolean>>) => mail(`/messages/${id}/flags`, { method: 'PUT', body: { flags } })
export const moveMessage = (id: number, destFolderId: number) => mail(`/messages/${id}/move`, { method: 'POST', body: { destFolderId } })
export const deleteMessage = (id: number) => mail(`/messages/${id}`, { method: 'DELETE' })
export const markAllRead = (id: number) => mail(`/mailboxes/${id}/read`, { method: 'POST', body: {} })
export const createMailbox = (accountId: number, name: string) => mail<Mailbox>('/mailboxes', { body: { accountId, name } })
export const renameMailbox = (id: number, name: string) => mail<Mailbox>(`/mailboxes/${id}`, { method: 'PATCH', body: { name } })
export const deleteMailbox = (id: number) => mail(`/mailboxes/${id}`, { method: 'DELETE' })

export const createAccount = (input: AccountInput) => mail<Account>('/accounts', { body: input })
export const updateAccount = (id: number, input: AccountInput) => mail<Account>(`/accounts/${id}`, { method: 'PUT', body: input })
export const patchAccount = (id: number, patch: Record<string, string | number | boolean | null>) => mail<Account>(`/accounts/${id}`, { method: 'PATCH', body: patch })
export const updateSignature = (id: number, signature: string) => mail(`/accounts/${id}/signature`, { method: 'PUT', body: { signature } })
export const deleteAccount = (id: number) => mail(`/accounts/${id}`, { method: 'DELETE' })

export function saveDraft(data: ComposeData) {
	return mail<{ id: number }>(`/accounts/${data.accountId}/draft`, { body: {
		subject: data.subject,
		body: data.body,
		to: data.to.map(formatAddress).join(', '),
		cc: data.cc.map(formatAddress).join(', '),
		bcc: data.bcc.map(formatAddress).join(', '),
		isHtml: false,
		draftId: data.draftId,
	} })
}
function outboxBody(data: ComposeData) {
	return {
		accountId: data.accountId,
		subject: data.subject,
		bodyPlain: data.body,
		bodyHtml: null,
		editorBody: data.body,
		isHtml: false,
		smimeSign: false,
		smimeEncrypt: false,
		to: data.to,
		cc: data.cc,
		bcc: data.bcc,
		attachments: data.attachments ?? [],
		draftId: data.draftId,
		inReplyToMessageId: data.inReplyToMessageId,
		sendAt: data.sendAt ?? null,
	}
}
export async function listOutbox() {
	const result = await mail<{ messages: LocalMessage[] }>('/outbox')
	return result.messages
}
export const createOutbox = (data: ComposeData) => mail<LocalMessage>('/outbox', { body: outboxBody(data) })
export const updateOutbox = (id: number, data: ComposeData) => mail<LocalMessage>(`/outbox/${id}`, { method: 'PUT', body: outboxBody(data) })
export const sendOutbox = (id: number) => mail(`/outbox/${id}`, { method: 'POST', body: {} })
export const deleteOutbox = (id: number) => mail(`/outbox/${id}`, { method: 'DELETE' })

export function uploadAttachment(accountId: number, file: File) {
	const body = new FormData()
	body.set('accountId', String(accountId))
	body.set('attachment', file)
	return mail<Attachment>('/attachments', { body })
}

export function formatAddress(a: Address) {
	return !a.label || a.label === a.email ? a.email : `${a.label} <${a.email}>`
}
export function parseAddresses(value: string): Address[] {
	return value.split(/[,\n;]/).map((part) => part.trim()).filter(Boolean).map((part) => {
		const m = /^(.*?)<([^>]+)>\s*$/.exec(part)
		const email = (m?.[2] ?? part).trim()
		return { label: (m?.[1] ?? email).trim().replace(/^['"]|['"]$/g, '') || email, email }
	})
}
export function addressText(addresses: Address[]) {
	return addresses.map(formatAddress).join(', ')
}
export const displayAddress = (a?: Address) => a?.label || a?.email || 'Unknown sender'
export function specialMailbox(boxes: Mailbox[], role: string, accountId?: number) {
	return boxes.find((b) => b.specialRole === role && (!accountId || b.accountId === accountId))
}
export function folderLabel(box: Mailbox) {
	const special: Record<string, string> = { inbox: 'Inbox', drafts: 'Drafts', sent: 'Sent', trash: 'Trash', archive: 'Archive', junk: 'Spam', flagged: 'Starred', snoozed: 'Snoozed' }
	return special[box.specialRole] ?? box.name.split(box.delimiter).pop() ?? box.name
}
export function mailboxIcon(box: Mailbox) {
	return ({ inbox: 'inbox', drafts: 'draft', sent: 'send', trash: 'delete', archive: 'archive', all: 'archive', junk: 'warning', flagged: 'star', snoozed: 'schedule' } as Record<string, string>)[box.specialRole] ?? 'folder'
}
export function searchFilter(value: string) {
	const q = value.trim()
	if (!q) return ''
	// Advanced filters (from:x subject:y is:unread ...) pass through as typed.
	if (/^\w+:/.test(q)) return q
	// Plain text: match subject, sender or recipient (any of), like upstream Mail's search box.
	const v = encodeURIComponent(q)
	return `subject:${v} from:${v} to:${v} match:anyof`
}

// Atrium triage: classification pipeline (decisions API through tollgate).
export interface Triage {
	category: string | null, categoryConfidence: number | null
	urgency: string | null, urgencyScore: number | null
	needsReply: number | null, needsAction: number | null, hasDeadline: number | null
	writtenByPerson: number | null, suspicious: number | null, classifiedAt: number | null
	/** Queue state: done, pending (waiting), parked (gave up after 5 tries), none (folder not classified). */
	queue?: 'done' | 'pending' | 'parked' | 'none', attempts?: number, error?: string | null
}
export interface TriageStatus {
	now: number
	canManage: boolean
	settings: { enabled: boolean, backend?: 'ai' | 'tollgate', configured: boolean, capTotalEur: number, capBackfillEur: number, model: string, questionsVersion: string, timezone: string }
	state: { state: string, pausedUntil: number | null, lastRun: number | null, lastOk: number | null, lastScan: number | null, lastError: string | null, lastErrorAt: number | null }
	spent: { todayEur: number, todayBackfillEur: number, monthEur: number }
	queue: { pendingNew: number, pendingBacklog: number, done: number, parked: number }
	/** DB-first bookkeeping: writes waiting for the mail server, reader copies to fill, attachments kept (downloaded only). */
	sync?: { pendingWrites: number, failedWrites: number, readerTodo: number, readerUnavailable: number, attachments: number, attachmentBytes: number }
	accounts: { id: number, email: string, name: string, pendingNew: number, pendingBacklog: number, done: number, parked: number }[]
	categories: { category: string, count: number }[]
	urgency: { urgency: string, count: number }[]
	daily: { day: string, count: number, eur: number }[]
	recent: { subject: string | null, messageId: number | null, category: string | null, urgency: string | null, needsReply: number | null, needsAction: number | null, suspicious: number | null, classifiedAt: number, costEur: number, tokens: number }[]
	problems: { subject: string | null, messageId: number | null, status: string, attempts: number, error: string | null, at: number }[]
	copy: { accountId: number, inList: number, withBody: number, missingBody: number, onlyInAtrium: number, keptRows: number, keptWithText: number, orphanTexts: number, bodiesTotal: number }[]
	folders: { id: number, accountId: number, name: string, specialUse: string[], serverMessages: number, serverUnread: number, cached: boolean, syncing: boolean, stored: number, kept: number, previews: number, queued: number, classified: number, bodies: number }[]
	jobs: { name: string, accountId: number | null, lastRun: number, running: boolean, duration: number }[]
}
export const triageStatus = () => mail<TriageStatus>('/triage/status')
export const triageFor = (ids: number[]) => ids.length ? mail<Record<string, Triage>>(`/triage/messages?ids=${ids.join(',')}`) : Promise.resolve({} as Record<string, Triage>)
export const reclassify = (id: number) => mail<{ queued: boolean, classified: boolean, reason: string | null, triage: Triage | null }>(`/triage/messages/${id}/reclassify`, { method: 'POST' })
export const setTriageEnabled = (enabled: boolean) => mail<{ enabled: boolean }>('/triage/enabled', { method: 'PUT', body: { enabled } })

export const categoryLabels: Record<string, string> = {
	personal: 'Personal', work: 'Work', school: 'School', admin: 'Admin', finance: 'Finance', orders: 'Orders', security: 'Security',
	calendar: 'Calendar', social: 'Social', newsletter: 'Newsletter', ads: 'Ads', spam: 'Spam', other: 'Other', unknown: 'Unknown',
}
export const urgencyLabels: Record<string, string> = { never: 'Never', whenever: 'Whenever', this_week: 'This week', today: 'Today', now: 'Now', unknown: 'Unknown' }

/** The categories offered as filters (the classifier's current set). */
export const filterCategories = ['personal', 'work', 'admin', 'orders', 'security', 'social', 'newsletter', 'ads', 'spam', 'other']
/**
 * Curated hides the noisy categories; mail not classified yet still shows.
 * The user picks them (Mail status page); stored as the Mail preference
 * `curated-hides` (JSON list), which the agent layer also reads: agents with
 * wakes on are woken only by mail that Curated shows (ADR 0009).
 */
export const DEFAULT_CURATED_HIDES = ['ads', 'spam', 'newsletter', 'social']
/** Current list, filled by loadCuratedHides(); mutated in place so imports stay live. */
export const curatedHides: string[] = [...DEFAULT_CURATED_HIDES]
const CURATED_KEY = 'curated-hides'

/** Stored preference -> list of known categories; anything unreadable means the default. */
export function parseCuratedHides(value: unknown): string[] {
	if (typeof value !== 'string' || value === '') return [...DEFAULT_CURATED_HIDES]
	try {
		const v = JSON.parse(value)
		return Array.isArray(v) ? filterCategories.filter((c) => v.includes(c)) : [...DEFAULT_CURATED_HIDES]
	} catch {
		return [...DEFAULT_CURATED_HIDES]
	}
}

export async function loadCuratedHides(): Promise<string[]> {
	const res = await mail<{ value: unknown }>(`/preferences/${CURATED_KEY}`)
	curatedHides.splice(0, curatedHides.length, ...parseCuratedHides(res.value))
	return [...curatedHides]
}

export async function saveCuratedHides(hides: string[]): Promise<void> {
	const list = filterCategories.filter((c) => hides.includes(c))
	await mail(`/preferences/${CURATED_KEY}`, { method: 'PUT', body: { key: CURATED_KEY, value: JSON.stringify(list) } })
	curatedHides.splice(0, curatedHides.length, ...list)
}

/** "Hides ads, spam and social" for the chip's tooltip. */
export function curatedTitle(hides: string[]): string {
	const names = hides.map((c) => (categoryLabels[c] ?? c).toLowerCase())
	if (!names.length) return 'Shows every category'
	return 'Hides ' + (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)
}
export interface LabelFilter { category: string, needsAction: boolean, curated: boolean }
export const noLabel: LabelFilter = { category: '', needsAction: false, curated: false }
export const defaultLabel: LabelFilter = { ...noLabel, curated: true }

/** Mails of the given folders that carry a label (category and/or needs action), newest first. */
export const listByLabel = (mailboxIds: number[], label: LabelFilter, opts: { cursor?: number, limit?: number } = {}) => {
	const q = new URLSearchParams({ mailboxIds: mailboxIds.join(','), limit: String(opts.limit ?? 20) })
	if (label.category) q.set('category', label.category)
	if (label.curated) q.set('exclude', curatedHides.join(','))
	if (label.needsAction) q.set('needsAction', '1')
	if (opts.cursor) q.set('cursor', String(opts.cursor))
	return mail<Message[]>(`/triage/list?${q}`)
}

/**
 * One list over several folders (both accounts' inboxes): every folder is asked
 * for a page, the pages are merged by date and only the newest `limit` kept.
 * The next page starts from the date of the last mail shown, so none is skipped.
 */
export async function listMerged(mailboxIds: number[], opts: { cursor?: number, filter?: string, limit?: number } = {}) {
	const limit = opts.limit ?? 20
	if (mailboxIds.length === 1) return listMessages(mailboxIds[0], { ...opts, limit })
	const pages = await Promise.all(mailboxIds.map((id) => listMessages(id, { ...opts, limit })))
	return pages.flat().sort((a, b) => b.dateInt - a.dateInt).slice(0, limit)
}

/** P5-2: a reply written by the user's AI (Settings > AI), as text for the composer. Nothing is sent or saved. */
export async function suggestReply(dbId: number, instruction?: string): Promise<{ subject: string, body: string, model: string }> {
	try {
		return await request(`/agent/v1/reply/suggest`, { method: 'POST', body: { db_id: dbId, save: false, ...(instruction ? { instruction } : {}) }, headers: { 'OCS-APIRequest': 'true' } })
	} catch (e) {
		if (e instanceof HttpError) throw new Error((e.body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${e.status}`)
		throw e
	}
}

/** P5-5: one-click unsubscribe (RFC 8058), through Mail's own route. */
export const unsubscribeList = (id: number) => mail<unknown>(`/list/unsubscribe/${id}`, { method: 'POST' })

/** mailto:list@x?subject=..&body=.. -> composer fields; null when it is not a mailto. */
export function parseMailto(href: string | null | undefined): { to: string, subject: string, body: string } | null {
	if (!href || !/^mailto:/i.test(href)) return null
	const [addr, query = ''] = href.slice(7).split('?')
	const q = new URLSearchParams(query)
	const to = decodeURIComponent(addr).trim()
	if (!/^[^@\s,]+@[^@\s,]+$/.test(to)) return null
	return { to, subject: q.get('subject') ?? 'unsubscribe', body: q.get('body') ?? '' }
}

/** P4-1: put a deleted mail back from Trash (found by Message-ID; Trash is synced first). */
export async function undoDelete(accountId: number, trashId: number, messageId: string, to: number): Promise<{ restored: boolean }> {
	await syncMailbox(trashId).catch(() => {})
	try {
		return await request(`/agent/v1/mail/undo-delete`, { method: 'POST', body: { account: accountId, message_id: messageId, to }, headers: { 'OCS-APIRequest': 'true' } })
	} catch (e) {
		if (e instanceof HttpError) throw new Error((e.body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${e.status}`)
		throw e
	}
}

/** P4-1: contacts and past correspondents matching `term` (Mail's own autocomplete). */
export interface Suggestion { id?: string | number, label: string, email: string }
export const autoComplete = (term: string) => mail<Suggestion[]>(`/autoComplete?term=${encodeURIComponent(term)}`)

/** P4-1: the other messages of a mail's thread (404 = no thread: empty). */
export async function getThread(id: number): Promise<Message[]> {
	try {
		return await mail<Message[]>(`/messages/${id}/thread`)
	} catch (e) {
		if (e instanceof HttpError && e.status === 404) return []
		throw e
	}
}

/** P4-1: snooze into the account's snooze folder until `at` (unix s); Mail's WakeJob brings it back. */
export const snoozeMessage = (id: number, at: number, snoozeMailboxId: number) => mail(`/messages/${id}/snooze`, { method: 'POST', body: { unixTimestamp: at, destMailboxId: snoozeMailboxId } })
