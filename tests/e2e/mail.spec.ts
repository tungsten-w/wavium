// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// V4-23: Mail, from connecting an account to sending a message.
//
// The first test is the bug this task came from: a mail account connected a
// minute ago showed "This folder is empty" under the default Curated filter,
// while "All" showed every mail. Chloé (the seeded newcomer) has mail waiting on
// the server and no account in Wavium, so she is that minute.
//
// The rest walks the app the way a person does: open a mail, star it, mark it
// unread, send one to yourself, archive it, search for it. Each test gets its
// own page: a single long-lived tab ran the renderer out of memory.
import { expect, test, type Page } from '@playwright/test'

const SHOTS = 'results/screenshots'
const MAIL_PASSWORD = 'demo-mail'

function watch(page: Page) {
	const problems: string[] = []
	page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
	page.on('response', (r) => { if (r.status() >= 500) problems.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`) })
	return problems
}

async function login(page: Page, user: string, password: string) {
	await page.goto('/login')
	await page.getByLabel('Account name or email').fill(user)
	await page.getByLabel('Password', { exact: true }).fill(password)
	await page.getByRole('button', { name: 'Log in' }).click()
	await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 })
}

/** The open list, once it has either messages or an empty state (never mid-spinner). */
async function list(page: Page) {
	const section = page.locator('section.ml-list')
	await expect(section.locator('.ml-messages, .at-empty')).toHaveCount(1, { timeout: 90_000 })
	return section
}

test.describe.configure({ mode: 'serial' })

test('mail is there the minute the account is connected, under Curated', async ({ page }) => {
	const problems = watch(page)
	await login(page, 'chloe', 'chloe-demo-pass')
	await page.goto('/apps/mail/')

	// No account yet: Mail opens on its setup form.
	await expect(page.getByRole('heading', { name: 'Connect your mail' })).toBeVisible({ timeout: 60_000 })
	await page.getByLabel('Account name').fill('Perso')
	await page.getByLabel('Email address').fill('chloe@atrium.test')
	// atrium.test is nobody's provider, so the server fields are already open.
	await page.getByLabel('Server').first().fill('greenmail')
	await page.getByLabel('Port').first().fill('3143')
	await page.getByLabel('Encryption').first().selectOption('none')
	await page.getByLabel('Username').first().fill('chloe@atrium.test')
	await page.getByLabel('Password').first().fill(MAIL_PASSWORD)
	await page.getByLabel('Server').nth(1).fill('greenmail')
	await page.getByLabel('Port').nth(1).fill('3025')
	await page.getByLabel('Encryption').nth(1).selectOption('none')
	await page.getByLabel('Username').nth(1).fill('chloe@atrium.test')
	await page.getByLabel('Password').nth(1).fill(MAIL_PASSWORD)
	await page.getByRole('button', { name: 'Connect account' }).click()

	// This is the whole point: the mail shows up on its own, with the default
	// filter on, without anyone having to click "All" or wait for the cron.
	const open = await list(page)
	await expect(open.locator('.ml-chip--on'), 'the default filter is still Curated').toHaveText('Curated')
	await expect(page.getByText('On se voit dimanche ?'), 'her mail is listed, not "This folder is empty"').toBeVisible({ timeout: 90_000 })
	await expect(page.getByText('Votre inscription est confirmée')).toBeVisible()
	await expect(open.getByText('This folder is empty')).toHaveCount(0)
	await page.screenshot({ path: `${SHOTS}/mail-fresh-account.png` })
	expect(problems).toEqual([])
})

test('the unified Inbox and the account folder hold the same mail', async ({ page }) => {
	const problems = watch(page)
	await login(page, 'alice', 'alice-demo-pass')

	await page.goto('/apps/mail/view/inbox')
	const unified = await list(page)
	await expect(page.getByText('Dîner samedi ?')).toBeVisible({ timeout: 90_000 })
	const subjects = await unified.locator('.ml-messages > li').allInnerTexts()

	await page.getByRole('link', { name: 'Inbox', exact: true }).last().click()
	await page.waitForURL(/\/apps\/mail\/box\/\d+/)
	const own = await list(page)
	await expect(own.locator('.ml-messages > li').first()).toBeVisible({ timeout: 90_000 })
	const ownSubjects = await own.locator('.ml-messages > li').allInnerTexts()
	// One account, so the merged view and its folder are the same list.
	expect(ownSubjects.slice(0, 3)).toEqual(subjects.slice(0, 3))
	expect(problems).toEqual([])
})

test('opening a mail shows its text and marks it read', async ({ page }) => {
	const problems = watch(page)
	await login(page, 'alice', 'alice-demo-pass')
	await page.goto('/apps/mail/view/inbox')
	await list(page)

	const row = page.locator('.ml-messages > li', { hasText: 'Réunion projet jeudi 14h' }).first()
	await expect(row).toBeVisible({ timeout: 90_000 })
	await row.locator('button').first().click()
	const reader = page.locator('section.ml-reader')
	await expect(reader.getByText('Réunion projet jeudi 14h')).toBeVisible({ timeout: 60_000 })
	// The body is in its own sandboxed frame.
	await expect(reader.locator('iframe.ml-body').contentFrame().getByText(/réunion de lancement jeudi/)).toBeVisible({ timeout: 60_000 })
	// Reading it marks it read, so the action flips to "Mark as unread".
	await expect(reader.getByRole('button', { name: 'Mark as unread' })).toBeVisible({ timeout: 60_000 })
	await expect(row).not.toHaveClass(/ml-message--unread/, { timeout: 60_000 })

	await reader.getByRole('button', { name: 'Mark as unread' }).click()
	await expect(reader.getByRole('button', { name: 'Mark as read' })).toBeVisible({ timeout: 60_000 })
	await page.screenshot({ path: `${SHOTS}/mail-reading.png` })
	expect(problems).toEqual([])
})

test('starring a mail puts it in Favorites, and the star survives a reload', async ({ page }) => {
	const problems = watch(page)
	await login(page, 'alice', 'alice-demo-pass')
	await page.goto('/apps/mail/view/inbox')
	await list(page)

	const row = page.locator('.ml-messages > li', { hasText: 'Photos des vacances' }).first()
	await expect(row).toBeVisible({ timeout: 90_000 })
	await row.getByRole('button', { name: 'Star message' }).click()
	await expect(row.getByRole('button', { name: 'Unstar message' })).toBeVisible({ timeout: 60_000 })

	await page.goto('/apps/mail/view/starred')
	await list(page)
	await expect(page.getByText('Photos des vacances'), 'starred on the IMAP server, not only in the page').toBeVisible({ timeout: 90_000 })

	// Put it back, so running this again starts from the same place.
	await page.locator('.ml-messages > li', { hasText: 'Photos des vacances' }).first().getByRole('button', { name: 'Unstar message' }).click()
	expect(problems).toEqual([])
})

test('every folder opens and lists what is in it', async ({ page }) => {
	const problems = watch(page)
	await login(page, 'alice', 'alice-demo-pass')
	await page.goto('/apps/mail/view/inbox')
	await list(page)

	for (const folder of ['Sent', 'Drafts', 'Archive', 'Spam', 'Trash']) {
		await page.getByRole('link', { name: folder, exact: true }).last().click()
		await page.waitForURL(/\/apps\/mail\/box\/\d+/)
		const open = await list(page)
		// Empty or not, the folder answers: a spinner that never ends or a 500 is the failure.
		await expect(open.locator('.ml-messages, .at-empty').first()).toBeVisible({ timeout: 90_000 })
		await expect(open.getByRole('heading', { level: 1 })).toHaveText(folder)
	}
	expect(problems).toEqual([])
})

test('a mail sent to yourself lands in Sent and comes back in the Inbox', async ({ page }) => {
	const problems = watch(page)
	await login(page, 'alice', 'alice-demo-pass')
	const subject = `Test e2e ${Date.now()}`

	await page.goto('/apps/mail/view/inbox')
	await list(page)
	await page.getByRole('button', { name: 'New message' }).first().click()
	const composer = page.locator('.ml-composer, [role=dialog]').first()
	await composer.getByLabel('To').fill('alice@atrium.test')
	await composer.getByLabel('Subject').fill(subject)
	await composer.getByLabel('Message').fill('Envoyé par le test e2e.')
	await composer.getByRole('button', { name: 'Send' }).click()
	await expect(composer).toHaveCount(0, { timeout: 60_000 })

	// Sent folder: the copy the mail server kept.
	await page.getByRole('link', { name: 'Sent', exact: true }).last().click()
	await list(page)
	await expect(page.getByText(subject), 'in Sent').toBeVisible({ timeout: 120_000 })

	// And back in the Inbox: refresh asks the mail server again.
	await page.getByRole('link', { name: 'Inbox', exact: true }).last().click()
	await list(page)
	for (let i = 0; i < 6; i++) {
		if (await page.getByText(subject).count()) break
		await page.getByRole('button', { name: 'Sync mailbox' }).click()
		await page.waitForTimeout(3000)
	}
	await expect(page.getByText(subject), 'delivered to the Inbox').toBeVisible({ timeout: 60_000 })
	await page.screenshot({ path: `${SHOTS}/mail-sent.png` })
	expect(problems).toEqual([])
})

test('search finds a mail, and archiving one moves it on the server', async ({ page }) => {
	const problems = watch(page)
	await login(page, 'alice', 'alice-demo-pass')
	await page.goto('/apps/mail/view/inbox')
	await list(page)

	await page.getByPlaceholder('Search mail').fill('facture')
	await page.getByRole('button', { name: 'Search' }).click()
	await list(page)
	await expect(page.getByText(/facture de novembre/i)).toBeVisible({ timeout: 90_000 })

	// Archive from the list, then look in Archive: the move happened on IMAP.
	await page.getByRole('button', { name: 'Clear search' }).click()
	await list(page)
	const row = page.locator('.ml-messages > li', { hasText: '#48213' }).first()
	await expect(row).toBeVisible({ timeout: 90_000 })
	await row.getByRole('button', { name: 'Archive message' }).click()
	await expect(page.locator('.ml-messages > li', { hasText: '#48213' })).toHaveCount(0, { timeout: 60_000 })

	await page.goto('/apps/mail/view/archive')
	await list(page)
	await expect(page.getByText(/#48213/), 'the archived mail is in Archive').toBeVisible({ timeout: 90_000 })
	expect(problems).toEqual([])
})
