import { describe, expect, it } from 'vitest'
import { mismatchText, registrableDomain, senderMismatch } from './spoof'

const from = (label: string, email: string) => ({ label, email })

describe('registrableDomain', () => {
	it('keeps the last two labels, three for known two-level suffixes', () => {
		expect(registrableDomain('mail.example.com')).toBe('example.com')
		expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk')
		expect(registrableDomain('impots.gouv.fr')).toBe('impots.gouv.fr')
		expect(registrableDomain('Example.COM.')).toBe('example.com')
	})
})

describe('senderMismatch: flags the phishing shapes', () => {
	it('a brand in the name, a domain without it (the demo scam mail)', () => {
		expect(senderMismatch(from('Banque Nationale - Sécurité', 'alerte@secure-bnq-verif.example.biz')))
			.toEqual({ claimed: 'banque', actual: 'example.biz', kind: 'brand' })
		expect(senderMismatch(from('PayPal Service', 'service@pp-security.example.net'))?.claimed).toBe('paypal')
		expect(senderMismatch(from('Assurance Maladie - ameli', 'info@remboursement-fr.example.com'))?.claimed).toBe('ameli')
	})
	it('a domain written in the name that is not the sender\'s', () => {
		expect(senderMismatch(from('paypal.com', 'x@evil.example')))
			.toEqual({ claimed: 'paypal.com', actual: 'evil.example', kind: 'domain' })
	})
	it('an address written in the name that is not the sender\'s', () => {
		expect(senderMismatch(from('support@bank.example.com', 'x@other.example.net')))
			.toEqual({ claimed: 'support@bank.example.com', actual: 'example.net', kind: 'address' })
	})
})

describe('senderMismatch: leaves honest senders alone', () => {
	it.each([
		['Bob Durand', 'bob@atrium.test'],
		['PayPal', 'service@paypal.fr'],
		['PayPal', 'service@mail.paypal.com'],
		['Amazon.fr', 'commandes@amazon.fr'],
		['Google', 'no-reply@accounts.google.com'],
		['Électricité Exemple', 'factures@energie.example.com'],
		['Le Journal du Code', 'news@newsletter.example.net'],
		['alice@atrium.test', 'alice@atrium.test'],
		['Alice via support@example.com', 'support@mail.example.com'],
		['Dr.Who Fan Club', 'club@fans.example.org'],
		['Start-ups weekly', 'news@startups.example.com'],
		['', 'noreply@example.com'],
	])('%s <%s>', (label, email) => {
		expect(senderMismatch(from(label, email))).toBeNull()
	})
	it('no sender at all', () => {
		expect(senderMismatch(undefined)).toBeNull()
		expect(senderMismatch(from('Somebody', ''))).toBeNull()
	})
})

describe('mismatchText', () => {
	it('says what is claimed and where the mail comes from', () => {
		expect(mismatchText({ claimed: 'paypal', actual: 'example.biz', kind: 'brand' }))
			.toBe('The sender\'s name says “paypal”, but the mail comes from example.biz. Check before clicking a link or paying anything.')
	})
})
