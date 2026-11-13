// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contacts tools (PLAN P3-3, ADR 0005): simple fields (name, emails, phones,
// org, title, note, birthday; addresses read only), never the raw vCard.
// The work is done by PHP (apps/contacts/lib/Controller/AtriumAgentController.php)
// through Nextcloud's CardDAV backend, so phones and DAV clients stay in sync.
//
// Ids: contact_id = "<address book id>/<card uri>". Deleting asks the owner by
// default (contacts:delete = approval) and keeps a copy of the vCard for 30
// days in atrium_agent_contacts_trash: contacts_contact_restore puts it back.
import type { AgentModule, LayerCore } from '../index'
import type { Db } from '../db'
import { num } from '../db'
import { arr, int, obj, type Schema, str } from '../schema'
import type { Tool, ToolCtx } from '../tools'
import { AgentError, iso, nowSec, randomToken } from '../util'

export const TRASH_DAYS = 30

export interface PhpContact {
	addressbook: number
	card: string
	etag: string
	updated: number
	name: string
	given_name: string | null
	family_name: string | null
	emails: Array<{ value: string, type: string | null }>
	phones: Array<{ value: string, type: string | null }>
	org: string | null
	title: string | null
	note: string | null
	birthday: string | null
	addresses: Array<Record<string, string | null>>
}

export interface AddressBook { id: number, name: string, read_only: boolean, shared_by: string | null }

/** The PHP side. Each call acts as `uid` (the grantor). */
export interface ContactsBridge {
	addressbooks(uid: string): Promise<AddressBook[]>
	list(uid: string, q: { addressbook?: number, query?: string, limit: number, offset: number }): Promise<{ contacts: PhpContact[], total: number }>
	get(uid: string, book: number, card: string): Promise<PhpContact>
	create(uid: string, book: number | undefined, contact: Record<string, unknown>): Promise<PhpContact>
	update(uid: string, book: number, card: string, contact: Record<string, unknown>, etag?: string): Promise<PhpContact>
	delete(uid: string, book: number, card: string): Promise<{ carddata: string }>
	restore(uid: string, book: number, card: string, carddata: string): Promise<PhpContact>
}

export function phpContacts(core: Pick<LayerCore, 'php'>): ContactsBridge {
	const call = <T>(path: string, body: Record<string, unknown>) => core.php.app<T>('POST', `apps/contacts/api/atrium-agent/${path}`, { body })
	return {
		addressbooks: async (uid) => (await call<{ addressbooks: AddressBook[] }>('addressbooks', { uid })).addressbooks,
		list: (uid, q) => call('list', { uid, ...q }),
		get: (uid, addressbook, card) => call('get', { uid, addressbook, card }),
		create: (uid, addressbook, contact) => call('create', { uid, addressbook, contact }),
		update: (uid, addressbook, card, contact, etag) => call('update', { uid, addressbook, card, contact, etag }),
		delete: (uid, addressbook, card) => call('delete', { uid, addressbook, card }),
		restore: (uid, addressbook, card, carddata) => call('restore', { uid, addressbook, card, carddata }),
	}
}

export const contactId = (book: number, card: string): string => `${book}/${card}`

export function parseContactId(id: string): { book: number, card: string } {
	const m = /^(\d+)\/([^/]+)$/.exec(id)
	if (!m) throw new AgentError('invalid_input', `Not a contact_id: ${id} (expected "<addressbook>/<card>", from contacts_contact_list)`)
	return { book: Number(m[1]), card: m[2] }
}

/** What agents see. */
export function view(c: PhpContact) {
	const { addressbook, card, updated, ...fields } = c
	return { contact_id: contactId(addressbook, card), addressbook, ...fields, updated: iso(updated) }
}

const entry = (what: string): Schema => ({
	anyOf: [str(what), obj({ value: str(what), type: str('home, work, cell, ... (optional)') }, ['value'])],
})

// Every field takes null to clear it on update.
const nullable = (sch: Schema): Schema => ({ ...sch, type: [sch.type as 'string' | 'array', 'null'] })
const fieldSchemas: Record<string, Schema> = Object.fromEntries(Object.entries({
	name: str('Full name as shown (FN). Defaults to given + family name.', { maxLength: 500 }),
	given_name: str(undefined, { maxLength: 200 }),
	family_name: str(undefined, { maxLength: 200 }),
	emails: arr(entry('Email address'), 'Replaces all emails', { maxItems: 20 }),
	phones: arr(entry('Phone number'), 'Replaces all phone numbers', { maxItems: 20 }),
	org: str('Company or organisation', { maxLength: 500 }),
	title: str('Job title', { maxLength: 500 }),
	note: str(undefined, { maxLength: 10000 }),
	birthday: str('YYYY-MM-DD, or --MM-DD without a year'),
} as Record<string, Schema>).map(([k, v]) => [k, nullable(v)]))
const FIELDS = Object.keys(fieldSchemas)

/** Only the contact fields of a tool input; explicit nulls clear a field. */
function fieldsOf(input: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const k of FIELDS) if (k in input) out[k] = input[k]
	return out
}

/** Copies of deleted cards, for contacts_contact_restore. */
export async function migrateTrash(db: Db): Promise<void> {
	await db.q(`CREATE TABLE IF NOT EXISTS ${db.t('atrium_agent_contacts_trash')} (
		id VARCHAR(32) PRIMARY KEY,
		grantor_uid VARCHAR(64) NOT NULL,
		agent_uid VARCHAR(64) NOT NULL,
		addressbook BIGINT NOT NULL,
		card VARCHAR(255) NOT NULL,
		name TEXT NOT NULL,
		carddata TEXT NOT NULL,
		deleted_at BIGINT NOT NULL)`)
	await db.q(`CREATE INDEX IF NOT EXISTS ${db.t('atrium_agent_contacts_trash_g')} ON ${db.t('atrium_agent_contacts_trash')} (grantor_uid, deleted_at)`)
}

export async function purgeTrash(db: Db, now = nowSec()): Promise<void> {
	await db.q(`DELETE FROM ${db.t('atrium_agent_contacts_trash')} WHERE deleted_at < $1`, [now - TRASH_DAYS * 86400])
}

export function contactsTools(bridge: ContactsBridge, ready: () => Promise<void>): Tool[] {
	const T = (ctx: ToolCtx) => ctx.db.t('atrium_agent_contacts_trash')
	return [
		{
			name: 'contacts_addressbook_list',
			description: 'Address books: id, name, read_only, shared_by (owner when shared with the user).',
			area: 'contacts',
			input: obj({}),
			run: async (ctx) => ({ addressbooks: await bridge.addressbooks(ctx.grantor) }),
		},
		{
			name: 'contacts_contact_list',
			description: 'Contacts sorted by name, optionally filtered: query matches name, organisation, emails, and phone digits (3+). Each has contact_id, name, emails, phones, org, title, note, birthday, addresses, etag.',
			area: 'contacts',
			input: obj({
				query: str(undefined, { maxLength: 200 }),
				addressbook: int('Only this address book'),
				limit: int('Default 50, max 200', { minimum: 1, maximum: 200 }),
				cursor: str('next_cursor of the previous page'),
			}),
			run: async (ctx, input) => {
				const limit = input.limit === undefined ? 50 : num(input.limit)
				const offset = input.cursor === undefined ? 0 : Number(input.cursor)
				if (!Number.isInteger(offset) || offset < 0) throw new AgentError('invalid_input', 'Bad cursor')
				const res = await bridge.list(ctx.grantor, {
					addressbook: input.addressbook === undefined ? undefined : num(input.addressbook),
					query: input.query === undefined ? undefined : String(input.query),
					limit,
					offset,
				})
				const next = offset + res.contacts.length
				return { contacts: res.contacts.map(view), total: res.total, next_cursor: next < res.total ? String(next) : null }
			},
		},
		{
			name: 'contacts_contact_get',
			description: 'One contact by contact_id.',
			area: 'contacts',
			input: obj({ contact_id: str() }, ['contact_id']),
			run: async (ctx, input) => {
				const { book, card } = parseContactId(String(input.contact_id))
				return view(await bridge.get(ctx.grantor, book, card))
			},
		},
		{
			name: 'contacts_contact_create',
			description: 'Add a contact. Needs at least a name, an email or a phone. Goes to the user\'s first own address book unless `addressbook` is given.',
			area: 'contacts',
			action: 'write',
			input: obj({ addressbook: int(), ...fieldSchemas }),
			run: async (ctx, input) => {
				const fields = fieldsOf(input)
				if (!fields.name && !fields.given_name && !fields.family_name && !(fields.emails as unknown[] | undefined)?.length && !(fields.phones as unknown[] | undefined)?.length) {
					throw new AgentError('invalid_input', 'A contact needs a name, an email or a phone')
				}
				return view(await bridge.create(ctx.grantor, input.addressbook === undefined ? undefined : num(input.addressbook), fields))
			},
		},
		{
			name: 'contacts_contact_update',
			description: 'Change some fields of a contact; fields left out stay as they are, null clears one. emails / phones replace the whole list. Pass the etag you read to refuse the change if someone edited the contact meanwhile. Other vCard data (photo, custom fields) is kept.',
			area: 'contacts',
			action: 'write',
			input: obj({ contact_id: str(), etag: str(), ...fieldSchemas }, ['contact_id']),
			run: async (ctx, input) => {
				const { book, card } = parseContactId(String(input.contact_id))
				const fields = fieldsOf(input)
				if (!Object.keys(fields).length) throw new AgentError('invalid_input', 'Nothing to change')
				return view(await bridge.update(ctx.grantor, book, card, fields, input.etag === undefined ? undefined : String(input.etag)))
			},
		},
		{
			name: 'contacts_contact_delete',
			description: `Delete a contact (asks the owner unless allowed). A copy is kept ${TRASH_DAYS} days: contacts_contact_restore with the returned restore_id puts it back.`,
			area: 'contacts',
			action: 'delete',
			input: obj({ contact_id: str() }, ['contact_id']),
			prepare: async (ctx, input) => {
				const { book, card } = parseContactId(String(input.contact_id))
				const c = await bridge.get(ctx.grantor, book, card)
				const what = [c.name, c.emails[0]?.value].filter(Boolean).join(', ')
				return { payload: { contact_id: input.contact_id, etag: c.etag }, summary: `Delete contact: ${what}`, ref: `contact:${input.contact_id}` }
			},
			// Approved later: void if the contact was edited (or is gone) since the request.
			stillValid: async (ctx, payload) => {
				const p = payload as { contact_id: string, etag?: string }
				const { book, card } = parseContactId(p.contact_id)
				try {
					return p.etag === undefined || (await bridge.get(ctx.grantor, book, card)).etag === p.etag
				} catch (e) {
					if (e instanceof AgentError && e.code === 'not_found') return false
					throw e
				}
			},
			execute: async (ctx, payload) => {
				const { contact_id } = payload as { contact_id: string }
				const { book, card } = parseContactId(contact_id)
				await ready()
				const c = await bridge.get(ctx.grantor, book, card)
				const { carddata } = await bridge.delete(ctx.grantor, book, card)
				const restoreId = 'ct_' + randomToken(12)
				await ctx.db.q(`INSERT INTO ${T(ctx)} (id, grantor_uid, agent_uid, addressbook, card, name, carddata, deleted_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
					[restoreId, ctx.grantor, ctx.agent.uid, book, card, c.name, carddata, nowSec()])
				return { contact_id, deleted: true, restore_id: restoreId, restorable_until: iso(nowSec() + TRASH_DAYS * 86400) }
			},
		},
		{
			name: 'contacts_contact_deleted',
			description: `Contacts deleted through the agent layer in the last ${TRASH_DAYS} days (by any agent), newest first, with their restore_id.`,
			area: 'contacts',
			input: obj({}),
			run: async (ctx) => {
				await ready()
				const rows = await ctx.db.q<Record<string, unknown>>(
					`SELECT id, agent_uid, addressbook, card, name, deleted_at FROM ${T(ctx)} WHERE grantor_uid = $1 AND deleted_at >= $2 ORDER BY deleted_at DESC LIMIT 200`,
					[ctx.grantor, nowSec() - TRASH_DAYS * 86400])
				return {
					deleted: rows.map((r) => ({
						restore_id: r.id, contact_id: contactId(num(r.addressbook), String(r.card)), name: r.name, deleted_by: r.agent_uid, deleted_at: iso(num(r.deleted_at)),
					})),
				}
			},
		},
		{
			name: 'contacts_contact_restore',
			description: 'Put back a contact deleted through the agent layer (same contact_id).',
			area: 'contacts',
			action: 'write',
			input: obj({ restore_id: str() }, ['restore_id']),
			run: async (ctx, input) => {
				await ready()
				const [r] = await ctx.db.q<Record<string, unknown>>(
					`SELECT * FROM ${T(ctx)} WHERE id = $1 AND grantor_uid = $2 AND deleted_at >= $3`, [String(input.restore_id), ctx.grantor, nowSec() - TRASH_DAYS * 86400])
				if (!r) throw new AgentError('not_found', `Nothing to restore for ${String(input.restore_id)}`)
				const c = await bridge.restore(ctx.grantor, num(r.addressbook), String(r.card), String(r.carddata))
				await ctx.db.q(`DELETE FROM ${T(ctx)} WHERE id = $1`, [r.id])
				return { restored: true, contact: view(c) }
			},
		},
	]
}

export function contactsModule(make: (core: LayerCore) => ContactsBridge = phpContacts): AgentModule {
	let timer: ReturnType<typeof setInterval> | null = null
	let migrated: Promise<void> | null = null
	let db: Db | null = null
	const ready = () => {
		if (!db) return Promise.reject(new AgentError('unavailable', 'Contacts module not started'))
		migrated ??= migrateTrash(db).catch((e) => { migrated = null; throw e })
		return migrated
	}
	return {
		tools: (core) => {
			db = core.db
			return contactsTools(make(core), ready)
		},
		start: (core) => {
			db = core.db
			void ready().catch((e) => console.error(`agent contacts: ${(e as Error).message}`))
			timer = setInterval(() => { void purgeTrash(core.db).catch((e) => console.error(`agent contacts purge: ${(e as Error).message}`)) }, 3600_000)
		},
		stop: () => { if (timer) clearInterval(timer) },
	}
}
