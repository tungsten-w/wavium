// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P2-2: Settings > AI in a real browser against the dev stack. Uses only the
// mock provider (ATRIUM_AI_MOCK=1 in compose.yaml) and fake keys: no request
// leaves the machine.
import { expect, test, type Page } from '@playwright/test'

const USER = process.env.ATRIUM_E2E_USER ?? 'alice'
const PASSWORD = process.env.ATRIUM_E2E_PASSWORD ?? 'alice-demo-pass'
const FAKE_KEY = 'sk-e2e-not-a-real-key-000000QRST'

async function login(page: Page) {
	await page.goto('/login')
	await page.getByLabel('Account name or email').fill(USER)
	await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
	await page.getByRole('button', { name: 'Log in' }).click()
	await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 })
}

test('add a mock provider, test it, make it the default, delete it', async ({ page }) => {
	const problems: string[] = []
	page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
	page.on('response', (r) => { if (r.status() >= 500) problems.push(`${r.status()} ${new URL(r.url()).pathname}`) })

	await login(page)
	await page.goto('/settings/user/ai')
	await expect(page.getByRole('heading', { name: 'AI providers' })).toBeVisible()
	const own = page.locator('.settings-block', { has: page.getByRole('heading', { name: 'Your own providers' }) })
	await expect(own).toBeVisible()

	// A personal provider may not point inside the server's network.
	await own.getByRole('button', { name: 'Add a provider' }).click()
	const dlg = page.locator('.ai-form')
	await dlg.getByLabel('Provider').selectOption('openai-compatible')
	await dlg.getByLabel('Base URL').fill('http://127.0.0.1:9/v1')
	await page.getByRole('button', { name: 'Save' }).click()
	await expect(dlg.getByRole('alert')).toContainText('internal address')

	// The mock: test lists its model, save, and it shows with no key.
	await dlg.getByLabel('Provider').selectOption('mock')
	await dlg.getByLabel('Name').fill('E2E mock')
	await page.getByRole('button', { name: 'Test connection' }).click()
	await expect(dlg.getByRole('status')).toContainText('Connected: 1 model available.')
	await page.getByRole('button', { name: 'Save' }).click()
	const row = own.locator('tr', { hasText: 'E2E mock' })
	await expect(row).toContainText('No key')

	await page.getByLabel('Default provider', { exact: true }).last().selectOption({ label: 'E2E mock' })
	await expect(page.getByText('Now: E2E mock.')).toBeVisible()

	// An OpenAI-compatible provider on a public name with a key: saved, key never shown again.
	await own.getByRole('button', { name: 'Add a provider' }).click()
	await dlg.getByLabel('Provider').selectOption('openai-compatible')
	await dlg.getByLabel('Name').fill('E2E gateway')
	await dlg.getByLabel('Base URL').fill('https://llm.example.com/v1')
	await dlg.getByLabel('API key').fill(FAKE_KEY)
	await page.getByRole('button', { name: 'Save' }).click()
	const gw = own.locator('tr', { hasText: 'E2E gateway' })
	await expect(gw).toContainText('Key ••••QRST')
	const settings = await page.request.get('/agent/v1/ai/settings')
	expect(await settings.text()).not.toContain(FAKE_KEY)
	await page.reload()
	await expect(gw).toBeVisible()
	expect(await page.content()).not.toContain(FAKE_KEY)

	// Clean up (the dev instance is shared).
	for (const name of ['E2E gateway', 'E2E mock']) {
		await own.locator('tr', { hasText: name }).getByRole('button', { name: 'Delete' }).click()
		await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
		await expect(own.locator('tr', { hasText: name })).toHaveCount(0)
	}
	expect(problems).toEqual([])
})
