// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// V4-22: the other tests open the apps; this one uses them. Writing a note,
// ticking a task and putting a file somewhere is what a person does on the
// first day, and none of it was covered: a page can open perfectly and still
// lose what you just typed.
//
// Everything created here carries a timestamp in its name, so the test can run
// again on the same instance without colliding with itself.
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

test.describe.configure({ mode: 'serial' })

test('a note written now is still there after a reload', async ({ page }) => {
	const problems = watch(page)
	await login(page)
	const text = `Courses du ${Date.now()}`

	await page.goto('/apps/notes/')
	await page.getByRole('button', { name: 'New note' }).first().click()
	// The editor takes the focus itself; type into whatever has it.
	await page.waitForTimeout(1200)
	await page.keyboard.type(text)
	// Notes saves on its own; give it the moment it needs, then come back cold.
	await page.waitForTimeout(2500)
	await page.goto('/apps/notes/')
	// Exactly what was typed: this caught the editor dropping characters
	// ("SONDE" came back as "SNE") when each keystroke raced React's round-trip.
	await expect(page.getByText(text, { exact: true }).first(), 'the note is in the list, letter for letter').toBeVisible({ timeout: 30_000 })
	await page.screenshot({ path: `${SHOTS}/doing-notes.png` })
	expect(problems).toEqual([])
})

test('a task added now can be ticked, and stays ticked', async ({ page }) => {
	const problems = watch(page)
	await login(page)
	const title = `Arroser les plantes ${Date.now()}`
	const named = (name: string) => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

	await page.goto('/apps/tasks/')
	const field = page.getByRole('textbox', { name: 'New task' }).first()
	await expect(field).toBeVisible({ timeout: 30_000 })
	await field.fill(title)
	await field.press('Enter')

	const box = page.getByRole('checkbox', { name: named(title) })
	await expect(box, 'the new task is in the list').toBeVisible({ timeout: 30_000 })

	// Ticking takes it out of the open list -- click, do not use check(), which
	// wants to read the box back and finds it gone.
	await box.click()
	await expect(box, 'a ticked task leaves the open list').toHaveCount(0, { timeout: 30_000 })

	// And it is really done, not lost: it is under Completed, still after a reload.
	await page.goto('/apps/tasks/completed')
	await expect(page.getByText(title).first(), 'it is under Completed').toBeVisible({ timeout: 30_000 })
	await page.reload()
	await expect(page.getByText(title).first(), 'still under Completed after a reload').toBeVisible({ timeout: 30_000 })
	await page.screenshot({ path: `${SHOTS}/doing-tasks.png` })
	expect(problems).toEqual([])
})

test('a file put in Files is listed, and still there after a reload', async ({ page }) => {
	const problems = watch(page)
	await login(page)
	const name = `note-${Date.now()}.txt`

	await page.goto('/apps/files/')
	await expect(page.getByRole('button', { name: 'New' }).first()).toBeVisible({ timeout: 30_000 })
	await page.locator('input[type="file"]').first().setInputFiles({
		name,
		mimeType: 'text/plain',
		buffer: Buffer.from('écrit par le test e2e\n'),
	})
	await expect(page.getByText(name).first(), 'the file appears in the list').toBeVisible({ timeout: 60_000 })

	await page.goto('/apps/files/')
	await expect(page.getByText(name).first(), 'it is still there after a reload').toBeVisible({ timeout: 60_000 })
	await page.screenshot({ path: `${SHOTS}/doing-files.png` })
	expect(problems).toEqual([])
})
