// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contacts tools (P3-3) over a fake PHP bridge: grants, list paging, create /
// update / delete with approval, the 30-day copy and restore. The PHP side
// (vCard mapping, CardDAV writes) is checked by AtriumContactMapperTest and the
// dev-stack run in reports/P3-3.md.
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { normalizeModes, setAccess } from '../access'
import { Approvals } from '../approvals'
import { type Db, migrate, wrap } from '../db'
import { callTool, Registry, type ToolCtx } from '../tools'
import { AgentError } from '../util'
import { type AddressBook, type ContactsBridge, contactsTools, migrateTrash, parseContactId, type PhpContact, purgeTrash, TRASH_DAYS } from './index'

let db: Db
let cards: Map<string, PhpContact & { carddata: string }>
let books: AddressBook[]
let calls: string[]
let etagN = 0

const blank = (book: number, card: string, f: Record<string, unknown>) => ({
	addressbook: book, card, etag: `e${++etagN}`, updated: 1_700_000_000, name: '', given_name: null, family_name: null,
	emails: [], phones: [], org: null, title: null, note: null, birthday: null, addresses: [], carddata: '', ...f,
} as PhpContact & { carddata: string })

/** In-memory stand-in for apps/contacts' AtriumAgentController. */
const fake: ContactsBridge = {
	async addressbooks(uid) { calls.push(`books ${uid}`); return books },
	async list(uid, q) {
		calls.push(`list ${uid} ${JSON.stringify(q)}`)
		const all = [...cards.values()].filter((c) => q.addressbook === undefined || c.addressbook === q.addressbook)
			.filter((c) => !q.query || c.name.toLowerCase().includes(q.query.toLowerCase()))
			.sort((a, b) => a.name.localeCompare(b.name))
		return { contacts: all.slice(q.offset, q.offset + q.limit), total: all.length }
	},
	async get(_uid, book, card) {
		const c = cards.get(`${book}/${card}`)
		if (!c) throw new AgentError('not_found', 'No such contact')
		return c
	},
	async create(uid, book, contact) {
		calls.push(`create ${uid} ${book} ${JSON.stringify(contact)}`)
		const b = book ?? 1
		if (books.find((x) => x.id === b)?.read_only) throw new AgentError('invalid_input', 'shared read-only')
		const card = `new${cards.size}.vcf`
		const c = blank(b, card, { ...contact, name: String(contact.name ?? ''), carddata: `BEGIN:VCARD\nFN:${String(contact.name)}\nEND:VCARD` })
		cards.set(`${b}/${card}`, c)
		return c
	},
	async update(uid, book, card, contact, etag) {
		calls.push(`update ${uid} ${book}/${card} ${JSON.stringify(contact)} ${etag ?? '-'}`)
		const c = await fake.get(uid, book, card) as PhpContact & { carddata: string }
		if (etag && etag !== c.etag) throw new AgentError('conflict', 'The contact changed since it was read')
		const next = { ...c, ...contact, etag: `e${++etagN}` } as PhpContact & { carddata: string }
		cards.set(`${book}/${card}`, next)
		return next
	},
	async delete(uid, book, card) {
		calls.push(`delete ${uid} ${book}/${card}`)
		const c = await fake.get(uid, book, card) as PhpContact & { carddata: string }
		cards.delete(`${book}/${card}`)
		return { carddata: c.carddata }
	},
	async restore(uid, book, card, carddata) {
		calls.push(`restore ${uid} ${book}/${card}`)
		if (cards.has(`${book}/${card}`)) throw new AgentError('conflict', 'exists again')
		const c = blank(book, card, { name: /FN:(.*)/.exec(carddata)?.[1] ?? '', carddata })
		cards.set(`${book}/${card}`, c)
		return c
	},
}

let registry: Registry
let approvals: Approvals
let base: Omit<ToolCtx, 'grantor' | 'access'>

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	books = [{ id: 1, name: 'Contacts', read_only: false, shared_by: null }, { id: 2, name: 'Team', read_only: true, shared_by: 'bob' }]
	cards = new Map()
	calls = []
	for (const [n, name] of ['Zoé Durand', 'Anne Martin', 'Bruno Petit'].entries()) {
		cards.set(`1/c${n}.vcf`, blank(1, `c${n}.vcf`, { name, emails: [{ value: `${name.split(' ')[0].toLowerCase()}@example.org`, type: 'work' }], carddata: `BEGIN:VCARD\nFN:${name}\nEND:VCARD` }))
	}
	approvals = new Approvals(db, null, 'https://x/settings/agents')
	registry = new Registry()
	registry.add(...contactsTools(fake, () => migrateTrash(db)))
	approvals.registry = registry
	base = { db, php: null as never, agent: { uid: 'bot', displayName: 'Bot', owner: 'alice' }, baseUrl: 'https://x', approvals }
	approvals.ctxFor = async (_agent, grantor) => ({ ...base, grantor, access: {} } as ToolCtx)
})

const grant = (modes: Record<string, string>) => setAccess(db, 'bot', 'alice', 'contacts', normalizeModes(modes, ['read', 'write', 'delete', 'share']))
const call = (name: string, input: Record<string, unknown> = {}) => callTool(registry, base, name, input) as Promise<any>

test('contact ids', () => {
	expect(parseContactId('12/abc-DEF.vcf')).toEqual({ book: 12, card: 'abc-DEF.vcf' })
	for (const bad of ['abc', '12/', '/x.vcf', '1/a/b', 'x/y.vcf']) expect(() => parseContactId(bad)).toThrow(AgentError)
})

test('no grant, no contacts; read grant is read only', async () => {
	await expect(call('contacts_contact_list')).rejects.toMatchObject({ code: 'forbidden' })
	await grant({ read: 'allowed' })
	expect((await call('contacts_addressbook_list')).addressbooks).toHaveLength(2)
	await expect(call('contacts_contact_create', { name: 'X' })).rejects.toMatchObject({ code: 'forbidden' })
	expect(calls.some((c) => c.startsWith('create'))).toBe(false)
})

test('list: sorted, filtered, paged with a cursor; ids and ISO dates', async () => {
	await grant({ read: 'allowed' })
	const p1 = await call('contacts_contact_list', { limit: 2 })
	expect(p1.contacts.map((c: { name: string }) => c.name)).toEqual(['Anne Martin', 'Bruno Petit'])
	expect(p1.contacts[0]).toMatchObject({ contact_id: '1/c1.vcf', addressbook: 1, updated: '2023-11-14T22:13:20Z', emails: [{ value: 'anne@example.org', type: 'work' }] })
	expect(p1.contacts[0].card).toBeUndefined()
	expect(p1.next_cursor).toBe('2')
	const p2 = await call('contacts_contact_list', { limit: 2, cursor: p1.next_cursor })
	expect(p2.contacts.map((c: { name: string }) => c.name)).toEqual(['Zoé Durand'])
	expect(p2.next_cursor).toBeNull()
	expect((await call('contacts_contact_list', { query: 'zo' })).total).toBe(1)
	await expect(call('contacts_contact_list', { cursor: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(call('contacts_contact_list', { limit: 500 })).rejects.toMatchObject({ code: 'invalid_input' })
	expect((await call('contacts_contact_get', { contact_id: '1/c0.vcf' })).name).toBe('Zoé Durand')
	await expect(call('contacts_contact_get', { contact_id: '1/nope.vcf' })).rejects.toMatchObject({ code: 'not_found' })
})

test('create and update: only contact fields go to PHP; etag guards concurrent edits', async () => {
	await grant({ read: 'allowed', write: 'allowed' })
	await expect(call('contacts_contact_create', {})).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(call('contacts_contact_create', { name: 'X', bogus: 1 })).rejects.toMatchObject({ code: 'invalid_input' })
	await call('contacts_contact_create', { emails: ['checked-by-php@x'] }) // an email alone is enough
	expect(calls.at(-1)).toBe('create alice undefined {"emails":["checked-by-php@x"]}')
	const c = await call('contacts_contact_create', { name: 'Jean Dupont', phones: [{ value: '+33 6 12 34 56 78', type: 'cell' }], addressbook: 1 })
	expect(c.contact_id).toMatch(/^1\//)
	expect(c.name).toBe('Jean Dupont')
	await expect(call('contacts_contact_create', { name: 'X', addressbook: 2 })).rejects.toMatchObject({ code: 'invalid_input' })

	await expect(call('contacts_contact_update', { contact_id: c.contact_id })).rejects.toMatchObject({ code: 'invalid_input' })
	const u = await call('contacts_contact_update', { contact_id: c.contact_id, title: 'CTO', note: null, etag: c.etag })
	expect(u.title).toBe('CTO')
	expect(calls.at(-1)).toBe(`update alice ${c.contact_id} {"title":"CTO","note":null} ${c.etag}`)
	await expect(call('contacts_contact_update', { contact_id: c.contact_id, title: 'CEO', etag: c.etag })).rejects.toMatchObject({ code: 'conflict' })
})

test('delete asks the owner by default; approval executes, keeps a copy, restore puts it back', async () => {
	await grant({ read: 'allowed', write: 'allowed' }) // delete left out = approval
	const pending = await call('contacts_contact_delete', { contact_id: '1/c1.vcf' })
	expect(pending.status).toBe('pending_approval')
	expect(cards.has('1/c1.vcf')).toBe(true)
	const req = await approvals.get(pending.request_id)
	expect(req!.summary).toBe('Delete contact: Anne Martin, anne@example.org')

	const done = await approvals.approve('alice', pending.request_id, null)
	expect(done.status).toBe('executed')
	expect(cards.has('1/c1.vcf')).toBe(false)
	const restoreId = (done.result as { restore_id: string }).restore_id
	expect(restoreId).toMatch(/^ct_/)

	const del = await call('contacts_contact_deleted')
	expect(del.deleted).toEqual([expect.objectContaining({ restore_id: restoreId, contact_id: '1/c1.vcf', name: 'Anne Martin', deleted_by: 'bot' })])
	const back = await call('contacts_contact_restore', { restore_id: restoreId })
	expect(back).toMatchObject({ restored: true, contact: { contact_id: '1/c1.vcf', name: 'Anne Martin' } })
	expect(cards.get('1/c1.vcf')!.carddata).toContain('FN:Anne Martin')
	await expect(call('contacts_contact_restore', { restore_id: restoreId })).rejects.toMatchObject({ code: 'not_found' }) // used up
})

test('an approved delete is void if the contact changed after the request', async () => {
	await grant({ read: 'allowed', write: 'allowed' })
	const pending = await call('contacts_contact_delete', { contact_id: '1/c2.vcf' })
	await call('contacts_contact_update', { contact_id: '1/c2.vcf', note: 'edited meanwhile' })
	expect((await approvals.approve('alice', pending.request_id, null)).status).toBe('void')
	expect(cards.has('1/c2.vcf')).toBe(true)
})

test('delete allowed outright; delete off refused; copies expire after 30 days', async () => {
	await grant({ read: 'allowed', write: 'allowed', delete: 'allowed' })
	const r = await call('contacts_contact_delete', { contact_id: '1/c0.vcf' })
	expect(r).toMatchObject({ deleted: true, contact_id: '1/c0.vcf' })
	await purgeTrash(db, Math.floor(Date.now() / 1000) + TRASH_DAYS * 86400 + 10)
	await expect(call('contacts_contact_restore', { restore_id: r.restore_id })).rejects.toMatchObject({ code: 'not_found' })

	await grant({ read: 'allowed', write: 'allowed', delete: 'off' })
	await expect(call('contacts_contact_delete', { contact_id: '1/c1.vcf' })).rejects.toMatchObject({ code: 'forbidden' })
})

test('another grantor\'s copies are not visible or restorable', async () => {
	await grant({ read: 'allowed', write: 'allowed', delete: 'allowed' })
	const r = await call('contacts_contact_delete', { contact_id: '1/c0.vcf' })
	await setAccess(db, 'bot', 'bob', 'contacts', normalizeModes({ read: 'allowed', write: 'allowed' }, ['read', 'write', 'delete']))
	expect((await call('contacts_contact_deleted', { grantor: 'bob' })).deleted).toEqual([])
	await expect(call('contacts_contact_restore', { restore_id: r.restore_id, grantor: 'bob' })).rejects.toMatchObject({ code: 'not_found' })
})
