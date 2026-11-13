// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scam hint without AI (PLAN.md P5-4): the sender's display name claims to be
// someone the address's domain does not match. Classic phishing shape:
//   "PayPal Service" <alerte@secure-verif.example.biz>
//   "support@bank.com" <x@other.net>
// Pure functions, no network. Complements the classifier's `suspicious` score.

import type { Address } from './api'

export interface SenderMismatch {
	/** What the display name claims (a domain, an address or a brand). */
	claimed: string
	/** The domain the mail really comes from. */
	actual: string
	kind: 'address' | 'domain' | 'brand'
}

// Two-label public suffixes common in Europe and elsewhere. Not the full Public
// Suffix List (too big for the browser); enough for the registrable domain of
// most senders.
const TWO_LEVEL = new Set([
	'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.kr', 'co.in',
	'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.cn', 'com.hk', 'com.sg', 'co.za', 'gouv.fr', 'asso.fr',
	'nom.fr', 'com.es', 'com.pl', 'co.il', 'com.ua',
])

// Endings that make "x.y" in a display name a domain (not "Dr.Who" or "J.Smith").
const TLDS = new Set(['com', 'net', 'org', 'info', 'biz', 'io', 'co', 'app', 'dev', 'me', 'xyz', 'online', 'shop', 'site',
	'fr', 'de', 'uk', 'eu', 'be', 'ch', 'es', 'it', 'nl', 'pt', 'pl', 'at', 'se', 'no', 'dk', 'fi', 'ie', 'lu', 'us', 'ca',
	'au', 'nz', 'jp', 'cn', 'ru', 'br', 'in', 'top', 'club', 'live', 'gov', 'edu'])

/** example.co.uk for mail.example.co.uk; lower case, no trailing dot. */
export function registrableDomain(host: string): string {
	const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
	if (labels.length <= 2) return labels.join('.')
	const lastTwo = labels.slice(-2).join('.')
	return labels.slice(TWO_LEVEL.has(lastTwo) ? -3 : -2).join('.')
}

function domainOf(email: string): string {
	const at = email.lastIndexOf('@')
	return at < 0 ? '' : email.slice(at + 1).toLowerCase().trim()
}

// Brands and institutions phishing impersonates most, as the word appears in a
// display name -> the domain stems that legitimately send for them. A name
// with the word but an address on none of the stems is flagged.
const BRANDS: Record<string, string[]> = {
	paypal: ['paypal'], amazon: ['amazon'], apple: ['apple', 'icloud'], icloud: ['apple', 'icloud'],
	microsoft: ['microsoft', 'outlook', 'live', 'office'], outlook: ['microsoft', 'outlook', 'live', 'office'],
	google: ['google', 'gmail', 'youtube'], gmail: ['google', 'gmail'], netflix: ['netflix'],
	facebook: ['facebook', 'facebookmail', 'meta'], instagram: ['instagram', 'facebookmail', 'meta'],
	whatsapp: ['whatsapp', 'facebookmail', 'meta'], dhl: ['dhl'], ups: ['ups'], fedex: ['fedex'],
	chronopost: ['chronopost'], colissimo: ['colissimo', 'laposte'], 'la poste': ['laposte'],
	ameli: ['ameli', 'assurance-maladie'], impots: ['impots', 'dgfip'], 'impôts': ['impots', 'dgfip'],
	caf: ['caf'], 'crédit agricole': ['credit-agricole', 'ca-'], 'credit agricole': ['credit-agricole', 'ca-'],
	'société générale': ['societegenerale', 'socgen'], 'societe generale': ['societegenerale', 'socgen'],
	bnp: ['bnpparibas', 'bnp'], 'banque postale': ['labanquepostale'], boursorama: ['boursorama', 'boursobank'],
	revolut: ['revolut'], mastercard: ['mastercard'], docusign: ['docusign'],
	dropbox: ['dropbox'], linkedin: ['linkedin'],
	// Generic words: on their own they prove nothing, but "Bank"/"Banque" from a
	// domain without "bank"/"banque" in it is worth a look.
	bank: ['bank', 'banque'], banque: ['banque', 'bank'],
}

function words(s: string): string {
	return ` ${s.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}.@-]+/gu, ' ')} `
}

/**
 * Why the sender's name does not match its address, or null. Only flags clear
 * claims: an e-mail address or a domain written in the name, or a known brand.
 */
export function senderMismatch(from: Address | undefined | null): SenderMismatch | null {
	if (!from?.email) return null
	const actualHost = domainOf(from.email)
	if (!actualHost) return null
	const actual = registrableDomain(actualHost)
	const name = (from.label ?? '').trim()
	if (!name || name.toLowerCase() === from.email.toLowerCase()) return null

	// 1. An address in the name that is not the real one.
	const addr = name.match(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/)
	if (addr) {
		if (addr[0].toLowerCase() !== from.email.toLowerCase() && registrableDomain(addr[1]) !== actual) {
			return { claimed: addr[0].toLowerCase(), actual, kind: 'address' }
		}
		return null
	}
	// 2. A domain in the name ("paypal.com") from another registrable domain.
	const dom = name.match(/\b((?:[a-z0-9-]+\.)+([a-z]{2,}))\b/i)
	if (dom && TLDS.has(dom[2].toLowerCase())) {
		const claimed = registrableDomain(dom[1])
		if (claimed !== actual) return { claimed, actual, kind: 'domain' }
		return null
	}
	// 3. A brand the domain does not carry.
	const w = words(name)
	const host = actualHost.replace(/\./g, ' ')
	for (const [brand, stems] of Object.entries(BRANDS)) {
		if (!w.includes(` ${brand} `)) continue
		if (stems.some((s) => host.includes(s))) return null
		return { claimed: brand, actual, kind: 'brand' }
	}
	return null
}

/** One sentence for the reader banner. */
export function mismatchText(m: SenderMismatch): string {
	const what = m.kind === 'brand' ? `“${m.claimed}”` : m.claimed
	return `The sender's name says ${what}, but the mail comes from ${m.actual}. Check before clicking a link or paying anything.`
}
