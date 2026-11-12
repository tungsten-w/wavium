// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One contact: read view, and the editor (also used for a new contact).
import { useRef, useState, type ReactNode } from 'react'
import { Avatar, Button, Chip, Icon, IconButton, Menu, Select, TextArea, TextField, confirmDialog, toast } from '@atrium/ui'
import { deleteContact, moveContact, photoUrl, saveContact, type AddressBook, type Contact } from './api'
import { ADR_TYPES, EMAIL_TYPES, PHONE_TYPES, TYPE_LABEL, applyForm, displayName, emptyForm, serialize, setPhoto, type Address, type ContactForm, type Typed } from './vcard'

interface Props {
	contact?: Contact
	book: AddressBook
	books: AddressBook[]
	allGroups: string[]
	onSaved: (c: Contact, replaced?: Contact) => void
	onDeleted: (c: Contact) => void
	onClose: () => void
}

const ADR_LABEL: Record<keyof Address, string> = { type: 'Type', street: 'Street', city: 'City', code: 'Postal code', region: 'State / region', country: 'Country' }
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function ContactPane(props: Props) {
	const { contact } = props
	const [editing, setEditing] = useState(!contact)
	return editing || !contact
		? <Editor {...props} onCancel={() => (contact ? setEditing(false) : props.onClose())} onDone={(c) => { setEditing(false); props.onSaved(c, contact) }} />
		: <View {...props} contact={contact} onEdit={() => setEditing(true)} />
}

function View({ contact: c, books, onDeleted, onSaved, onClose, onEdit }: Props & { contact: Contact, onEdit: () => void }) {
	const f = c.form
	const others = books.filter((b) => b !== c.book)
	const readOnly = c.book.readOnly

	async function remove() {
		if (!await confirmDialog(`Delete ${c.name}?`, { title: 'Delete contact', confirm: 'Delete', danger: true })) return
		try {
			await deleteContact(c)
			onDeleted(c)
			toast(`Deleted ${c.name}`, { action: { label: 'Undo', onClick: () => { saveContact(c.book, c.card).then((n) => onSaved(n), (e) => toast.error(errText(e))) } } })
		} catch (e) { toast.error(errText(e)) }
	}
	async function move(to: AddressBook) {
		try {
			await moveContact(c, to)
			onDeleted(c)
			toast(`Moved ${c.name} to ${to.name}`)
			onSaved({ ...c, book: to, url: to.url + c.url.split('/').pop(), key: `${c.uid}~${to.id}` })
		} catch (e) { toast.error(errText(e)) }
	}
	const download = () => {
		const a = document.createElement('a')
		a.href = URL.createObjectURL(new Blob([serialize(c.card)], { type: 'text/vcard' }))
		a.download = `${c.name.replace(/[\\/:*?"<>|]/g, '_') || 'contact'}.vcf`
		a.click()
		setTimeout(() => URL.revokeObjectURL(a.href), 1000)
	}

	const sub = [f.title, f.org].filter(Boolean).join(' · ')
	return (
		<div className="ct-pane">
			<div className="ct-pane__bar">
				<IconButton className="ct-back" icon="arrowBack" label="Back to the list" onClick={onClose} />
				<span className="at-spacer" />
				{!readOnly && <Button variant="tonal" icon="edit" onClick={onEdit}>Edit</Button>}
				<Menu trigger={(o, x) => <IconButton icon="moreVert" label="More" aria-expanded={x} onClick={o} />} items={[
					{ label: 'Download vCard', icon: 'download', onClick: download },
					...(!readOnly ? others.map((b) => ({ label: `Move to ${b.name}`, icon: 'swapVert' as const, onClick: () => move(b) })) : []),
					!readOnly && { label: 'Delete', icon: 'delete', danger: true, onClick: remove },
				]} />
			</div>
			<header className="ct-hero">
				<Avatar name={c.name} src={c.photo ? photoUrl(c, 256) : null} size={96} />
				<div>
					<h1 className="ct-hero__name">{c.name}</h1>
					{sub && <p className="ct-hero__sub">{sub}</p>}
					<p className="ct-hero__book"><Icon name={c.book.shared ? 'share' : 'contacts'} size="s" /> {c.book.name}{readOnly ? ' (read-only)' : ''}</p>
				</div>
			</header>
			<div className="ct-fields">
				{f.phones.map((p, i) => <Row key={'p' + i} icon="phone" label={p.label ?? TYPE_LABEL[p.type] ?? p.type}><a href={`tel:${p.value.replace(/\s/g, '')}`}>{p.value}</a></Row>)}
				{f.emails.map((e, i) => <Row key={'e' + i} icon="mail" label={e.label ?? TYPE_LABEL[e.type] ?? e.type}><a href={`mailto:${e.value}`}>{e.value}</a></Row>)}
				{f.addresses.map((a, i) => {
					const lines = [a.street, [a.code, a.city].filter(Boolean).join(' '), a.region, a.country].filter(Boolean)
					return <Row key={'a' + i} icon="place" label={TYPE_LABEL[a.type] ?? a.type}>
						<a href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(lines.join(', '))}`} target="_blank" rel="noreferrer">{lines.map((l, j) => <span key={j} className="ct-line">{l}</span>)}</a>
					</Row>
				})}
				{f.urls.map((u, i) => <Row key={'u' + i} icon="link" label="Website"><a href={/^https?:/i.test(u.value) ? u.value : `https://${u.value}`} target="_blank" rel="noreferrer">{u.value}</a></Row>)}
				{f.bday && <Row icon="cake" label="Birthday">{formatBday(f.bday)}</Row>}
				{f.categories.length > 0 && <Row icon="label" label="Groups"><span className="ct-chips">{f.categories.map((g) => <span key={g} className="ct-tag">{g}</span>)}</span></Row>}
				{f.note && <Row icon="notes" label="Notes"><span className="ct-note">{f.note}</span></Row>}
				{!f.phones.length && !f.emails.length && !f.addresses.length && !f.note && !f.bday && <p className="ct-muted">No details yet.</p>}
			</div>
		</div>
	)
}

function formatBday(v: string): string {
	if (v.startsWith('--')) {
		const [m, d] = v.slice(2).replace('-', '').match(/\d{2}/g) ?? []
		return new Date(2000, Number(m) - 1, Number(d)).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
	}
	const d = new Date(v + 'T00:00:00')
	return isNaN(d.getTime()) ? v : d.toLocaleDateString(undefined, { dateStyle: 'long' })
}

function Row({ icon, label, children }: { icon: Parameters<typeof Icon>[0]['name'], label: string, children: ReactNode }) {
	return (
		<div className="ct-row">
			<Icon name={icon} />
			<div className="ct-row__body">
				<div className="ct-row__value">{children}</div>
				<div className="ct-row__label">{label}</div>
			</div>
		</div>
	)
}

function Editor({ contact, book: initialBook, books, allGroups, onCancel, onDone }: Props & { onCancel: () => void, onDone: (c: Contact) => void }) {
	const [f, setF] = useState<ContactForm>(() => contact ? structuredClone(contact.form) : { ...emptyForm(), phones: [{ type: 'cell', value: '' }], emails: [{ type: 'home', value: '' }] })
	const [bookUrl, setBookUrl] = useState(initialBook.url)
	const [photo, setPhotoData] = useState<string | null | undefined>(undefined) // undefined = unchanged
	const [busy, setBusy] = useState(false)
	const [groupDraft, setGroupDraft] = useState('')
	const photoInput = useRef<HTMLInputElement>(null)
	const set = <K extends keyof ContactForm>(k: K, v: ContactForm[K]) => setF((x) => ({ ...x, [k]: v }))
	const name = displayName(f, f.emails)

	async function pickPhoto(file: File) {
		try { setPhotoData(await resizeImage(file, 256)) } catch { toast.error('Could not read that image') }
	}
	async function save(e?: React.FormEvent) {
		e?.preventDefault()
		if (!name) return toast.error('Give the contact a name, a company or an email address')
		setBusy(true)
		try {
			let card = applyForm(contact?.card ?? null, f)
			if (photo !== undefined) card = setPhoto(card, photo)
			const book = books.find((b) => b.url === bookUrl) ?? initialBook
			onDone(await saveContact(book, card, contact))
		} catch (err) {
			toast.error(`Could not save: ${errText(err)}`)
		} finally { setBusy(false) }
	}
	const addGroup = (g: string) => {
		const v = g.trim()
		if (v && !f.categories.includes(v)) set('categories', [...f.categories, v])
		setGroupDraft('')
	}
	const avatarSrc = photo !== undefined ? photo : contact?.photo ? photoUrl(contact, 256) : null

	return (
		<form className="ct-pane ct-edit" onSubmit={save}>
			<div className="ct-pane__bar">
				<IconButton className="ct-back" icon="arrowBack" label="Back" onClick={onCancel} />
				<h2 className="ct-edit__title">{contact ? 'Edit contact' : 'New contact'}</h2>
				<span className="at-spacer" />
				<Button variant="text" onClick={onCancel}>Cancel</Button>
				<Button type="submit" icon="check" busy={busy}>Save</Button>
			</div>
			<div className="ct-edit__photo">
				<button type="button" className="ct-photo-btn" onClick={() => photoInput.current?.click()} aria-label="Change photo">
					<Avatar name={name || '?'} src={avatarSrc} size={96} />
					<span className="ct-photo-btn__badge"><Icon name="image" size="s" /></span>
				</button>
				{avatarSrc && <Button variant="text" size="s" onClick={() => setPhotoData(null)}>Remove photo</Button>}
				<input ref={photoInput} type="file" accept="image/*" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) pickPhoto(file) }} />
			</div>

			<Section icon="person" title="Name">
				<div className="ct-grid2">
					<TextField label="First name" autoFocus={!contact} value={f.given} onChange={(e) => setF((x) => ({ ...x, given: e.target.value, fn: '' }))} />
					<TextField label="Last name" value={f.family} onChange={(e) => setF((x) => ({ ...x, family: e.target.value, fn: '' }))} />
					<TextField label="Company" value={f.org} onChange={(e) => set('org', e.target.value)} />
					<TextField label="Job title" value={f.title} onChange={(e) => set('title', e.target.value)} />
				</div>
			</Section>

			<TypedList icon="phone" title="Phone" add="Add phone" inputType="tel" types={PHONE_TYPES} items={f.phones} onChange={(v) => set('phones', v)} />
			<TypedList icon="mail" title="Email" add="Add email" inputType="email" types={EMAIL_TYPES} items={f.emails} onChange={(v) => set('emails', v)} />

			<Section icon="place" title="Address">
				{f.addresses.map((a, i) => (
					<div key={i} className="ct-adr">
						<div className="ct-adr__head">
							<Select label="Type" value={a.type} onChange={(e) => set('addresses', f.addresses.map((x, j) => j === i ? { ...x, type: e.target.value } : x))}>
								{ADR_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
							</Select>
							<IconButton icon="delete" label="Remove address" onClick={() => set('addresses', f.addresses.filter((_, j) => j !== i))} />
						</div>
						<div className="ct-grid2">
							{(['street', 'city', 'code', 'region', 'country'] as (keyof Address)[]).map((k) => (
								<TextField key={k} className={k === 'street' ? 'ct-span2' : undefined} label={ADR_LABEL[k]}
									value={a[k]} onChange={(e) => set('addresses', f.addresses.map((x, j) => j === i ? { ...x, [k]: e.target.value } : x))} />
							))}
						</div>
					</div>
				))}
				<Button variant="text" icon="add" onClick={() => set('addresses', [...f.addresses, { type: 'home', street: '', city: '', region: '', code: '', country: '' }])}>Add address</Button>
			</Section>

			<Section icon="link" title="Website">
				{f.urls.map((u, i) => (
					<div key={i} className="ct-typed">
						<TextField label="Website" type="url" value={u.value} onChange={(e) => set('urls', f.urls.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
						<IconButton icon="delete" label="Remove website" onClick={() => set('urls', f.urls.filter((_, j) => j !== i))} />
					</div>
				))}
				<Button variant="text" icon="add" onClick={() => set('urls', [...f.urls, { type: 'other', value: '' }])}>Add website</Button>
			</Section>

			<Section icon="cake" title="Birthday">
				<div className="ct-typed">
					<TextField label="Birthday" type="date" value={f.bday.startsWith('--') ? '' : f.bday} onChange={(e) => set('bday', e.target.value)} />
					{f.bday && <IconButton icon="close" label="Clear birthday" onClick={() => set('bday', '')} />}
				</div>
			</Section>

			<Section icon="label" title="Groups">
				<div className="ct-chips">
					{f.categories.map((g) => <Chip key={g} selected onClick={() => set('categories', f.categories.filter((x) => x !== g))} aria-label={`Remove ${g}`}>{g} <Icon name="close" size="s" /></Chip>)}
				</div>
				<div className="ct-typed">
					<TextField label="Add to group" list="ct-groups" value={groupDraft} onChange={(e) => setGroupDraft(e.target.value)}
						onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGroup(groupDraft) } }} />
					<IconButton icon="add" label="Add group" disabled={!groupDraft.trim()} onClick={() => addGroup(groupDraft)} />
					<datalist id="ct-groups">{allGroups.filter((g) => !f.categories.includes(g)).map((g) => <option key={g} value={g} />)}</datalist>
				</div>
			</Section>

			<Section icon="notes" title="Notes">
				<TextArea label="Notes" value={f.note} rows={3} onChange={(e) => set('note', e.target.value)} />
			</Section>

			{!contact && books.length > 1 && (
				<Section icon="contacts" title="Address book">
					<Select label="Save in" value={bookUrl} onChange={(e) => setBookUrl(e.target.value)}>
						{books.map((b) => <option key={b.url} value={b.url}>{b.name}</option>)}
					</Select>
				</Section>
			)}
		</form>
	)
}

function Section({ icon, title, children }: { icon: Parameters<typeof Icon>[0]['name'], title: string, children: ReactNode }) {
	return (
		<fieldset className="ct-section">
			<legend className="ct-section__title"><Icon name={icon} /> {title}</legend>
			<div className="ct-section__body">{children}</div>
		</fieldset>
	)
}

function TypedList({ icon, title, add, inputType, types, items, onChange }: { icon: Parameters<typeof Icon>[0]['name'], title: string, add: string, inputType: string, types: readonly string[], items: Typed[], onChange: (v: Typed[]) => void }) {
	return (
		<Section icon={icon} title={title}>
			{items.map((it, i) => (
				<div key={i} className="ct-typed">
					<Select label="Type" className="ct-type" value={it.type} onChange={(e) => onChange(items.map((x, j) => j === i ? { ...x, type: e.target.value, label: undefined } : x))}>
						{types.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
					</Select>
					<TextField label={title} type={inputType} value={it.value} onChange={(e) => onChange(items.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
					<IconButton icon="delete" label={`Remove ${title.toLowerCase()}`} onClick={() => onChange(items.filter((_, j) => j !== i))} />
				</div>
			))}
			<Button variant="text" icon="add" onClick={() => onChange([...items, { type: types[0], value: '' }])}>{add}</Button>
		</Section>
	)
}

/** Square-crop and scale an image to a JPEG data URL. */
function resizeImage(file: File, size: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.onload = () => {
			const s = Math.min(img.width, img.height)
			const canvas = document.createElement('canvas')
			canvas.width = canvas.height = size
			canvas.getContext('2d')!.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size)
			URL.revokeObjectURL(img.src)
			resolve(canvas.toDataURL('image/jpeg', 0.85))
		}
		img.onerror = reject
		img.src = URL.createObjectURL(file)
	})
}
