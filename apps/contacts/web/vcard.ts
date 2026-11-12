// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// vCard (3.0 / 4.0) <-> an editable contact. Only the fields the form edits are
// rewritten; every other line of the card (X- props, PHOTO, IMPP, ...) is kept.
import { escapeText, parseComponent, serializeComponent, unescapeText, uuid, type VComponent, type VProp } from '@atrium/sdk'

export interface Typed { type: string, value: string, /** Custom label (X-ABLABEL), shown instead of the type. */ label?: string }
export interface Address { type: string, street: string, city: string, region: string, code: string, country: string }
export interface ContactForm {
	given: string
	family: string
	/** Display name; derived from given/family/org when left empty. */
	fn: string
	org: string
	title: string
	emails: Typed[]
	phones: Typed[]
	addresses: Address[]
	urls: Typed[]
	bday: string
	note: string
	categories: string[]
}

export const PHONE_TYPES = ['cell', 'home', 'work', 'other'] as const
export const EMAIL_TYPES = ['home', 'work', 'other'] as const
export const ADR_TYPES = ['home', 'work', 'other'] as const
export const TYPE_LABEL: Record<string, string> = { cell: 'Mobile', home: 'Home', work: 'Work', other: 'Other' }

/** Property name without its group ("item1.EMAIL" -> "EMAIL"). */
const base = (p: VProp) => p.name.slice(p.name.lastIndexOf('.') + 1)
const group = (p: VProp) => (p.name.includes('.') ? p.name.slice(0, p.name.lastIndexOf('.')) : '')
const all = (c: VComponent, name: string) => c.props.filter((p) => base(p) === name)
const first = (c: VComponent, name: string) => all(c, name)[0]

/** Split a structured value (N, ADR) on unescaped semicolons. */
export function splitStructured(v: string): string[] {
	const out: string[] = []
	let cur = ''
	for (let i = 0; i < v.length; i++) {
		if (v[i] === '\\' && i + 1 < v.length) { cur += v[i] + v[i + 1]; i++; continue }
		if (v[i] === ';') { out.push(unescapeText(cur)); cur = '' } else cur += v[i]
	}
	out.push(unescapeText(cur))
	return out
}
/** Split a list value (CATEGORIES) on unescaped commas. */
function splitList(v: string): string[] {
	const out: string[] = []
	let cur = ''
	for (let i = 0; i < v.length; i++) {
		if (v[i] === '\\' && i + 1 < v.length) { cur += v[i] + v[i + 1]; i++; continue }
		if (v[i] === ',') { out.push(unescapeText(cur).trim()); cur = '' } else cur += v[i]
	}
	out.push(unescapeText(cur).trim())
	return out.filter(Boolean)
}

function typeOf(p: VProp, known: readonly string[], fallback: string): string {
	const types = (p.params.TYPE ?? '').toLowerCase().split(',').map((t) => t.trim())
	if (known.includes('cell') && (types.includes('cell') || types.includes('mobile') || types.includes('iphone'))) return 'cell'
	return types.find((t) => known.includes(t)) ?? fallback
}

/** Apple-style label of a grouped prop (item1.EMAIL + item1.X-ABLABEL:Navy). */
function labelOf(c: VComponent, p: VProp): string | undefined {
	const g = group(p)
	const l = g ? c.props.find((x) => base(x) === 'X-ABLABEL' && group(x) === g)?.value : undefined
	return l ? unescapeText(l).replace(/^_\$!<(.*)>!\$_$/, '$1') : undefined
}

export function parseCard(text: string): VComponent {
	return parseComponent(text)
}

export function toForm(c: VComponent): ContactForm {
	const n = splitStructured(first(c, 'N')?.value ?? '')
	const adr = all(c, 'ADR').map((p): Address => {
		const [, , street = '', city = '', region = '', code = '', country = ''] = splitStructured(p.value)
		return { type: typeOf(p, ADR_TYPES, 'home'), street, city, region, code, country }
	})
	const fnRaw = unescapeText(first(c, 'FN')?.value ?? '')
	const org = splitStructured(first(c, 'ORG')?.value ?? '')[0] ?? ''
	const noN = !n[0]?.trim() && !n[1]?.trim() && fnRaw !== org
	const composed = [n[1], n[0]].filter((s) => s?.trim()).join(' ')
	return {
		// A card with only FN edits it as the first name; fn stays only when it says
		// something N does not ("Dr. Ada Lovelace"), and the editor clears it on a name change.
		given: noN ? fnRaw : n[1] ?? '',
		family: noN ? '' : n[0] ?? '',
		fn: noN || fnRaw === composed ? '' : fnRaw,
		org,
		title: unescapeText(first(c, 'TITLE')?.value ?? ''),
		emails: all(c, 'EMAIL').map((p) => ({ type: typeOf(p, EMAIL_TYPES, 'other'), value: p.value, label: labelOf(c, p) })),
		phones: all(c, 'TEL').map((p) => ({ type: typeOf(p, PHONE_TYPES, 'other'), value: p.value.replace(/^tel:/, ''), label: labelOf(c, p) })),
		addresses: adr,
		urls: all(c, 'URL').map((p) => ({ type: 'other', value: unescapeText(p.value) })),
		bday: normaliseDate(first(c, 'BDAY')?.value ?? ''),
		note: unescapeText(first(c, 'NOTE')?.value ?? ''),
		categories: all(c, 'CATEGORIES').flatMap((p) => splitList(p.value)),
	}
}

/** BDAY as YYYY-MM-DD for <input type=date>; "--MM-DD" (no year) stays as is. */
function normaliseDate(v: string): string {
	const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(v)
	if (m) return `${m[1]}-${m[2]}-${m[3]}`
	return /^--\d{2}-?\d{2}$/.test(v) ? v : ''
}

export function displayName(f: Pick<ContactForm, 'fn' | 'given' | 'family' | 'org'>, emails: Typed[] = []): string {
	return f.fn.trim() || [f.given, f.family].filter((s) => s.trim()).join(' ') || f.org.trim() || emails[0]?.value || ''
}

const EDITED = new Set(['FN', 'N', 'ORG', 'TITLE', 'EMAIL', 'TEL', 'ADR', 'URL', 'BDAY', 'NOTE', 'CATEGORIES', 'REV'])

/** Write the form back into the card (a copy), keeping everything else. */
export function applyForm(card: VComponent | null, f: ContactForm): VComponent {
	const v4 = card ? first(card, 'VERSION')?.value === '4.0' : false
	const c: VComponent = card
		? { ...card, props: card.props.filter((p) => !EDITED.has(base(p))) }
		: { name: 'VCARD', children: [], props: [{ name: 'VERSION', params: {}, value: '3.0' }, { name: 'PRODID', params: {}, value: '-//Atrium//Contacts//EN' }, { name: 'UID', params: {}, value: uuid() }] }
	// Labels (X-ABLABEL) of grouped props we just dropped would dangle.
	const groups = new Set(c.props.map(group).filter(Boolean))
	const live = new Set(c.props.filter((p) => base(p) !== 'X-ABLABEL').map(group).filter(Boolean))
	c.props = c.props.filter((p) => !(base(p) === 'X-ABLABEL' && groups.has(group(p)) && !live.has(group(p))))

	const up = (t: string) => (v4 ? t : t.toUpperCase())
	const push = (name: string, value: string, params: Record<string, string> = {}) => { if (value.trim()) c.props.push({ name, params, value }) }
	const fn = displayName(f, f.emails)
	c.props.push({ name: 'FN', params: {}, value: escapeText(fn || 'Unnamed') })
	c.props.push({ name: 'N', params: {}, value: [f.family, f.given, '', '', ''].map(escapeText).join(';') })
	push('ORG', escapeText(f.org))
	push('TITLE', escapeText(f.title))
	// A custom label goes back as itemN.PROP + itemN.X-ABLABEL, as Apple clients write it.
	let item = 0
	while (c.props.some((p) => group(p).toLowerCase() === `item${item + 1}`)) item++
	const pushTyped = (name: string, t: Typed, params: Record<string, string>) => {
		const value = t.value.trim()
		if (!value) return
		if (!t.label) return push(name, value, params)
		item++
		c.props.push({ name: `item${item}.${name}`, params, value }, { name: `item${item}.X-ABLABEL`, params: {}, value: escapeText(t.label) })
	}
	for (const e of f.emails) pushTyped('EMAIL', e, e.type !== 'other' ? { TYPE: up(e.type) } : {})
	for (const p of f.phones) pushTyped('TEL', p, p.type !== 'other' ? { TYPE: up(p.type) } : {})
	for (const a of f.addresses) {
		if (![a.street, a.city, a.region, a.code, a.country].some((s) => s.trim())) continue
		c.props.push({ name: 'ADR', params: a.type !== 'other' ? { TYPE: up(a.type) } : {}, value: ['', '', a.street, a.city, a.region, a.code, a.country].map(escapeText).join(';') })
	}
	for (const u of f.urls) push('URL', u.value.trim())
	if (f.bday) push('BDAY', f.bday.startsWith('--') ? f.bday : f.bday.replace(/-/g, v4 ? '' : '-'))
	push('NOTE', escapeText(f.note))
	if (f.categories.length) push('CATEGORIES', f.categories.map(escapeText).join(','))
	c.props.push({ name: 'REV', params: {}, value: new Date().toISOString().replace(/[-:]|\.\d+/g, '') })
	return c
}

export const serialize = (c: VComponent) => serializeComponent(c) + '\r\n'
export const uidOf = (c: VComponent) => first(c, 'UID')?.value ?? ''
export const hasPhoto = (c: VComponent) => !!first(c, 'PHOTO')

/** Set or clear PHOTO from a JPEG data URL. */
export function setPhoto(c: VComponent, dataUrl: string | null): VComponent {
	const out = { ...c, props: c.props.filter((p) => base(p) !== 'PHOTO') }
	if (!dataUrl) return out
	const v4 = first(c, 'VERSION')?.value === '4.0'
	const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
	out.props.push(v4 ? { name: 'PHOTO', params: {}, value: dataUrl } : { name: 'PHOTO', params: { ENCODING: 'b', TYPE: 'JPEG' }, value: b64 })
	return out
}

/** Split a .vcf file with several cards. */
export function splitVcf(text: string): string[] {
	return text.split(/(?=^BEGIN:VCARD)/im).map((s) => s.trim()).filter((s) => /^BEGIN:VCARD/i.test(s))
}

export const emptyForm = (): ContactForm => ({ given: '', family: '', fn: '', org: '', title: '', emails: [], phones: [], addresses: [], urls: [], bday: '', note: '', categories: [] })
