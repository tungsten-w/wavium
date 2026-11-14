// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Known mail providers (v2.1, "connectivity"): their servers, so nobody has to
// look up IMAP/SMTP settings, and how to get the password Wavium needs (most
// big providers want an app password, not the account password).

export interface Provider {
	id: string
	name: string
	domains: string[]
	imap: { host: string, port: number, ssl: 'ssl' | 'tls' }
	smtp: { host: string, port: number, ssl: 'ssl' | 'tls' }
	/** What to type in the password field. */
	password: 'app' | 'account'
	/** Where to create an app password. */
	appPasswordUrl?: string
	/** One line about the provider's quirks. */
	note?: string
	/** Signs in with OAuth when the admin set it up ("Sign in with Google"). */
	oauth?: 'google'
}

export const PROVIDERS: Provider[] = [
	{
		id: 'gmail', name: 'Gmail', domains: ['gmail.com', 'googlemail.com'],
		imap: { host: 'imap.gmail.com', port: 993, ssl: 'ssl' }, smtp: { host: 'smtp.gmail.com', port: 465, ssl: 'ssl' },
		password: 'app', appPasswordUrl: 'https://myaccount.google.com/apppasswords', oauth: 'google',
		note: 'Google needs 2-Step Verification on, then an app password (16 letters) instead of your Google password.',
	},
	{
		id: 'icloud', name: 'iCloud', domains: ['icloud.com', 'me.com', 'mac.com'],
		imap: { host: 'imap.mail.me.com', port: 993, ssl: 'ssl' }, smtp: { host: 'smtp.mail.me.com', port: 587, ssl: 'tls' },
		password: 'app', appPasswordUrl: 'https://account.apple.com/account/manage',
		note: 'Apple asks for an app-specific password (Sign-In and Security > App-Specific Passwords).',
	},
	{
		id: 'yahoo', name: 'Yahoo', domains: ['yahoo.com', 'yahoo.fr', 'ymail.com'],
		imap: { host: 'imap.mail.yahoo.com', port: 993, ssl: 'ssl' }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, ssl: 'ssl' },
		password: 'app', appPasswordUrl: 'https://login.yahoo.com/account/security',
		note: 'Yahoo asks for an app password (Account security > Generate app password).',
	},
	{
		id: 'outlook', name: 'Outlook / Hotmail', domains: ['outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr', 'live.com', 'live.fr', 'msn.com'],
		imap: { host: 'outlook.office365.com', port: 993, ssl: 'ssl' }, smtp: { host: 'smtp-mail.outlook.com', port: 587, ssl: 'tls' },
		password: 'app', appPasswordUrl: 'https://account.live.com/proofs/manage/additional',
		note: 'Microsoft turned off plain passwords for most accounts: an app password works only with two-step verification on.',
	},
	{
		id: 'orange', name: 'Orange', domains: ['orange.fr', 'wanadoo.fr'],
		imap: { host: 'imap.orange.fr', port: 993, ssl: 'ssl' }, smtp: { host: 'smtp.orange.fr', port: 465, ssl: 'ssl' },
		password: 'account', note: 'Your usual Orange mail password.',
	},
	{
		id: 'free', name: 'Free', domains: ['free.fr'],
		imap: { host: 'imap.free.fr', port: 993, ssl: 'ssl' }, smtp: { host: 'smtp.free.fr', port: 465, ssl: 'ssl' },
		password: 'account', note: 'Your Free mail password (IMAP must be on in your Free account).',
	},
	{
		id: 'sfr', name: 'SFR', domains: ['sfr.fr', 'neuf.fr'],
		imap: { host: 'imap.sfr.fr', port: 993, ssl: 'ssl' }, smtp: { host: 'smtp.sfr.fr', port: 465, ssl: 'ssl' },
		password: 'account', note: 'Your SFR mail password.',
	},
	{
		id: 'laposte', name: 'La Poste', domains: ['laposte.net'],
		imap: { host: 'imap.laposte.net', port: 993, ssl: 'ssl' }, smtp: { host: 'smtp.laposte.net', port: 465, ssl: 'ssl' },
		password: 'account', note: 'Your laposte.net password.',
	},
]

/** The provider of an address, from its domain (case-insensitive). */
export function detectProvider(email: string): Provider | null {
	const at = email.trim().toLowerCase().lastIndexOf('@')
	if (at < 0) return null
	const domain = email.trim().toLowerCase().slice(at + 1)
	return PROVIDERS.find((p) => p.domains.includes(domain)) ?? null
}

/** The account fields a provider fills in (user names are the full address). */
export function providerFields(p: Provider, email: string) {
	return {
		imapHost: p.imap.host, imapPort: String(p.imap.port), imapSslMode: p.imap.ssl, imapUser: email.trim(),
		smtpHost: p.smtp.host, smtpPort: String(p.smtp.port), smtpSslMode: p.smtp.ssl, smtpUser: email.trim(),
	}
}

/** Google's consent page for Gmail over OAuth (the redirect and state come from Mail). */
export function googleAuthUrl(o: { clientId: string, redirectUrl: string, scope: string, state: string, email?: string }): string {
	const q = new URLSearchParams({
		client_id: o.clientId, redirect_uri: o.redirectUrl, response_type: 'code', scope: o.scope,
		access_type: 'offline', prompt: 'consent', state: o.state,
	})
	if (o.email) q.set('login_hint', o.email.trim())
	return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
}
