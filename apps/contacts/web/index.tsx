// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contacts for the Atrium shell, straight over CardDAV. Routes below /apps/contacts
// keep upstream's shape so old links work:
//   /                          all contacts
//   /<filter>/<uid~bookId>     a contact; filter = "All contacts" | "Not grouped" | "book:<id>" | <group>
//   /<filter>/new              new contact
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defineApp, navigate, useApp, useAppPath } from '@atrium/sdk'
import { AppLayout, Avatar, Button, Dialog, EmptyState, Icon, IconButton, Menu, NavItem, NavSection, NavToggle, SearchBar, Spinner, TextField, confirmDialog, toast } from '@atrium/ui'
import { createBook, deleteBook, exportUrl, listBooks, listContacts, photoUrl, renameBook, saveContact, type AddressBook, type Contact } from './api'
import { ContactPane } from './Detail'
import { parseCard, splitVcf, uidOf } from './vcard'
import './style.css'

const ALL = 'All contacts'
const UNGROUPED = 'Not grouped'

function Contacts() {
	const { basePath, session, setTitle } = useApp()
	const user = session.user.id
	const path = useAppPath()
	const [books, setBooks] = useState<AddressBook[] | null>(null)
	const [contacts, setContacts] = useState<Contact[]>([])
	const [error, setError] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [bookDialog, setBookDialog] = useState<{ book: AddressBook | null, name: string } | null>(null)
	const fileInput = useRef<HTMLInputElement>(null)

	const seg = path.split('/').filter(Boolean).map(decodeURIComponent)
	const filter = seg[0] ?? ALL
	const key = seg[1] ?? null

	const load = useCallback(async () => {
		try {
			let bs = await listBooks(user)
			if (bs.length === 0) {
				await createBook(user, 'Contacts', 'contacts')
				bs = await listBooks(user)
			}
			const lists = await Promise.all(bs.map((b) => listContacts(b).catch(() => [] as Contact[])))
			setBooks(bs)
			setContacts(lists.flat())
			setError(null)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
			setBooks((b) => b ?? [])
		}
	}, [user])
	useEffect(() => { load() }, [load])

	// Pick up changes from phones and other clients when the tab comes back.
	const booksRef = useRef(books)
	booksRef.current = books
	useEffect(() => {
		const onVisible = async () => {
			if (document.hidden || !booksRef.current) return
			const fresh = await listBooks(user).catch(() => null)
			if (!fresh) return
			const old = new Map(booksRef.current.map((b) => [b.url, b.ctag]))
			if (fresh.length !== old.size || fresh.some((b) => old.get(b.url) !== b.ctag)) load()
		}
		document.addEventListener('visibilitychange', onVisible)
		return () => document.removeEventListener('visibilitychange', onVisible)
	}, [user, load])

	useEffect(() => { setTitle('Contacts') }, [setTitle])

	const groups = useMemo(() => {
		const m = new Map<string, number>()
		for (const c of contacts) for (const g of c.form.categories) m.set(g, (m.get(g) ?? 0) + 1)
		return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
	}, [contacts])
	const ungrouped = contacts.filter((c) => c.form.categories.length === 0).length

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase()
		return contacts
			.filter((c) => filter === ALL ? true
				: filter === UNGROUPED ? c.form.categories.length === 0
				: filter.startsWith('book:') ? c.book.id === filter.slice(5)
				: c.form.categories.includes(filter))
			.filter((c) => !q || [c.name, c.form.org, ...c.form.emails.map((e) => e.value), ...c.form.phones.map((p) => p.value)].some((s) => s.toLowerCase().includes(q)))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
	}, [contacts, filter, query])

	const writable = (books ?? []).filter((b) => !b.readOnly)
	const current = key && key !== 'new' ? contacts.find((c) => c.key === key) ?? null : null
	const filterPath = (f: string) => `${basePath}/${encodeURIComponent(f)}`
	const open = (c: Contact | 'new' | null) => navigate(c ? `${filterPath(filter)}/${c === 'new' ? 'new' : encodeURIComponent(c.key)}` : filterPath(filter))
	const defaultBook = (filter.startsWith('book:') ? writable.find((b) => b.id === filter.slice(5)) : null) ?? writable[0]

	const onSaved = (c: Contact, replaced?: Contact) => {
		setContacts((list) => [...list.filter((x) => x !== replaced && x.url !== c.url), c])
		navigate(`${filterPath(filter)}/${encodeURIComponent(c.key)}`, { replace: true })
	}
	const onDeleted = (c: Contact) => {
		setContacts((list) => list.filter((x) => x !== c))
		open(null)
	}

	async function importFile(file: File) {
		const book = defaultBook
		if (!book) return toast('No address book you can write to', { error: true })
		const cards = splitVcf(await file.text())
		let ok = 0
		for (const text of cards) {
			try {
				const card = parseCard(text)
				if (!uidOf(card)) card.props.push({ name: 'UID', params: {}, value: crypto.randomUUID() })
				await saveContact(book, card)
				ok++
			} catch { /* skip broken or duplicate cards */ }
		}
		toast(`Imported ${ok} of ${cards.length} contacts into ${book.name}`)
		load()
	}

	async function submitBook() {
		if (!bookDialog?.name.trim()) return
		try {
			if (bookDialog.book) await renameBook(bookDialog.book, bookDialog.name.trim())
			else await createBook(user, bookDialog.name.trim())
			setBookDialog(null)
			load()
		} catch (e) { toast(String(e instanceof Error ? e.message : e), { error: true }) }
	}
	async function removeBook(b: AddressBook) {
		const n = contacts.filter((c) => c.book === b).length
		if (!await confirmDialog(`Delete the address book "${b.name}" and its ${n} contact${n === 1 ? '' : 's'}?`, { title: 'Delete address book', confirm: 'Delete', danger: true })) return
		try {
			await deleteBook(b)
			if (filter === `book:${b.id}`) navigate(basePath + '/')
			load()
		} catch (e) { toast(String(e instanceof Error ? e.message : e), { error: true }) }
	}

	const nav = (
		<>
			<Button icon="personAdd" className="ct-new" disabled={!defaultBook} onClick={() => open('new')}>New contact</Button>
			<NavSection>
				<NavItem icon="contacts" label={ALL} count={contacts.length} active={filter === ALL} href={filterPath(ALL)} onClick={() => navigate(filterPath(ALL))} />
				<NavItem icon="person" label={UNGROUPED} count={ungrouped} active={filter === UNGROUPED} href={filterPath(UNGROUPED)} onClick={() => navigate(filterPath(UNGROUPED))} />
			</NavSection>
			{groups.length > 0 && (
				<NavSection title="Groups">
					{groups.map(([g, n]) => <NavItem key={g} icon="label" label={g} count={n} active={filter === g} href={filterPath(g)} onClick={() => navigate(filterPath(g))} />)}
				</NavSection>
			)}
			<NavSection title="Address books">
				{(books ?? []).map((b) => (
					<NavItem key={b.url} icon={b.shared ? 'share' : 'contacts'} label={b.name} count={contacts.filter((c) => c.book === b).length}
						active={filter === `book:${b.id}`} href={filterPath(`book:${b.id}`)} onClick={() => navigate(filterPath(`book:${b.id}`))}
						actions={
							<span className="ct-nav-menu" onClick={(e) => { e.stopPropagation(); e.preventDefault() }}>
								<Menu trigger={(o, x) => <IconButton icon="moreVert" label={`${b.name} actions`} aria-expanded={x} onClick={o} />} items={[
									!b.shared && { label: 'Rename', icon: 'edit', onClick: () => setBookDialog({ book: b, name: b.name }) },
									{ label: 'Download', icon: 'download', href: exportUrl(b) },
									!b.shared && { label: 'Delete', icon: 'delete', danger: true, onClick: () => removeBook(b) },
								]} />
							</span>
						} />
				))}
				<NavItem icon="add" label="New address book" onClick={() => setBookDialog({ book: null, name: '' })} />
			</NavSection>
			<div className="ct-nav-fill" />
			<NavItem icon="upload" label="Import .vcf" onClick={() => fileInput.current?.click()} />
			<input ref={fileInput} type="file" accept=".vcf,text/vcard,text/x-vcard" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importFile(f) }} />
		</>
	)

	const title = filter.startsWith('book:') ? books?.find((b) => b.id === filter.slice(5))?.name ?? 'Address book' : filter
	return (
		<AppLayout nav={nav}>
			<div className={'ct' + (key ? ' ct--detail' : '')}>
				<section className="ct-list" aria-label="Contacts">
					<div className="ct-list__head">
						<NavToggle />
						<SearchBar value={query} onChange={setQuery} placeholder={`Search ${title.toLowerCase() === ALL.toLowerCase() ? 'contacts' : title}`} />
					</div>
					{error && <p className="ct-error"><Icon name="warning" /> {error}</p>}
					{books === null ? <div className="ct-center"><Spinner /></div>
						: visible.length === 0 ? <EmptyState icon="contacts" title={query ? 'No matches' : 'No contacts here yet'} />
						: <ContactList contacts={visible} selected={current} onOpen={open} />}
				</section>
				<section className="ct-detail" aria-label="Contact">
					{key === 'new'
						? defaultBook ? <ContactPane key="new" books={writable} book={defaultBook} allGroups={groups.map(([g]) => g)} onSaved={onSaved} onDeleted={onDeleted} onClose={() => open(null)} /> : null
						: current ? <ContactPane key={current.url} contact={current} books={writable} book={current.book} allGroups={groups.map(([g]) => g)} onSaved={onSaved} onDeleted={onDeleted} onClose={() => open(null)} />
						: key && books ? <EmptyState icon="person" title="Contact not found" />
						: <EmptyState icon="contacts" title={contacts.length ? 'Select a contact' : 'No contacts yet'}>{contacts.length ? null : <Button icon="personAdd" variant="tonal" disabled={!defaultBook} onClick={() => open('new')}>New contact</Button>}</EmptyState>}
				</section>
			</div>
			<Dialog open={!!bookDialog} title={bookDialog?.book ? 'Rename address book' : 'New address book'} onClose={() => setBookDialog(null)}
				actions={<><Button variant="text" onClick={() => setBookDialog(null)}>Cancel</Button><Button disabled={!bookDialog?.name.trim()} onClick={submitBook}>{bookDialog?.book ? 'Rename' : 'Create'}</Button></>}>
				<form onSubmit={(e) => { e.preventDefault(); submitBook() }}>
					<TextField label="Name" autoFocus value={bookDialog?.name ?? ''} onChange={(e) => setBookDialog((d) => d && { ...d, name: e.target.value })} />
				</form>
			</Dialog>
		</AppLayout>
	)
}

function ContactList({ contacts, selected, onOpen }: { contacts: Contact[], selected: Contact | null, onOpen: (c: Contact) => void }) {
	let letter = ''
	return (
		<ul className="ct-items">
			{contacts.map((c) => {
				const l = (c.name[0] ?? '#').toLocaleUpperCase()
				const head = /\p{L}/u.test(l) ? l : '#'
				const showHead = head !== letter
				letter = head
				const sub = c.form.emails[0]?.value || c.form.phones[0]?.value || c.form.org
				return [
					showHead && <li key={'h' + head + c.key} className="ct-letter" aria-hidden="true">{head}</li>,
					<li key={c.url}>
						<a className={'ct-item' + (c === selected ? ' ct-item--active' : '')} href={'#'} aria-current={c === selected ? 'true' : undefined}
							onClick={(e) => { e.preventDefault(); onOpen(c) }}>
							<Avatar name={c.name} src={c.photo ? photoUrl(c, 64) : null} size={40} />
							<span className="ct-item__text">
								<span className="ct-item__name">{c.name}</span>
								{sub && <span className="ct-item__sub">{sub}</span>}
							</span>
						</a>
					</li>,
				]
			})}
		</ul>
	)
}

export default defineApp({ Component: Contacts })
