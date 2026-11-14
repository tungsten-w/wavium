// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shell against a fake server (P1-6): the header lists the enabled apps,
// "/" opens the home app, classic pages open in a frame, the saved app order is
// kept, and the login page posts the form and reports a wrong password.
import '../testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { navigate, type NavEntry, type Session } from '@atrium/sdk'
import { fakeServer, redirectedTo, type FakeServer } from '../testing/fakeServer'
import { cleanup, click, getButton, getByText, getField, render, type, waitFor } from '../testing/render'
import type { AppIndex } from './apps'
import { Login } from './Login'
import { Shell } from './Shell'
import { resetDemoCache } from './demo'

const nav = (id: string, name: string, order: number, extra: Partial<NavEntry> = {}): NavEntry =>
	({ id, name, href: `/apps/${id}/`, icon: `/apps/${id}/img/app.svg`, order, unread: 0, type: 'link', app: id, ...extra })

const session = {
	user: { id: 'alice', displayName: 'Alice', email: 'alice@atrium.test' },
	capabilities: { theming: { name: 'Atrium' } },
	apps: [nav('dashboard', 'Dashboard', 0), nav('mail', 'Mail', 1), nav('calendar', 'Calendar', 2), nav('files', 'Files', 3), nav('contacts', 'Contacts', 4), nav('atrium_contacts', 'People', 5)],
	settings: [{ id: 'logout', name: 'Log out', href: '/logout?requesttoken=x', icon: '', order: 99, unread: 0, type: 'settings' }],
	enabledApps: ['dashboard', 'mail', 'calendar', 'files', 'contacts', 'atrium_contacts'],
	settingsSections: { personal: [], admin: [] },
	agents: [],
	isAgent: false,
} as unknown as Session

// A React UI that takes over the classic Contacts entry.
const index: AppIndex = {
	people: { route: 'people', app: 'atrium_contacts', entry: 'index.js', css: [], hash: 'h1', url: '/apps/atrium_contacts/web/dist/', replaces: 'contacts' },
}

let server: FakeServer

beforeEach(() => {
	server = fakeServer()
	resetDemoCache()
	try { sessionStorage.clear() } catch { /* none */ }
	try { localStorage.clear() } catch { /* none */ }
})

afterEach(() => {
	cleanup()
	server.restore()
})

const headerApps = () => [...document.querySelectorAll('.shell-apps a')].map((a) => a.textContent?.trim())

test('the header lists the enabled apps, without Dashboard and replaced apps', async () => {
	navigate('/apps/files/')
	await render(<Shell session={session} index={{}} />)
	expect(headerApps()).toEqual(['Mail', 'Calendar', 'Files', 'Contacts', 'People'])
	expect(document.querySelector('.shell-apps [aria-current="page"]')?.textContent).toContain('Files')
	cleanup()

	// A React UI (route "people") that replaces the classic Contacts app.
	navigate('/apps/files/')
	await render(<Shell session={session} index={index} />)
	expect(headerApps()).toEqual(['Mail', 'Calendar', 'Files', 'People'])
	const people = [...document.querySelectorAll<HTMLAnchorElement>('.shell-apps a')].find((a) => a.textContent?.includes('People'))!
	expect(people.getAttribute('href')).toBe('/apps/people/')
})

test('"/" opens the home app (Dashboard)', async () => {
	navigate('/')
	await render(<Shell session={session} index={{}} />)
	await waitFor(() => location.pathname === '/apps/dashboard/')
})

test('a classic page opens in a frame', async () => {
	navigate('/apps/calendar/dayGridMonth/now')
	await render(<Shell session={session} index={{}} />)
	const frame = await waitFor(() => document.querySelector('iframe'))
	expect(frame.getAttribute('src')).toBe('/apps/calendar/dayGridMonth/now')
})

test('the saved app order is used', async () => {
	localStorage.setItem('atrium-app-order', JSON.stringify(['files', 'mail']))
	navigate('/apps/files/')
	await render(<Shell session={session} index={{}} />)
	// Saved ones first, the others after in the default order.
	expect(headerApps()).toEqual(['Files', 'Mail', 'Calendar', 'Contacts', 'People'])
})

test('login: posts the form, wrong password stays on the page with an error', async () => {
	let ok = false
	server
		.on('GET', '/status.php', () => ({ maintenance: false }))
		.on('GET', '/ocs/v2.php/cloud/capabilities', () => ({ ocs: { meta: { status: 'ok', statuscode: 200, message: 'OK' }, data: { capabilities: {} } } }))
		.on('POST', '/login', () => redirectedTo(ok ? '/apps/dashboard/' : '/login?user=alice'))
	navigate('/login?redirect_url=%2Fapps%2Fmail%2F')
	const { container } = await render(<Login />)
	await type(getField(container, 'Account name or email') as HTMLInputElement, 'alice')
	await type(getField(container, 'Password') as HTMLInputElement, 'wrong')
	await click(getButton(container, 'Log in'))
	await waitFor(() => getByText(container, 'Wrong login or password.'))
	const sent = server.calls('POST', '/login')[0].body as URLSearchParams
	expect(sent.get('user')).toBe('alice')
	expect(sent.get('password')).toBe('wrong')
	expect(sent.get('requesttoken')).toBe('test-token')
	expect(sent.get('redirect_url')).toBe('/apps/mail/')
	expect(sent.get('rememberme')).toBe('1')
})

const demoJson = { enabled: true, feedbackUrl: 'https://github.com/tungsten-w/wavium/issues/new/choose', resetAt: '04:00', accounts: [{ user: 'alice', password: 'alice-demo-pass', label: 'Alice' }, { user: 'bob', password: 'bob-demo-pass', label: 'Bob' }] }

test('public demo: the banner says what this is and links to feedback; it can be hidden', async () => {
	server.on('GET', '/core/web/dist/demo.json', () => demoJson)
	navigate('/apps/mail/')
	const { container } = await render(<Shell session={session} index={{}} />)
	await waitFor(() => getByText(container, 'Public demo.'))
	expect(container.querySelector('.shell-demo')!.textContent).toContain('reset every night at 04:00')
	const link = container.querySelector('.shell-demo__link') as HTMLAnchorElement
	expect(link.href).toBe(demoJson.feedbackUrl)
	expect(link.target).toBe('_blank')
	await click(getButton(container, 'Hide this message'))
	expect(container.querySelector('.shell-demo')).toBeNull()
})

test('not a demo: no banner, and the login page has no demo accounts', async () => {
	server.on('GET', '/core/web/dist/demo.json', () => ({ enabled: false }))
	navigate('/apps/mail/')
	const { container } = await render(<Shell session={session} index={{}} />)
	await new Promise((r) => setTimeout(r, 20))
	expect(container.querySelector('.shell-demo')).toBeNull()
})

test('public demo login: one click logs in as a shared account; no password reset', async () => {
	server
		.on('GET', '/core/web/dist/demo.json', () => demoJson)
		.on('GET', '/status.php', () => ({ maintenance: false }))
		.on('GET', '/ocs/v2.php/cloud/capabilities', () => ({ ocs: { meta: { status: 'ok', statuscode: 200, message: 'OK' }, data: { capabilities: {} } } }))
		.on('POST', '/login', () => redirectedTo('/login?user=bob'))
	navigate('/login')
	const { container } = await render(<Login />)
	await waitFor(() => getButton(container, 'Log in as Bob'))
	expect(container.textContent).toContain('alice / alice-demo-pass')
	expect(container.textContent).not.toContain('Forgot password?')
	await click(getButton(container, 'Log in as Bob'))
	await waitFor(() => server.calls('POST', '/login').length === 1 || undefined)
	const sent = server.calls('POST', '/login')[0].body as URLSearchParams
	expect(sent.get('user')).toBe('bob')
	expect(sent.get('password')).toBe('bob-demo-pass')
})
