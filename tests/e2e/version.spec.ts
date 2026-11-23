// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// V4-21: the version badge in the header, in a real browser. Its own file, so a
// failure elsewhere cannot hide it (apps.spec runs serially).
import { expect, test, type Page } from '@playwright/test'

const USER = process.env.ATRIUM_E2E_USER ?? 'alice'
const PASSWORD = process.env.ATRIUM_E2E_PASSWORD ?? 'alice-demo-pass'
const SHOTS = 'results/screenshots'

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

test('the header says which version this is, and it opens What\'s new', async ({ page }) => {
	const problems = watch(page)
	await login(page)
	await page.goto('/apps/dashboard/')
	const badge = page.locator('.shell-version')
	await expect(badge).toBeVisible()
	// Looks like a version: "v4", "v4.1", ...
	const shown = (await badge.textContent())?.trim() ?? ''
	expect(shown).toMatch(/^v\d+(\.\d+)*$/)
	await badge.click()
	await page.waitForURL((u) => u.pathname === '/settings/user/whatsnew', { timeout: 30_000 })
	await expect(page.getByRole('heading', { name: "What's new" })).toBeVisible()
	// The version in the badge is the one marked as current on the page.
	await expect(page.locator('.whatsnew__item--current .whatsnew__head h3')).toContainText(shown)
	await page.screenshot({ path: `${SHOTS}/whatsnew-page.png` })
	expect(problems).toEqual([])
})
