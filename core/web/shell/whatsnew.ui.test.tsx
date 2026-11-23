// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The version badge in the header: it says which version this is, and it opens
// the page that says what each version brought (V4-21).
import '../testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { navigate, type NavEntry, type Session } from '@atrium/sdk'
import { fakeServer, type FakeServer } from '../testing/fakeServer'
import { cleanup, click, queryByText, render, waitFor } from '../testing/render'
import { Shell } from './Shell'
import { resetDemoCache } from './demo'
import { CURRENT, RELEASES } from './whatsnew'

const nav = (id: string, name: string, order: number): NavEntry =>
	({ id, name, href: `/apps/${id}/`, icon: `/apps/${id}/img/app.svg`, order, unread: 0, type: 'link', app: id })

const session = {
	user: { id: 'alice', displayName: 'Alice', email: 'alice@atrium.test', isAdmin: false, groups: [] },
	capabilities: { theming: { name: 'Wavium' } },
	apps: [nav('dashboard', 'Dashboard', 0), nav('files', 'Files', 1)],
	settings: [],
	enabledApps: ['dashboard', 'files'],
	settingsSections: { personal: [], admin: [] },
	agents: [],
	isAgent: false,
} as unknown as Session

let server: FakeServer

beforeEach(() => {
	server = fakeServer().on('GET', '/status.php', () => ({ installed: true, maintenance: false, versionstring: '34.0.5', productname: 'Wavium' }))
	resetDemoCache()
	try { sessionStorage.clear() } catch { /* none */ }
	try { localStorage.clear() } catch { /* none */ }
})

afterEach(() => {
	cleanup()
	server.restore()
})

const badge = () => document.querySelector<HTMLAnchorElement>('.shell-version')

test('the header says which version this is, next to the name', async () => {
	navigate('/apps/files/')
	await render(<Shell session={session} index={{}} />)
	expect(badge()?.textContent).toBe(CURRENT)
	expect(badge()?.getAttribute('href')).toBe('/settings/user/whatsnew')
	// Next to the logo, inside the left side of the header.
	expect(document.querySelector('.shell-left .shell-logo + .shell-version')).toBeTruthy()
})

test('clicking it opens What\'s new, which lists every version with this one marked', async () => {
	navigate('/apps/files/')
	const { container } = await render(<Shell session={session} index={{}} />)
	await click(badge()!)
	await waitFor(() => location.pathname === '/settings/user/whatsnew')
	const page = await waitFor(() => container.querySelector('.whatsnew'))
	// Every released version is on the page, newest first.
	const shown = [...page.querySelectorAll('.whatsnew__head h3')].map((h) => h.textContent?.replace('You are here', '').trim())
	expect(shown).toEqual(RELEASES.map((r) => r.version))
	// The one being run is the only one marked.
	const marked = [...page.querySelectorAll('.whatsnew__item--current .whatsnew__head h3')].map((h) => h.textContent?.replace('You are here', '').trim())
	expect(marked).toEqual([CURRENT])
	// The bullets of the newest version are there, and the Nextcloud release it is built on.
	expect(queryByText(page, RELEASES[0].items[0])).toBeTruthy()
	await waitFor(() => queryByText(container, /Nextcloud 34\.0\.5/))
})
