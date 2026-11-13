// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P1-7: log in as the demo user, open Mail, Calendar and Files, and check that
// each page shows real content (the demo data from deploy/dev/seed.php), with no
// JavaScript error and no failed request.
import { expect, test, type Page } from '@playwright/test'

const USER = process.env.ATRIUM_E2E_USER ?? 'alice'
const PASSWORD = process.env.ATRIUM_E2E_PASSWORD ?? 'alice-demo-pass'

/** Collects page errors and 5xx / failed requests while a test runs. */
function watch(page: Page) {
	const problems: string[] = []
	page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
	page.on('response', (r) => { if (r.status() >= 500) problems.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`) })
	page.on('requestfailed', (r) => {
		const err = r.failure()?.errorText ?? ''
		// Requests cut by a navigation are not failures.
		if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(err)) problems.push(`failed: ${r.method()} ${new URL(r.url()).pathname} ${err}`)
	})
	return problems
}

async function login(page: Page) {
	await page.goto('/login')
	await page.getByLabel('Account name or email').fill(USER)
	await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
	await page.getByRole('button', { name: 'Log in' }).click()
	await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 })
}

/** The page has real text, not just the shell around an empty or broken app. */
async function expectNotEmpty(page: Page, selector: string) {
	const text = (await page.locator(selector).first().innerText()).replace(/\s+/g, ' ').trim()
	expect(text.length, `${selector} should not be empty`).toBeGreaterThan(20)
	expect(text).not.toMatch(/Could not (load|reach)|Internal server error|Bad gateway/i)
}

test.describe.configure({ mode: 'serial' })

test('wrong password stays on the login page', async ({ page }) => {
	const problems = watch(page)
	await page.goto('/login')
	await page.getByLabel('Account name or email').fill(USER)
	await page.getByLabel('Password', { exact: true }).fill('not-the-password')
	await page.getByRole('button', { name: 'Log in' }).click()
	await expect(page.getByRole('alert')).toContainText('Wrong login or password')
	expect(new URL(page.url()).pathname).toMatch(/^\/login/)
	expect(problems).toEqual([])
})

test('log in, then Mail, Calendar and Files show the demo data', async ({ page }) => {
	const problems = watch(page)
	await login(page)
	// The shell header links to the apps (names follow the user's language).
	const apps = page.getByRole('navigation', { name: 'Apps' })
	for (const app of ['mail', 'calendar', 'files']) await expect(apps.locator(`a[href^="/apps/${app}"]`)).toHaveCount(1)

	await test.step('Mail', async () => {
		await page.goto('/apps/mail/')
		await page.waitForURL(/\/apps\/mail\/view\/inbox/)
		const list = page.getByRole('region', { name: 'Messages', exact: true })
		// At least one demo mail, with its sender address shown.
		await expect(list.locator('.ml-message').first()).toBeVisible({ timeout: 45_000 })
		await expect(list).toContainText('@')
		await expectNotEmpty(page, '.ml-list')
		// Open the first one: the reader shows it.
		await list.locator('.ml-message__main').first().click()
		await page.waitForURL(/\/thread\/\d+/)
		await expect(page.getByRole('region', { name: 'Message', exact: true })).not.toContainText('Choose a message to read')
	})

	await test.step('Calendar', async () => {
		await page.goto('/apps/calendar/')
		await expect(page.locator('body')).toContainText(/Réunion projet|Dentiste|Dîner|Sport/, { timeout: 45_000 })
		await expectNotEmpty(page, 'main, .shell-app-body, body')
	})

	await test.step('Files', async () => {
		await page.goto('/apps/files/')
		await expect(page.locator('body')).toContainText('Bienvenue.md', { timeout: 45_000 })
		await expect(page.locator('body')).toContainText('Documents')
	})

	expect(problems).toEqual([])
})
