// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'vitest'
import { detectProvider, googleAuthUrl, PROVIDERS, providerFields } from './providers'

test('providers are found from the address domain', () => {
	expect(detectProvider('Jane@Gmail.com')?.id).toBe('gmail')
	expect(detectProvider('x@wanadoo.fr')?.id).toBe('orange')
	expect(detectProvider('x@hotmail.fr')?.id).toBe('outlook')
	expect(detectProvider('x@example.org')).toBeNull()
	expect(detectProvider('no-at-sign')).toBeNull()
	// Every provider has a TLS port pair and at least one domain.
	for (const p of PROVIDERS) {
		expect(p.domains.length).toBeGreaterThan(0)
		expect([993]).toContain(p.imap.port)
		expect([465, 587]).toContain(p.smtp.port)
	}
})

test('fields: servers and the full address as user name', () => {
	expect(providerFields(detectProvider('a@gmail.com')!, ' a@gmail.com ')).toEqual({
		imapHost: 'imap.gmail.com', imapPort: '993', imapSslMode: 'ssl', imapUser: 'a@gmail.com',
		smtpHost: 'smtp.gmail.com', smtpPort: '465', smtpSslMode: 'ssl', smtpUser: 'a@gmail.com',
	})
})

test('Google consent URL: offline access, consent prompt, state and login hint', () => {
	const u = new URL(googleAuthUrl({ clientId: 'cid.apps.googleusercontent.com', redirectUrl: 'https://w.test/index.php/apps/mail/integration/google-auth', scope: 'https://mail.google.com/', state: 'st4te', email: 'a@gmail.com' }))
	expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
	expect(Object.fromEntries(u.searchParams)).toEqual({
		client_id: 'cid.apps.googleusercontent.com', redirect_uri: 'https://w.test/index.php/apps/mail/integration/google-auth', response_type: 'code',
		scope: 'https://mail.google.com/', access_type: 'offline', prompt: 'consent', state: 'st4te', login_hint: 'a@gmail.com',
	})
})
