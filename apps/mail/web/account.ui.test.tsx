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
import { AccountSetup } from './Account'

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
