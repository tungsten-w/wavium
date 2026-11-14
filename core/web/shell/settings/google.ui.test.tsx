// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Move from Google and Google sign-in (v2.1) against a fake server.
import '../../testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Session } from '@atrium/sdk'
import { fakeServer, type FakeServer } from '../../testing/fakeServer'
import { cleanup, click, getButton, getByText, getField, render, type, waitFor } from '../../testing/render'
import { AdminGoogle, MoveFromGoogle } from './Google'

const session = { user: { id: 'alice', displayName: 'Alice', isAdmin: true } } as unknown as Session
const ms = (rows: string) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/">${rows}</d:multistatus>`, { status: 207, headers: { 'content-type': 'application/xml' } })
const row = (href: string, name: string, type: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname><d:resourcetype><d:collection/>${type}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`

// happy-dom cannot parse CalDAV listings (docs/lessons.md): the targets are given.
const TARGETS = async () => ({ cals: [{ url: '/remote.php/dav/calendars/alice/personal/', name: 'Personal' }], books: [{ url: '/remote.php/dav/addressbooks/users/alice/contacts/', name: 'Contacts' }] })
let server: FakeServer
let google: Record<string, unknown>
beforeEach(() => {
	google = { configured: false, clientId: null, redirectUrl: 'https://w.test/index.php/apps/mail/integration/google-auth', scope: 'https://mail.google.com/' }
	server = fakeServer()
		.on('GET', '/apps/mail/api/integration/google', () => ({ status: 'success', data: google }))
		.on('PROPFIND', '/remote.php/dav/calendars/alice/', () => ms(row('/remote.php/dav/calendars/alice/', '', '') + row('/remote.php/dav/calendars/alice/personal/', 'Personal', '<cal:calendar/>') + row('/remote.php/dav/calendars/alice/sub-1/', 'Holidays', '<cs:subscribed/>')))
		.on('PROPFIND', '/remote.php/dav/addressbooks/users/alice/', () => ms(row('/remote.php/dav/addressbooks/users/alice/contacts/', 'Contacts', '<card:addressbook/>')))
		.on('MKCOL', /\/sub-/, () => new Response(null, { status: 201 }))
		.on('PUT', /\.ics$/, () => new Response(null, { status: 201 }))
		.on('POST', '/apps/mail/api/integration/google', (req) => { google = { ...google, configured: true, clientId: (req.body as { clientId: string }).clientId }; return { status: 'success', data: null } })
})
afterEach(() => { cleanup(); server.restore() })

test('Move from Google: Gmail steps, subscribe to the secret address, import .ics into a real calendar', async () => {
	const { container } = await render(<MoveFromGoogle session={session} targets={TARGETS} />)
	const gmail = await waitFor(() => container.querySelector<HTMLElement>('[aria-label="Gmail"]'))
	expect(gmail.querySelector('a[href="https://myaccount.google.com/apppasswords"]')).toBeTruthy()
	expect(getByText(gmail, 'Add my Gmail').closest('a')!.getAttribute('href')).toBe('/apps/mail/setup')
	const cal = container.querySelector<HTMLElement>('[aria-label="Google Calendar"]')!
	await waitFor(() => (getField(cal, 'Into') as HTMLSelectElement).options.length === 1 ? true : null)
	await type(getField(cal, 'Secret address in iCal format'), 'webcal://calendar.google.com/calendar/ical/me/private-x/basic.ics')
	await click(getButton(cal, 'Subscribe'))
	await waitFor(() => server.calls('MKCOL').length === 1)
	await waitFor(() => getByText(cal, /Subscribed/))
	const input = cal.querySelector<HTMLInputElement>('input[aria-label="ics files"]')!
	const file = new File(['BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20261120T100000Z\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'], 'cal.ics', { type: 'text/calendar' })
	Object.defineProperty(input, 'files', { value: [file] })
	input.dispatchEvent(new Event('change', { bubbles: true }))
	await waitFor(() => getByText(cal, /1 events added/))
	expect(server.calls('PUT')[0].path).toBe('/remote.php/dav/calendars/alice/personal/e1.ics')
})

test('With Google sign-in on, the Gmail card says no app password is needed', async () => {
	google = { ...google, configured: true, clientId: 'cid' }
	const { container } = await render(<MoveFromGoogle session={session} targets={TARGETS} />)
	await waitFor(() => getByText(container, 'Sign in with Google'))
	expect(container.querySelector('a[href="https://myaccount.google.com/apppasswords"]')).toBeNull()
})

test('Google sign-in admin: redirect URI shown, client saved', async () => {
	const { container } = await render(<AdminGoogle session={session} />)
	await waitFor(() => getByText(container, 'https://w.test/index.php/apps/mail/integration/google-auth'))
	expect(container.textContent).toContain('Off: Gmail users connect with an app password')
	await type(getField(container, 'Client ID'), '1234-abc.apps.googleusercontent.com')
	await type(getField(container, 'Client secret'), 'fake-secret-not-real')
	await click(getButton(container, 'Save'))
	await waitFor(() => getByText(container, /On: Gmail users see/))
	expect(server.calls('POST', '/apps/mail/api/integration/google')[0].body).toEqual({ clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'fake-secret-not-real' })
})
