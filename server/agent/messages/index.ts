// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Messages (ADR 0010): SMS and RCS from the user's phone, through Google
// Messages and the sidecar (services/gmessages). Wavium keeps its own copy of
// every message; the pairing session is sealed (AES-256-GCM, instance secret).
//
// Owner routes (session; OCS-APIRequest on writes), /agent/v1/messages:
//   GET    /status                       link state, phone, QR or emoji while pairing
//   POST   /link/qr                      start pairing with a QR code -> {qr}
//   POST   /link/google {cookies}        start pairing with the Google account -> {emoji}
//   DELETE /link                         unlink the phone (messages stay)
//   GET    /conversations?q=&unread=1
//   POST   /conversations {number}       open (or find) a conversation
//   GET    /conversations/<id>/messages?before=&limit=
//   POST   /conversations/<id>/read
//   POST   /send {conversation_id, text}
//   GET    /search?q=
//   GET    /media/<message id>/<index>
//   GET    /agents                       agents and whether they may see one-time codes
//   PUT    /agents/<agent uid> {show_codes}
//
// Agent tools (area "messages"): messages_conversation_list, messages_message_list,
// messages_search (read), messages_mark_read (write), messages_send (send:
// approval by default). One-time codes are hidden from agents unless allowed.
import { keyCipher, type KeyCipher } from '../ai'
import { loadPublicDemo } from '../../publicdemo'
import { phpContacts, type ContactsBridge } from '../contacts'
import { enqueue } from '../events'
import type { AgentModule, LayerCore } from '../index'
import type { Tool, ToolCtx } from '../tools'
import { AgentError, nowSec, ulid } from '../util'
import { demoConversations } from './demo'
import { forAgent } from './otp'
import { httpSidecar, type SideEvent, type Sidecar } from './sidecar'
import { type ConversationRow, type Link, type MessageRow, MessageStore, type SideConversation, type SideMessage } from './store'

export const MAX_TEXT = 2000

export interface MessagesOptions {
	sidecar: Sidecar | null
	/** Public demo / no sidecar: fake conversations, nothing really sent. */
	demo: boolean
	contacts?: (core: LayerCore) => ContactsBridge
	/** Delay of the demo's automatic answer (ms). */
	demoReplyMs?: number
}

const digits = (n: string) => n.replace(/\D/g, '')
/** Last 9 digits: "+33 6 12 34 56 78" and "06 12 34 56 78" are the same number. */
export const numberKey = (n: string): string => digits(n).slice(-9)

export class MessagesService {
	readonly store: MessageStore
	private cipher: KeyCipher
	private pairing = new Map<string, { qr?: string, emoji?: string, error?: string }>()
	private names = new Map<string, { at: number, map: Map<string, string> }>()
	private abort = new AbortController()

	constructor(private core: LayerCore, private opts: MessagesOptions) {
		this.store = new MessageStore(core.db)
		this.cipher = keyCipher(core.cfg.secret)
	}

	get sidecar(): Sidecar | null { return this.opts.sidecar }

	private seal(uid: string, session: unknown): string {
		return this.cipher.seal(JSON.stringify(session), `messages:${uid}`)
	}

	private unseal(uid: string, sealed: string): unknown {
		return JSON.parse(this.cipher.open(sealed, `messages:${uid}`))
	}

	// --- life cycle -----------------------------------------------------------

	listen(): void {
		const side = this.opts.sidecar
		if (!side) return
		void side.listen((e) => { void this.onEvent(e).catch((err) => console.error(`messages event ${e.type}: ${(err as Error).message}`)) },
			this.abort.signal, () => { void this.restore() })
	}

	stop(): void {
		this.abort.abort()
	}

	/** After the sidecar (re)starts: hand it every stored session. */
	async restore(): Promise<void> {
		const side = this.opts.sidecar
		if (!side) return
		for (const link of await this.store.linked()) {
			try {
				const st = await side.status(link.uid)
				if (st.state === 'connected' || st.state === 'connecting' || st.state === 'phone_offline') continue
				await side.connect(link.uid, this.unseal(link.uid, link.session!))
				await this.store.setLink(link.uid, { state: 'connected', error: null })
				void this.sync(link.uid).catch(() => {})
			} catch (e) {
				await this.store.setLink(link.uid, { state: 'error', error: (e as Error).message })
			}
		}
	}

	async onEvent(e: SideEvent): Promise<void> {
		const uid = e.uid
		if (!uid) return
		switch (e.type) {
			case 'qr':
				this.pairing.set(uid, { qr: e.qr })
				break
			case 'pair_failed':
				this.pairing.set(uid, { error: e.error ?? 'Pairing failed' })
				await this.store.setLink(uid, { state: 'unpaired', error: e.error ?? 'Pairing failed' })
				break
			case 'paired':
				this.pairing.delete(uid)
				await this.store.setLink(uid, { state: 'connected', session: this.seal(uid, e.session), phone: e.phone ?? null, linked_at: nowSec(), offline_since: null, error: null })
				// The phone needs a moment before it answers list requests.
				setTimeout(() => { void this.sync(uid).catch((err) => console.error(`messages sync ${uid}: ${(err as Error).message}`)) }, 3000)
				break
			case 'session':
				if (e.session) await this.store.setLink(uid, { session: this.seal(uid, e.session) })
				break
			case 'conversation':
				if (e.conversation) await this.store.upsertConversation(uid, e.conversation)
				break
			case 'message':
				if (e.conversation) await this.store.upsertConversation(uid, e.conversation)
				if (e.message) await this.receive(uid, e.message, true)
				break
			case 'phone_offline': {
				await this.store.setLink(uid, { state: 'phone_offline', offline_since: nowSec() })
				await enqueue(this.core.db, { app: 'messages', area: 'messages', type: 'messages.phone_offline', grantor: uid, wakeHint: false, data: { since: new Date().toISOString() } })
				break
			}
			case 'phone_online':
				await this.store.setLink(uid, { state: 'connected', offline_since: null })
				break
			case 'logged_out':
				await this.store.setLink(uid, { state: 'logged_out', session: null, error: e.error ?? 'The phone unlinked Wavium' })
				break
		}
	}

	/** Stores a message from the phone; new incoming ones become agent events. */
	async receive(uid: string, m: SideMessage, live: boolean): Promise<void> {
		if (!(await this.store.hasConversation(uid, m.conversation_id)) && this.opts.sidecar) {
			try {
				const convs = await this.opts.sidecar.conversations(uid, 30)
				for (const c of convs) await this.store.upsertConversation(uid, c)
			} catch { /* stored anyway; the next sync names it */ }
		}
		const fresh = await this.store.upsertMessage(uid, m)
		if (!fresh) {
			if (m.status === 'failed') await this.event(uid, 'message.failed', m)
			return
		}
		if (!m.from_me) await this.store.setUnread(uid, m.conversation_id, true)
		void this.fetchMedia(uid, m)
		if (live && m.at > Date.now() - 3_600_000) await this.event(uid, m.from_me ? 'message.sent' : 'message.received', m)
	}

	private async event(uid: string, type: string, m: SideMessage): Promise<void> {
		const row = await this.store.message(uid, m.id)
		await enqueue(this.core.db, {
			app: 'messages', area: 'messages', type, grantor: uid, wakeHint: type === 'message.received',
			dedupeKey: `messages:${uid}:${m.id}:${type}`,
			data: {
				conversation_id: m.conversation_id, message_id: m.id, from: m.from_me ? null : (m.sender_name || m.sender_number),
				// Events go to every agent of the user: codes are never in them.
				text: forAgent((m.text ?? '').slice(0, 500), row?.one_time_code ?? false, false), at: new Date(m.at).toISOString(),
			},
		})
	}

	private async fetchMedia(uid: string, m: SideMessage): Promise<void> {
		const side = this.opts.sidecar
		if (!side) return
		for (const [i, x] of (m.media ?? []).entries()) {
			if (!x.id || !x.key || x.size > 20 * 1024 * 1024) continue
			try {
				await this.store.saveMedia(uid, m.id, i, x.mime || 'application/octet-stream', await side.media(uid, x.id, x.key))
			} catch (e) {
				console.error(`messages media ${uid}: ${(e as Error).message}`)
			}
		}
	}

	/** Pulls conversations and recent messages from the phone. */
	async sync(uid: string, convCount = 50, msgCount = 30): Promise<{ conversations: number, messages: number }> {
		const side = this.opts.sidecar
		if (!side) return { conversations: 0, messages: 0 }
		const convs = await side.conversations(uid, convCount)
		let messages = 0
		for (const c of convs) {
			await this.store.upsertConversation(uid, c)
			for (const m of await side.messages(uid, c.id, msgCount)) {
				if (await this.store.upsertMessage(uid, m)) { messages++; void this.fetchMedia(uid, m) }
			}
		}
		return { conversations: convs.length, messages }
	}

	// --- demo -----------------------------------------------------------------

	async ensureDemo(uid: string): Promise<void> {
		if (!this.opts.demo || this.opts.sidecar) return
		const link = await this.store.link(uid)
		if (link) return
		for (const { conversation, messages } of demoConversations(uid, Date.now())) {
			await this.store.upsertConversation(uid, conversation)
			for (const m of messages) await this.store.upsertMessage(uid, m)
		}
		await this.store.setLink(uid, { state: 'demo', phone: 'Demo phone', linked_at: nowSec() })
	}

	// --- what the owner and the agents call --------------------------------------

	async status(uid: string) {
		await this.ensureDemo(uid)
		const link = await this.store.link(uid)
		const pairing = this.pairing.get(uid)
		let state = link?.state ?? 'unpaired'
		let qr = pairing?.qr ?? null
		let emoji = pairing?.emoji ?? null
		if (this.opts.sidecar && (state === 'pairing' || state === 'unpaired')) {
			try {
				const st = await this.opts.sidecar.status(uid)
				if (st.state === 'pairing') { state = 'pairing'; qr = st.qr ?? qr; emoji = st.emoji ?? emoji }
			} catch { /* sidecar down: say what we know */ }
		}
		return {
			state,
			available: !!this.opts.sidecar || this.opts.demo,
			demo: !this.opts.sidecar && this.opts.demo,
			phone: link?.phone ?? null,
			linked_at: link?.linked_at ? new Date(link.linked_at * 1000).toISOString() : null,
			offline_since: link?.offline_since ? new Date(link.offline_since * 1000).toISOString() : null,
			error: pairing?.error ?? link?.error ?? null,
			qr, emoji,
			counts: await this.store.counts(uid),
		}
	}

	private need(): Sidecar {
		if (!this.opts.sidecar) {
			throw new AgentError('unavailable', this.opts.demo ? 'This is a demo: linking a real phone is off.' : 'The Messages service is not set up on this server (see docs: services/gmessages).')
		}
		return this.opts.sidecar
	}

	async linkQr(uid: string): Promise<{ qr: string }> {
		const side = this.need()
		this.pairing.delete(uid)
		const res = await side.pairQr(uid)
		this.pairing.set(uid, { qr: res.qr })
		await this.store.setLink(uid, { state: 'pairing', error: null })
		return res
	}

	async linkGoogle(uid: string, cookies: Record<string, string>): Promise<{ emoji: string }> {
		const side = this.need()
		this.pairing.delete(uid)
		const res = await side.pairGoogle(uid, cookies)
		this.pairing.set(uid, { emoji: res.emoji })
		await this.store.setLink(uid, { state: 'pairing', error: null })
		return res
	}

	async unlink(uid: string): Promise<void> {
		if (this.opts.sidecar) {
			try { await this.opts.sidecar.unpair(uid) } catch (e) { console.error(`messages unlink ${uid}: ${(e as Error).message}`) }
		}
		this.pairing.delete(uid)
		await this.store.setLink(uid, { state: 'unpaired', session: null, offline_since: null, error: null })
	}

	/** Contact names by phone number (Contacts app), cached 10 minutes. */
	async contactNames(uid: string): Promise<Map<string, string>> {
		const hit = this.names.get(uid)
		if (hit && Date.now() - hit.at < 600_000) return hit.map
		const map = new Map<string, string>()
		try {
			const bridge = (this.opts.contacts ?? phpContacts)(this.core)
			const { contacts } = await bridge.list(uid, { limit: 2000, offset: 0 })
			for (const c of contacts) for (const p of c.phones ?? []) if (numberKey(p.value).length >= 6) map.set(numberKey(p.value), c.name)
		} catch { /* Contacts off: numbers stay numbers */ }
		this.names.set(uid, { at: Date.now(), map })
		return map
	}

	/** Names a conversation after the contact when the phone only knows a number. */
	named(c: ConversationRow, names: Map<string, string>): ConversationRow & { contact: string | null } {
		const others = c.participants.filter((p) => !p.is_me)
		const contact = others.length === 1 && others[0].number ? names.get(numberKey(others[0].number)) ?? null : null
		const looksLikeNumber = !c.name || /^[+\d\s().-]+$/.test(c.name)
		return { ...c, name: contact && looksLikeNumber ? contact : c.name || others.map((p) => p.name || p.number).join(', '), contact }
	}

	async conversations(uid: string, opts: { query?: string, unreadOnly?: boolean, limit?: number } = {}) {
		await this.ensureDemo(uid)
		const names = await this.contactNames(uid)
		let rows = (await this.store.conversations(uid, { ...opts, query: undefined, limit: opts.query ? 500 : opts.limit })).map((c) => this.named(c, names))
		if (opts.query) {
			const q = opts.query.toLowerCase()
			rows = rows.filter((c) => c.name.toLowerCase().includes(q) || c.participants.some((p) => p.number.includes(opts.query!) || p.name.toLowerCase().includes(q))).slice(0, opts.limit ?? 100)
		}
		return rows
	}

	async send(uid: string, conversation: string, text: string): Promise<{ message_id: string, status: string }> {
		text = text.trim()
		if (!text) throw new AgentError('invalid_input', 'Empty message')
		if (text.length > MAX_TEXT) throw new AgentError('invalid_input', `Messages are limited to ${MAX_TEXT} characters`)
		const conv = await this.store.conversation(uid, conversation)
		if (!conv) throw new AgentError('not_found', `No conversation ${conversation}`)
		if (conv.read_only) throw new AgentError('forbidden', 'This conversation does not take answers (short code or broadcast)')
		const tmp = ulid()
		const placeholder: SideMessage = { id: `tmp:${tmp}`, conversation_id: conversation, at: Date.now(), from_me: true, sender_id: 'me', sender_name: '', sender_number: '', text, status: 'sending', media: [], tmp_id: tmp }
		if (!this.opts.sidecar) {
			if (!this.opts.demo) this.need()
			const id = `demo:${tmp}`
			await this.store.upsertMessage(uid, { ...placeholder, id, status: 'sent', tmp_id: undefined })
			await this.store.setUnread(uid, conversation, false)
			this.demoReply(uid, conv)
			return { message_id: id, status: 'sent' }
		}
		await this.store.upsertMessage(uid, placeholder)
		try {
			await this.opts.sidecar.send(uid, conversation, text, tmp)
		} catch (e) {
			await this.store.upsertMessage(uid, { ...placeholder, status: 'failed' })
			await this.event(uid, 'message.failed', placeholder)
			throw e
		}
		await this.store.setUnread(uid, conversation, false)
		return { message_id: placeholder.id, status: 'sending' }
	}

	private demoReply(uid: string, conv: ConversationRow): void {
		const other = conv.participants.find((p) => !p.is_me)
		if (!other || conv.read_only) return
		setTimeout(() => {
			const reply: SideMessage = { id: `demo:${ulid()}`, conversation_id: conv.id, at: Date.now(), from_me: false, sender_id: other.id, sender_name: other.name, sender_number: other.number, text: 'Bien reçu 👍 (réponse automatique de la démo)', status: 'received', media: [] }
			void this.receive(uid, reply, true).catch(() => {})
		}, this.opts.demoReplyMs ?? 2500)
	}

	async open(uid: string, number: string): Promise<ConversationRow> {
		if (!/^\+?[0-9 ().-]{3,24}$/.test(number)) throw new AgentError('invalid_input', 'number: a phone number like +33 6 12 34 56 78')
		if (!this.opts.sidecar) {
			if (!this.opts.demo) this.need()
			const existing = (await this.store.conversations(uid, { limit: 500 })).find((c) => c.participants.some((p) => !p.is_me && numberKey(p.number) === numberKey(number)))
			if (existing) return existing
			const c: SideConversation = { id: `demo-${numberKey(number)}`, name: number, is_group: false, unread: false, last_at: Date.now(), kind: 'sms', read_only: false, outgoing_id: 'me', participants: [{ id: 'me', name: '', number: '', is_me: true }, { id: `p-${numberKey(number)}`, name: '', number, is_me: false }] }
			await this.store.upsertConversation(uid, c)
			return (await this.store.conversation(uid, c.id))!
		}
		const c = await this.opts.sidecar.start(uid, number)
		await this.store.upsertConversation(uid, c)
		return (await this.store.conversation(uid, c.id))!
	}

	async markRead(uid: string, conversation: string): Promise<void> {
		const conv = await this.store.conversation(uid, conversation)
		if (!conv) throw new AgentError('not_found', `No conversation ${conversation}`)
		await this.store.setUnread(uid, conversation, false)
		const [last] = (await this.store.messages(uid, conversation, { limit: 1 }))
		if (this.opts.sidecar && last && !last.id.startsWith('tmp:')) {
			try { await this.opts.sidecar.markRead(uid, conversation, last.id) } catch { /* local state is what the UI shows */ }
		}
	}

	async media(uid: string, msg: string, idx: number): Promise<{ mime: string, content: Uint8Array }> {
		const hit = await this.store.media(uid, msg, idx)
		if (hit) return hit
		const m = await this.store.message(uid, msg)
		const k = m?.media_keys[idx]
		if (!m || !k) throw new AgentError('not_found', 'No such picture')
		const content = await this.need().media(uid, k.id, k.key)
		await this.store.saveMedia(uid, msg, idx, k.mime || 'application/octet-stream', content)
		return { mime: k.mime || 'application/octet-stream', content }
	}
}

// --- agent tools ----------------------------------------------------------------

const msgForAgent = (m: MessageRow, show: boolean) => ({
	message_id: m.id, conversation_id: m.conversation_id, at: new Date(m.at).toISOString(), from_me: m.from_me,
	from: m.from_me ? null : (m.sender_name || m.sender_number || null), text: forAgent(m.text, m.one_time_code, show),
	status: m.status, attachments: m.media.map((x) => ({ name: x.name, mime: x.mime, size: x.size })),
	...(m.one_time_code && !show ? { one_time_code_hidden: true } : {}),
})

const convForAgent = (c: ConversationRow & { contact?: string | null }) => ({
	conversation_id: c.id, name: c.name, contact: c.contact ?? null, is_group: c.is_group, kind: c.kind, unread: c.unread,
	last_at: c.last_at ? new Date(c.last_at).toISOString() : null, read_only: c.read_only,
	numbers: c.participants.filter((p) => !p.is_me).map((p) => p.number).filter(Boolean),
})

export function messagesTools(svc: () => MessagesService): Tool[] {
	const show = (ctx: ToolCtx) => svc().store.showCodes(ctx.grantor, ctx.agent.uid)
	return [
		{
			name: 'messages_conversation_list', area: 'messages',
			description: 'List SMS/RCS conversations from the user\'s phone, newest first. `query` matches names and numbers; `unread_only` keeps the ones waiting.',
			input: { type: 'object', properties: { query: { type: 'string', maxLength: 100 }, unread_only: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
			run: async (ctx, i) => ({ conversations: (await svc().conversations(ctx.grantor, { query: i.query as string | undefined, unreadOnly: i.unread_only === true, limit: (i.limit as number) ?? 30 })).map(convForAgent) }),
		},
		{
			name: 'messages_message_list', area: 'messages',
			description: 'Messages of one conversation, oldest first (the last `limit`, or those before `before`). One-time codes are hidden unless the owner allowed this agent to see them.',
			input: { type: 'object', required: ['conversation_id'], properties: { conversation_id: { type: 'string', maxLength: 200 }, before: { type: 'string', description: 'ISO date' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
			run: async (ctx, i) => {
				const conv = await svc().store.conversation(ctx.grantor, i.conversation_id as string)
				if (!conv) throw new AgentError('not_found', `No conversation ${i.conversation_id}`)
				const before = i.before ? Date.parse(i.before as string) : undefined
				if (before !== undefined && Number.isNaN(before)) throw new AgentError('invalid_input', 'before: ISO date')
				const s = await show(ctx)
				return { conversation: convForAgent(svc().named(conv, await svc().contactNames(ctx.grantor))), messages: (await svc().store.messages(ctx.grantor, conv.id, { before, limit: (i.limit as number) ?? 50 })).map((m) => msgForAgent(m, s)) }
			},
		},
		{
			name: 'messages_search', area: 'messages',
			description: 'Search the text of every SMS/RCS kept by Wavium (also those deleted on the phone).',
			input: { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 2, maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
			run: async (ctx, i) => {
				const s = await show(ctx)
				// A code is not findable by its digits when the agent may not see it.
				const hits = (await svc().store.search(ctx.grantor, i.query as string, (i.limit as number) ?? 20)).filter((m) => s || !m.one_time_code || !/\d{3}/.test(i.query as string))
				return { results: hits.map((m) => ({ ...msgForAgent(m, s), conversation_name: m.conversation_name })) }
			},
		},
		{
			name: 'messages_mark_read', area: 'messages', action: 'write',
			description: 'Mark a conversation as read (on Wavium and on the phone).',
			input: { type: 'object', required: ['conversation_id'], properties: { conversation_id: { type: 'string', maxLength: 200 } }, additionalProperties: false },
			run: async (ctx, i) => { await svc().markRead(ctx.grantor, i.conversation_id as string); return { read: true } },
		},
		{
			name: 'messages_send', area: 'messages', action: 'send',
			description: `Send an SMS/RCS from the user's phone, to a conversation_id or a number. By default the owner approves each message first. Max ${MAX_TEXT} characters.`,
			input: { type: 'object', required: ['text'], properties: { conversation_id: { type: 'string', maxLength: 200 }, number: { type: 'string', maxLength: 30 }, text: { type: 'string', minLength: 1, maxLength: MAX_TEXT } }, additionalProperties: false },
			prepare: async (ctx, i) => {
				const text = String(i.text).trim()
				if (!text) throw new AgentError('invalid_input', 'text: empty')
				let conversation = i.conversation_id as string | undefined
				if (!conversation && !i.number) throw new AgentError('invalid_input', 'conversation_id or number')
				if (conversation) {
					const conv = await svc().store.conversation(ctx.grantor, conversation)
					if (!conv) throw new AgentError('not_found', `No conversation ${conversation}`)
					if (conv.read_only) throw new AgentError('forbidden', 'This conversation does not take answers')
					const named = svc().named(conv, await svc().contactNames(ctx.grantor))
					return { payload: { conversation_id: conversation, text }, summary: `Text "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}" to ${named.name}`, ref: `messages:${conversation}` }
				}
				const number = String(i.number)
				if (!/^\+?[0-9 ().-]{3,24}$/.test(number)) throw new AgentError('invalid_input', 'number: a phone number')
				return { payload: { number, text }, summary: `Text "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}" to ${number}` }
			},
			execute: async (ctx, payload) => {
				const p = payload as { conversation_id?: string, number?: string, text: string }
				const conv = p.conversation_id ?? (await svc().open(ctx.grantor, p.number!)).id
				return { ...(await svc().send(ctx.grantor, conv, p.text)), conversation_id: conv }
			},
		},
	]
}

// --- owner routes -----------------------------------------------------------------

async function body(req: Request): Promise<Record<string, unknown>> {
	const text = await req.text()
	if (text.length > 64 * 1024) throw new AgentError('invalid_input', 'Body too large')
	if (!text.trim()) return {}
	try {
		const v = JSON.parse(text)
		if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
		return v
	} catch {
		throw new AgentError('invalid_input', 'Body must be a JSON object')
	}
}

const COOKIE_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** Accepts {"SID": "...", ...} or a Cookie header line "SID=...; HSID=...". */
export function parseCookies(input: unknown): Record<string, string> {
	const out: Record<string, string> = {}
	if (typeof input === 'string') {
		for (const part of input.split(';')) {
			const i = part.indexOf('=')
			if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
		}
	} else if (input && typeof input === 'object' && !Array.isArray(input)) {
		for (const [k, v] of Object.entries(input)) if (typeof v === 'string') out[k] = v
	}
	for (const [k, v] of Object.entries(out)) {
		if (!COOKIE_NAME.test(k) || v.length > 4096 || /[\r\n]/.test(v)) delete out[k]
	}
	for (const need of ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID']) {
		if (!out[need]) throw new AgentError('invalid_input', `The ${need} cookie is missing (copy the cookies of messages.google.com while logged in)`)
	}
	return out
}

export function messagesModule(opts?: Partial<MessagesOptions>, env: Record<string, string | undefined> = process.env): AgentModule {
	let svc: MessagesService | null = null
	const url = env.ATRIUM_GMESSAGES_URL
	const secret = env.ATRIUM_GMESSAGES_SECRET ?? ''
	const resolved = (): MessagesOptions => ({
		sidecar: opts?.sidecar !== undefined ? opts.sidecar : (url && secret.length >= 32 && env.ATRIUM_PUBLIC_DEMO !== '1' ? httpSidecar(url, secret) : null),
		demo: opts?.demo ?? (loadPublicDemo(env).enabled || env.ATRIUM_MESSAGES_DEMO === '1'),
		contacts: opts?.contacts,
		demoReplyMs: opts?.demoReplyMs,
	})
	const get = (core?: LayerCore): MessagesService => {
		if (!svc) {
			if (!core) throw new AgentError('unavailable', 'Messages not started')
			svc = new MessagesService(core, resolved())
		}
		return svc
	}
	return {
		tools: (core) => { get(core); return messagesTools(() => get()) },
		start(core) { get(core).listen() },
		stop() { svc?.stop() },
		async route(core, req, url, path) {
			if (path !== '/agent/v1/messages' && !path.startsWith('/agent/v1/messages/')) return null
			const s = get(core)
			const who = await core.auth.owner(req)
			const uid = who.uid
			const sub = path.slice('/agent/v1/messages'.length) || '/'
			const m = req.method
			if (sub === '/status' && m === 'GET') return Response.json(await s.status(uid))
			if (sub === '/link/qr' && m === 'POST') return Response.json(await s.linkQr(uid))
			if (sub === '/link/google' && m === 'POST') return Response.json(await s.linkGoogle(uid, parseCookies((await body(req)).cookies)))
			if (sub === '/link' && m === 'DELETE') { await s.unlink(uid); return Response.json({ unlinked: true }) }
			if (sub === '/sync' && m === 'POST') return Response.json(await s.sync(uid))
			if (sub === '/conversations' && m === 'GET') {
				return Response.json({ conversations: await s.conversations(uid, { query: url.searchParams.get('q')?.slice(0, 100) || undefined, unreadOnly: url.searchParams.get('unread') === '1', limit: 200 }) })
			}
			if (sub === '/conversations' && m === 'POST') {
				const b = await body(req)
				return Response.json(s.named(await s.open(uid, String(b.number ?? '')), await s.contactNames(uid)))
			}
			const conv = /^\/conversations\/([^/]{1,200})\/(messages|read)$/.exec(sub)
			if (conv) {
				const id = decodeURIComponent(conv[1])
				if (conv[2] === 'messages' && m === 'GET') {
					const c = await s.store.conversation(uid, id)
					if (!c) throw new AgentError('not_found', 'No such conversation')
					const before = Number(url.searchParams.get('before')) || undefined
					const limit = Math.min(Number(url.searchParams.get('limit')) || 60, 200)
					return Response.json({ conversation: s.named(c, await s.contactNames(uid)), messages: await s.store.messages(uid, id, { before, limit }) })
				}
				if (conv[2] === 'read' && m === 'POST') { await s.markRead(uid, id); return Response.json({ read: true }) }
			}
			if (sub === '/send' && m === 'POST') {
				const b = await body(req)
				if (typeof b.conversation_id !== 'string' || typeof b.text !== 'string') throw new AgentError('invalid_input', 'conversation_id and text')
				return Response.json(await s.send(uid, b.conversation_id, b.text))
			}
			if (sub === '/search' && m === 'GET') {
				const q = (url.searchParams.get('q') ?? '').trim()
				if (q.length < 2) return Response.json({ results: [] })
				return Response.json({ results: await s.store.search(uid, q.slice(0, 100), 50) })
			}
			const media = /^\/media\/([^/]{1,200})\/(\d{1,2})$/.exec(sub)
			if (media && m === 'GET') {
				const f = await s.media(uid, decodeURIComponent(media[1]), Number(media[2]))
				// Pictures from strangers: never rendered as HTML/SVG on our origin.
				const safe = /^(image\/(png|jpeg|gif|webp|heic)|video\/(mp4|3gpp)|audio\/[\w.+-]+)$/.test(f.mime) ? f.mime : 'application/octet-stream'
				return new Response(f.content, { headers: { 'Content-Type': safe, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': safe === f.mime ? 'inline' : 'attachment', 'Content-Security-Policy': "default-src 'none'; sandbox" } })
			}
			if (sub === '/agents' && m === 'GET') {
				const res = await core.php.ocs<{ agents: Array<{ uid: string, displayName: string, owner: string }> }>('GET', 'core/atrium/agent/internal/agents', { query: { owner: uid } })
				const agents = (res.agents ?? []).filter((a) => a.owner === uid)
				return Response.json({ agents: await Promise.all(agents.map(async (a) => ({ uid: a.uid, name: a.displayName, show_codes: await s.store.showCodes(uid, a.uid) }))) })
			}
			const pref = /^\/agents\/([^/]{1,64})$/.exec(sub)
			if (pref && m === 'PUT') {
				const agent = decodeURIComponent(pref[1])
				const res = await core.php.ocs<{ agents: Array<{ uid: string, owner: string }> }>('GET', 'core/atrium/agent/internal/agents', { query: { uid: agent } })
				if (!res.agents?.[0] || res.agents[0].owner !== uid) throw new AgentError('not_found', 'Not one of your agents')
				const b = await body(req)
				await s.store.setShowCodes(uid, agent, b.show_codes === true)
				return Response.json({ uid: agent, show_codes: b.show_codes === true })
			}
			throw new AgentError('not_found', `No route ${req.method} ${path}`)
		},
	}
}
