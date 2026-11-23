// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mail account setup (v2.1): known providers fill the servers in; Gmail can
// sign in with Google when the admin set up OAuth; a failed sign-in leaves no
// half-made account.
import '../../../core/web/testing/dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fakeServer, type FakeServer } from '../../../core/web/testing/fakeServer'
import { cleanup, click, getButton, getField, queryByText, render, type, waitFor } from '../../../core/web/testing/render'
import { Snackbars } from '@atrium/ui'
import { AccountSettings, AccountSetup } from './Account'

let server: FakeServer
let google = { configured: false, clientId: null as string | null, redirectUrl: 'https://w.test/index.php/apps/mail/integration/google-auth', scope: 'https://mail.google.com/' }

beforeEach(() => {
	server = fakeServer()
		.on('GET', '/apps/mail/api/integration/google', () => ({ status: 'success', data: google }))
		.on('POST', '/apps/mail/api/accounts', (req) => ({ id: 42, ...(req.body as object) }))
		.on('GET', '/apps/mail/api/mailboxes', () => ({ id: 42, email: 'x', delimiter: '/', mailboxes: [] }))
		.on('POST', '/apps/mail/api/oauth/state', () => ({ status: 'success', data: { state: 'st4te' } }))
		.on('DELETE', '/apps/mail/api/accounts/42', () => ({}))
})
afterEach(() => { cleanup(); server.restore(); vi.restoreAllMocks(); google = { ...google, configured: false, clientId: null } })

test('a known provider: servers filled and hidden, one password for both', async () => {
	const done = vi.fn()
	const { container } = await render(<AccountSetup onDone={done} />)
	await type(getField(container, 'Account name'), 'Perso')
	await type(getField(container, 'Email address'), 'jean@orange.fr')
	await waitFor(() => container.querySelector('[aria-label="Provider"]'))
	expect(container.textContent).toContain('Orange: server settings are filled in for you.')
	expect(queryByText(container, 'IMAP · incoming mail')).toBeNull()
	await type(getField(container, 'Password'), 's3cret')
	await click(getButton(container, 'Connect account'))
	await waitFor(() => (done.mock.calls.length ? true : null))
	expect(server.calls('POST', '/apps/mail/api/accounts')[0].body).toMatchObject({
		emailAddress: 'jean@orange.fr', imapHost: 'imap.orange.fr', imapPort: 993, imapUser: 'jean@orange.fr', imapPassword: 's3cret',
		smtpHost: 'smtp.orange.fr', smtpPort: 465, smtpUser: 'jean@orange.fr', smtpPassword: 's3cret',
	})
})

test('a refused connection says what the mail server said, not "HTTP 400" (V4-23)', async () => {
	server.on('POST', '/apps/mail/api/accounts', () => new Response(JSON.stringify({
		status: 'fail',
		data: { error: 'AUTHENTICATION', service: 'IMAP', host: 'imap.gmail.com', port: 993, details: 'Authentication failed.' },
	}), { status: 400, headers: { 'Content-Type': 'application/json' } }))
	const { container } = await render(<><AccountSetup onDone={() => {}} /><Snackbars /></>)
	await type(getField(container, 'Account name'), 'Gmail')
	await type(getField(container, 'Email address'), 'a@gmail.com')
	await waitFor(() => container.querySelector('[aria-label="Provider"]'))
	await type(getField(container, 'App password'), 'abcdefghijklmnop')
	await click(getButton(container, 'Connect account'))

	// Earlier tests queue toasts of their own, so look at all of them.
	const shown = () => [...document.querySelectorAll('.at-snackbar')].map((el) => el.textContent ?? '')
	const message = await waitFor(() => shown().find((t) => t.includes('imap.gmail.com')))
	expect(message).toContain('IMAP at imap.gmail.com:993')
	expect(message).toContain('Authentication failed.')
	expect(message).not.toContain('HTTP 400')
})

test('an app password pasted with its spaces is sent without them (V4-23)', async () => {
	const done = vi.fn()
	const { container } = await render(<AccountSetup onDone={done} />)
	await type(getField(container, 'Account name'), 'Gmail')
	await type(getField(container, 'Email address'), 'a@gmail.com')
	await waitFor(() => container.querySelector('[aria-label="Provider"]'))
	// Google shows app passwords in groups of four; copying one keeps the spaces.
	await type(getField(container, 'App password'), 'abcd efgh ijkl mnop')
	await click(getButton(container, 'Connect account'))
	await waitFor(() => (done.mock.calls.length ? true : null))
	const sent = server.calls('POST', '/apps/mail/api/accounts')[0].body as Record<string, unknown>
	expect(sent.imapPassword).toBe('abcdefghijklmnop')
	expect(sent.smtpPassword).toBe('abcdefghijklmnop')
})

test('an account password keeps the spaces inside it, only the ends are trimmed (V4-23)', async () => {
	const done = vi.fn()
	const { container } = await render(<AccountSetup onDone={done} />)
	await type(getField(container, 'Account name'), 'Perso')
	await type(getField(container, 'Email address'), 'jean@orange.fr')
	await waitFor(() => container.querySelector('[aria-label="Provider"]'))
	await type(getField(container, 'Password'), ' correct horse battery ')
	await click(getButton(container, 'Connect account'))
	await waitFor(() => (done.mock.calls.length ? true : null))
	expect((server.calls('POST', '/apps/mail/api/accounts')[0].body as Record<string, unknown>).imapPassword).toBe('correct horse battery')
})

test('Gmail without OAuth: app password help, no Google button; server settings on demand', async () => {
	const { container } = await render(<AccountSetup onDone={() => {}} />)
	await type(getField(container, 'Email address'), 'a@gmail.com')
	await waitFor(() => container.querySelector('[aria-label="Provider"]'))
	expect(container.querySelector('a[href="https://myaccount.google.com/apppasswords"]')).toBeTruthy()
	expect(queryByText(container, 'Sign in with Google')).toBeNull()
	expect(getField(container, 'App password')).toBeTruthy()
	await click(getButton(container, 'Server settings…'))
	expect((getField(container, 'Server') as HTMLInputElement).value).toBe('imap.gmail.com')
})

test('Gmail with OAuth: account created as xoauth2, Google window opened, roles set', async () => {
	google = { ...google, configured: true, clientId: 'cid.apps.googleusercontent.com' }
	const popup = { closed: false }
	const open = vi.spyOn(window, 'open').mockImplementation(() => { setTimeout(() => { popup.closed = true }, 30); return popup as unknown as Window })
	const done = vi.fn()
	const { container } = await render(<AccountSetup onDone={done} />)
	await type(getField(container, 'Email address'), 'a@gmail.com')
	await click(await waitFor(() => getButton(container, 'Sign in with Google')))
	await waitFor(() => (done.mock.calls.length ? true : null), 4000)
	expect(server.calls('POST', '/apps/mail/api/accounts')[0].body).toMatchObject({ authMethod: 'xoauth2', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', emailAddress: 'a@gmail.com' })
	expect(server.calls('POST', '/apps/mail/api/oauth/state')[0].body).toEqual({ accountId: 42 })
	const url = new URL(open.mock.calls[0][0] as string)
	expect(url.searchParams.get('state')).toBe('st4te')
	expect(url.searchParams.get('client_id')).toBe('cid.apps.googleusercontent.com')
	expect(server.calls('GET', '/apps/mail/api/mailboxes')).toHaveLength(1)
})

test('Gmail with OAuth, pop-up blocked: the half-made account is removed', async () => {
	google = { ...google, configured: true, clientId: 'cid' }
	vi.spyOn(window, 'open').mockImplementation(() => null)
	const done = vi.fn()
	const { container } = await render(<AccountSetup onDone={done} />)
	await type(getField(container, 'Email address'), 'a@gmail.com')
	await click(await waitFor(() => getButton(container, 'Sign in with Google')))
	await waitFor(() => server.calls('DELETE', '/apps/mail/api/accounts/42').length === 1)
	expect(done).not.toHaveBeenCalled()
})

test('an unknown provider: both usernames follow the whole address, not its first letter', async () => {
	const { container } = await render(<AccountSetup onDone={() => {}} />)
	// Typed letter by letter, as a person does.
	const address = 'jean@monbox.org'
	for (let i = 1; i <= address.length; i++) await type(getField(container, 'Email address'), address.slice(0, i))
	const users = [...container.querySelectorAll('label')].filter((l) => l.textContent?.startsWith('Username'))
		.map((l) => (l.getAttribute('for') ? container.querySelector(`#${CSS.escape(l.getAttribute('for')!)}`) : l.querySelector('input')) as HTMLInputElement)
	expect(users.map((u) => u.value)).toEqual([address, address])
})

test('another account: back link and a clear title', async () => {
	const back = vi.fn()
	const { container } = await render(<AccountSetup onDone={() => {}} onBack={back} />)
	expect(container.textContent).toContain('Add a mail account')
	await click(getButton(container, 'Back to mail'))
	expect(back).toHaveBeenCalled()
})

const saved = {
	id: 42, accountId: 42, name: 'Gmail', emailAddress: 'a@gmail.com', imapHost: 'imap.gmail.com', imapPort: 993, imapSslMode: 'ssl', imapUser: 'a@gmail.com',
	smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSslMode: 'ssl', smtpUser: 'a@gmail.com', authMethod: 'xoauth2', signature: null, editorMode: 'plaintext',
	draftsMailboxId: null, sentMailboxId: null, trashMailboxId: null, archiveMailboxId: null, junkMailboxId: null, snoozeMailboxId: null,
	showSubscribedOnly: false, aliases: [], isDelegated: false,
}

test('editing an account: blank passwords are kept, a Google sign-in stays a Google sign-in', async () => {
	server.on('PUT', '/apps/mail/api/accounts/42', (req) => ({ ...saved, ...(req.body as object) }))
	const { container } = await render(<AccountSettings account={saved} boxes={[]} onDone={() => {}} onClose={() => {}} />)
	await type(getField(container, 'Account name'), 'Gmail perso')
	await click(getButton(container, 'Save connection'))
	await waitFor(() => server.calls('PUT', '/apps/mail/api/accounts/42').length === 1 || null)
	const body = server.calls('PUT', '/apps/mail/api/accounts/42')[0].body as Record<string, unknown>
	expect(body.authMethod).toBe('xoauth2')
	expect('imapPassword' in body).toBe(false)
	expect('smtpPassword' in body).toBe(false)
})
