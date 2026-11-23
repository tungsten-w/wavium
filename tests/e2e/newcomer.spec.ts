// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// V4-22: what a person sees on a brand-new account -- no mail account, no AI
// provider, no file, no event. Those screens are the first thing a newcomer
// meets and the demo accounts (alice, bob) never show them, so the dev stack
// keeps an account with nothing in it (EMPTY_USER in deploy/dev/seed.php).
//
// Every app must open with an empty state instead of a crash, a spinner that
// never ends or a blank page, and nothing may fail in the console or answer 5xx.
import { expect, test, type Page } from '@playwright/test'

const USER = process.env.ATRIUM_E2E_NEW_USER ?? 'chloe'
const PASSWORD = process.env.ATRIUM_E2E_NEW_PASSWORD ?? 'chloe-demo-pass'
const SHOTS = 'results/screenshots'

/** Apps a new account opens, and what proves the page arrived. */
const APPS: Array<{ id: string, path: string, ready: string }> = [
	{ id: 'dashboard', path: '/apps/dashboard/', ready: '.dash-card, .at-empty' },
	{ id: 'mail', path: '/apps/mail/', ready: '.at-empty, .ml-setup, .ml-messages' },
	{ id: 'messages', path: '/apps/messages/', ready: '.ms-setup, .ms-link, .ms-conv, .at-empty' },
	{ id: 'calendar', path: '/apps/calendar/', ready: '.at-app-main' },
	{ id: 'contacts', path: '/apps/contacts/', ready: '.at-app-main' },
	{ id: 'files', path: '/apps/files/', ready: '.at-app-main' },
	{ id: 'notes', path: '/apps/notes/', ready: '.at-app-main' },
	{ id: 'tasks', path: '/apps/tasks/', ready: '.at-app-main' },
	{ id: 'daily_todo', path: '/apps/daily_todo/', ready: '.at-app-main, iframe' },
	{ id: 'whatsnew', path: '/settings/user/whatsnew', ready: '.whatsnew' },
	{ id: 'ai', path: '/settings/user/ai', ready: '.settings-block' },
	{ id: 'tutorial', path: '/settings/user/tutorial', ready: '.tour' },
]

function watch(page: Page) {
	const problems: string[] = []
	page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
	page.on('response', (r) => { if (r.status() >= 500) problems.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`) })
	return problems
}

async function login(page: Page) {
	await page.goto('/login')
	await page.getByLabel('Account name or email').fill(USER)
	await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
	await page.getByRole('button', { name: 'Log in' }).click()
	await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 })
}

test.describe.configure({ mode: 'serial' })

test('a brand-new account: every app opens, on desktop and on a phone', async ({ browser }) => {
	// One short-lived tab per app, instead of twenty-odd navigations in the same
	// one: that is what a person does, and it keeps the browser's memory flat --
	// a long walk in a single tab dies on a small machine ("Page crashed").
	const signedIn = await browser.newContext()
	const first = await signedIn.newPage()
	await login(first)
	const state = await signedIn.storageState()
	await signedIn.close()

	const problems: string[] = []
	for (const width of [1360, 390]) {
		for (const app of APPS) {
			const ctx = await browser.newContext({ viewport: { width, height: width > 500 ? 860 : 800 }, storageState: state })
			const page = await ctx.newPage()
			page.on('pageerror', (e) => problems.push(`${app.id}: page error: ${e.message}`))
			page.on('response', (r) => { if (r.status() >= 500) problems.push(`${app.id}: ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`) })
			try {
				await page.goto(app.path)
				await expect(page.locator(app.ready).first(), `${app.id}: the page arrives`).toBeVisible({ timeout: 30_000 })
				// Nothing may be left spinning once the page is there.
				await page.waitForTimeout(1200)
				await expect(page.locator('.at-spinner'), `${app.id}: no spinner left running`).toHaveCount(0)
				if (width > 500) await page.screenshot({ path: `${SHOTS}/new-${app.id}.png` })
				else {
					const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
					expect(sideways, `${app.id}: no sideways scroll at phone width`).toBe(false)
				}
			} finally {
				await ctx.close()
			}
		}
	}
	expect(problems).toEqual([])
})

test('a brand-new account is told what to do next, not left in front of nothing', async ({ page }) => {
	const problems = watch(page)
	await login(page)

	// Mail with no account: the way in is on the page.
	await page.goto('/apps/mail/')
	await expect(page.getByRole('heading', { name: /connect your mail/i })
		.or(page.getByText(/add a mail account/i)).first()).toBeVisible({ timeout: 30_000 })

	// No AI provider yet: the page says so and offers to add one.
	await page.goto('/settings/user/ai')
	await expect(page.getByRole('button', { name: /add a provider/i }).first()).toBeVisible()

	expect(problems).toEqual([])
})
