// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CardDAV for the Contacts UI: the user's address books (own + shared with them)
// under /remote.php/dav/addressbooks/users/<uid>/, cards fetched with one PROPFIND each.
import { DAV_ROOT, dav, type VComponent } from '@atrium/sdk'
import { displayName, parseCard, serialize, toForm, uidOf, type ContactForm } from './vcard'

export interface AddressBook {
	url: string
	/** Last path segment, used in links. */
	id: string
	name: string
	readOnly: boolean
	/** Shared with the user by someone else. */
	shared: boolean
	ctag: string
}

export interface Contact {
	url: string
	etag: string | null
	book: AddressBook
	card: VComponent
	form: ContactForm
	name: string
	uid: string
	/** "<uid>~<book id>": the id in /apps/contacts links (same shape upstream Contacts uses). */
	key: string
	photo: boolean
}

export const homeUrl = (user: string) => `${DAV_ROOT}/addressbooks/users/${encodeURIComponent(user)}/`

export async function listBooks(user: string): Promise<AddressBook[]> {
	const rs = await dav.propfind(homeUrl(user), ['d:displayname', 'd:resourcetype', 'cs:getctag', 'oc:read-only', 'oc:owner-principal'], 1)
	return rs
		.filter((r) => r.elements['d:resourcetype']?.getElementsByTagNameNS('urn:ietf:params:xml:ns:carddav', 'addressbook').length)
		.map((r) => {
			const id = r.href.replace(/\/$/, '').split('/').pop() ?? ''
			return {
				url: r.href.endsWith('/') ? r.href : r.href + '/',
				id,
				name: r.props['d:displayname'] || id,
				readOnly: r.props['oc:read-only'] === 'true' || r.props['oc:read-only'] === '1',
				shared: !!r.props['oc:owner-principal'] && !r.props['oc:owner-principal'].endsWith(`/${user}`),
				ctag: r.props['cs:getctag'] ?? '',
			}
		})
		.sort((a, b) => Number(a.shared) - Number(b.shared) || a.name.localeCompare(b.name))
}

export function toContact(book: AddressBook, url: string, etag: string | null, text: string): Contact | null {
	try {
		const card = parseCard(text)
		if (card.name !== 'VCARD') return null
		const form = toForm(card)
		const uid = uidOf(card) || url.split('/').pop()!.replace(/\.vcf$/, '')
		return { url, etag, book, card, form, uid, key: `${uid}~${book.id}`, name: displayName(form, form.emails) || '(no name)', photo: card.props.some((p) => /(^|\.)PHOTO$/.test(p.name)) }
	} catch {
		return null
	}
}

export async function listContacts(book: AddressBook): Promise<Contact[]> {
	const rs = await dav.propfind(book.url, ['d:getetag', 'card:address-data'], 1)
	return rs.filter((r) => r.props['card:address-data']).map((r) => toContact(book, r.href, r.props['d:getetag'] ?? null, r.props['card:address-data'])).filter((c): c is Contact => !!c)
}

export async function saveContact(book: AddressBook, card: VComponent, existing?: Contact): Promise<Contact> {
	const text = serialize(card)
	const url = existing?.url ?? `${book.url}${encodeURIComponent(uidOf(card))}.vcf`
	const etag = await dav.put(url, text, 'text/vcard; charset=utf-8', existing ? { etag: existing.etag } : { create: true })
	// Some servers don't return an ETag on PUT (the card was changed server side): refetch.
	if (!etag) {
		const got = await dav.get(url)
		return toContact(book, url, got.etag, got.text)!
	}
	return toContact(book, url, etag, text)!
}

export const deleteContact = (c: Contact) => dav.delete(c.url, c.etag)

export async function moveContact(c: Contact, to: AddressBook): Promise<void> {
	await dav.move(c.url, to.url + c.url.split('/').pop())
}

export async function createBook(user: string, name: string, fixedId?: string): Promise<void> {
	const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'addressbook'
	const body = `<?xml version="1.0"?><d:mkcol xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:set><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>${name.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</d:displayname></d:prop></d:set></d:mkcol>`
	await dav.mkcol(`${homeUrl(user)}${fixedId ?? `${slug}-${Date.now().toString(36)}`}/`, body)
}

export const renameBook = (b: AddressBook, name: string) => dav.proppatch(b.url, { 'd:displayname': name })
export const deleteBook = (b: AddressBook) => dav.delete(b.url)

/** The whole address book as one .vcf (Nextcloud's ?export). */
export const exportUrl = (b: AddressBook) => `${b.url}?export`
/** Card photo, served by the dav app's image export plugin. */
export const photoUrl = (c: Contact, size = 128) => `${c.url}?photo&size=${size}&v=${encodeURIComponent(c.etag ?? '')}`
