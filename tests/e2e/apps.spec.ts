// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// V4-12: every app opens with content and no error, one screenshot per app
// (results/screenshots/<app>.png, kept by CI as an artifact), on desktop and
// phone width, plus the Messages link with the dev stack's fake phone.
import { expect, test, type Page } from '@playwright/test'

const USER = process.env.ATRIUM_E2E_USER ?? 'alice'
const PASSWORD = process.env.ATRIUM_E2E_PASSWORD ?? 'alice-demo-pass'
const SHOTS = 'results/screenshots'

const APPS: Array<{ id: string, path: string, ready: string }> = [
	{ id: 'dashboard', path: '/apps/dashboard/', ready: '.dash-card' },
	{ id: 'mail', path: '/apps/mail/', ready: '.ml-messages, .at-empty' },
	{ id: 'messages', path: '/apps/messages/', ready: '.ms-conv, .ms-link, .ms-setup' },
	{ id: 'calendar', path: '/apps/calendar/', ready: '.at-app-main' },
	{ id: 'contacts', path: '/apps/contacts/', ready: '.at-app-main' },
	{ id: 'files', path: '/apps/files/', ready: '.at-app-main' },
	{ id: 'notes', path: '/apps/notes/', ready: '.at-app-main' },
	{ id: 'tasks', path: '/apps/tasks/', ready: '.at-app-main' },
	{ id: 'daily_todo', path: '/apps/daily_todo/', ready: '.at-app-main, iframe' },
	{ id: 'settings-agents', path: '/settings/user/agents', ready: '.at-app-main' },
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

test('every app opens, with a screenshot each (desktop and phone)', async ({ page }) => {
	const problems = watch(page)
	await login(page)
	for (const width of [1360, 390]) {
		await page.setViewportSize({ width, height: width > 500 ? 860 : 800 })
		for (const app of APPS) {
			await page.goto(app.path)
			await expect(page.locator(app.ready).first()).toBeVisible()
			// Let entering animations finish before the picture.
			await page.waitForTimeout(900)
			await page.screenshot({ path: `${SHOTS}/${app.id}${width < 500 ? '-phone' : ''}.png` })
			if (width < 500) {
				const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
				expect(sideways, `${app.id}: no sideways scroll at phone width`).toBe(false)
			}
		}
	}
	expect(problems).toEqual([])
})

test('Messages: link the (fake) phone, read and answer a text', async ({ page }) => {
	const problems = watch(page)
	await login(page)
	await page.goto('/apps/messages/')
	const qr = page.getByRole('button', { name: 'Show the QR code' })
	if (await qr.isVisible().catch(() => false)) {
		await qr.click()
		await expect(page.locator('.ms-qr svg')).toBeVisible()
		await expect(page.getByText('Your phone is linked')).toBeVisible({ timeout: 30_000 })
		await page.getByRole('button', { name: 'Open my texts' }).click()
	}
	await page.locator('.ms-conv').first().click()
	const text = `e2e ${Date.now()}`
	await page.locator('textarea.ms-compose__box').fill(text)
	await page.locator('textarea.ms-compose__box').press('Enter')
	await expect(page.locator('.ms-bubble--me', { hasText: text })).toBeVisible()
	await page.screenshot({ path: `${SHOTS}/messages-thread.png` })
	expect(problems).toEqual([])
})
