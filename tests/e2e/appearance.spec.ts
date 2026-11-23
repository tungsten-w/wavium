// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// V4-22: Settings > Appearance, in a real browser. Its own file: this is the
// regression test for a 500 a person actually hit, and it must not be skipped
// because another test failed first.
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

// The bug a first-time user hit on a real install: pick an accent colour, then a
// wallpaper, and the wallpaper request answered 500 (theming/userCacheBuster was
// stored as a string by Atrium's accent listener and rewritten as "mixed").
test('Appearance: an accent colour and then a wallpaper, with no failed request', async ({ page }) => {
	const problems = watch(page)
	const refused: string[] = []
	page.on('response', (r) => { if (r.status() >= 400 && new URL(r.url()).pathname.includes('/theming/')) refused.push(`${r.status()} ${new URL(r.url()).pathname}`) })

	await login(page)
	await page.goto('/settings/user/theming')
	await expect(page.getByRole('heading', { name: 'Accent colour' })).toBeVisible()

	// A colour: this is what pins the type of theming/userCacheBuster.
	await page.locator('.accent-grid .accent-tile:not(.accent-tile--custom)').nth(2).click()
	await page.waitForTimeout(600)

	// Then every kind of wallpaper: Wavium's own, a plain colour, a shipped image.
	for (const nth of [0, 1, 2]) {
		await page.locator('.wallpaper-grid .wallpaper-tile').nth(nth).click()
		await page.waitForTimeout(600)
	}
	// And back to the accent colour, which also rewrites the same key.
	await page.locator('.accent-grid .accent-tile:not(.accent-tile--custom)').first().click()
	await page.waitForTimeout(600)

	expect(refused).toEqual([])
	expect(problems).toEqual([])
	await page.screenshot({ path: `${SHOTS}/appearance.png` })
})
