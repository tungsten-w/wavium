// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a non-admin is told about classification (V4-26), and which folders get
// classified at all plus catching up an older question set (V4-28). The switch spends the
// instance's AI budget, so it stays admin-only; before this, everyone else saw
// nothing on the Mail status page and could not tell whether their mail was
// being sorted, or why it was not.
import '../../../core/web/testing/dom'
import { afterEach, expect, test } from 'vitest'
import { Snackbars } from '@atrium/ui'
import { fakeServer } from '../../../core/web/testing/fakeServer'
import { cleanup, click, getButton, getByText, queryByText, render, waitFor } from '../../../core/web/testing/render'
import type { TriageStatus } from './api'
import { ClassificationLine, MailStatus } from './Status'

afterEach(() => { cleanup() })

const settings = (over: Partial<TriageStatus['settings']>): TriageStatus['settings'] => ({
	enabled: false, configured: true, capTotalEur: 1, capBackfillEur: 0.3,
	model: 'mock-small', questionsVersion: 'mail-v3', timezone: 'Europe/Paris', ...over,
})

test('says classification is on when it is', async () => {
	const { container } = await render(<ClassificationLine settings={settings({ enabled: true })} />)
	expect(getByText(container, 'Classification is on')).toBeTruthy()
})

test('no AI provider yet: says so, and where an admin adds one', async () => {
	const { container } = await render(<ClassificationLine settings={settings({ configured: false })} />)
	expect(getByText(container, /no AI provider yet/)).toBeTruthy()
	expect(getByText(container, /Settings > AI/)).toBeTruthy()
})

test('a provider exists but it is off: points at this page, not at Settings', async () => {
	const { container } = await render(<ClassificationLine settings={settings({})} />)
	expect(getByText(container, /turn it on from this page/)).toBeTruthy()
	expect(container.textContent).not.toContain('Settings > AI')
})

// --- V4-28: choosing the folders to classify, and catching up an old question set.

const folder = (over: Partial<TriageStatus['folders'][number]>): TriageStatus['folders'][number] => ({
	id: 1, accountId: 1, name: 'INBOX', specialUse: [], serverMessages: 3, serverUnread: 0, cached: true,
	syncing: false, stored: 3, kept: 0, previews: 3, queued: 3, classified: 3, bodies: 3, inTriage: true, ...over,
})

const fullStatus = (over: Partial<TriageStatus> = {}): TriageStatus => ({
	now: 1_800_000_000, canManage: true, settings: settings({ enabled: true }),
	state: { state: 'idle', pausedUntil: null, lastRun: 1_799_999_000, lastOk: 1_799_999_000, lastScan: 1_799_999_000, lastError: null, lastErrorAt: null },
	spent: { todayEur: 0.01, todayBackfillEur: 0, monthEur: 0.2 },
	queue: { pendingNew: 0, pendingBacklog: 0, done: 3, parked: 0 },
	accounts: [{ id: 1, email: 'alice@wavium.test', name: 'Alice', pendingNew: 0, pendingBacklog: 0, done: 3, parked: 0 }],
	categories: [], flows: [], urgency: [], daily: [], recent: [], problems: [], copy: [],
	folders: [folder({}), folder({ id: 2, name: 'Perso', inTriage: false, queued: 0, classified: 0, bodies: 0 })],
	jobs: [], ...over,
})

test('ticking a folder sends the account’s whole list, so unticking the inbox is a real choice', async () => {
	const server = fakeServer()
		.on('GET', '/apps/mail/api/triage/status', () => fullStatus())
		.on('GET', '/apps/mail/api/preferences/curated-hides', () => ({ value: '[]' }))
		.on('PUT', '/apps/mail/api/triage/folders', () => ({ accountId: 1, mailboxIds: [1, 2] }))
	try {
		const { container } = await render(<MailStatus />)
		const perso = await waitFor(() => container.querySelector<HTMLInputElement>('[aria-label="Classify Perso"]'))
		expect(perso.checked).toBe(false)
		expect(container.querySelector<HTMLInputElement>('[aria-label="Classify INBOX"]')!.checked).toBe(true)

		await click(perso)

		await waitFor(() => server.calls('PUT', '/apps/mail/api/triage/folders').length === 1)
		expect(server.calls('PUT', '/apps/mail/api/triage/folders')[0].body).toEqual({ accountId: 1, mailboxIds: [1, 2] })
	} finally { server.restore() }
})

test('unticking the inbox sends the rest of the account’s folders, not an empty list by accident', async () => {
	const server = fakeServer()
		.on('GET', '/apps/mail/api/triage/status', () => fullStatus({ folders: [folder({}), folder({ id: 2, name: 'Perso', inTriage: true })] }))
		.on('GET', '/apps/mail/api/preferences/curated-hides', () => ({ value: '[]' }))
		.on('PUT', '/apps/mail/api/triage/folders', () => ({ accountId: 1, mailboxIds: [2] }))
	try {
		const { container } = await render(<MailStatus />)
		const inbox = await waitFor(() => container.querySelector<HTMLInputElement>('[aria-label="Classify INBOX"]'))

		await click(inbox)

		await waitFor(() => server.calls('PUT', '/apps/mail/api/triage/folders').length === 1)
		expect(server.calls('PUT', '/apps/mail/api/triage/folders')[0].body).toEqual({ accountId: 1, mailboxIds: [2] })
	} finally { server.restore() }
})

test('an older question set: the count, the cost and one bounded catch-up', async () => {
	const server = fakeServer()
		.on('GET', '/apps/mail/api/triage/status', () => fullStatus({ outdated: { version: 'mail-v3', count: 320, perMailEur: 0.0002, estimateEur: 0.064 } }))
		.on('GET', '/apps/mail/api/preferences/curated-hides', () => ({ value: '[]' }))
		.on('POST', '/apps/mail/api/triage/backfill', () => ({ queued: 100, remaining: 220, max: 100, estimateEur: 0.02 }))
	try {
		const { container } = await render(<MailStatus />)
		const card = await waitFor(() => getByText(container, 'Catch up').closest('.at-card') as HTMLElement)
		expect(card.textContent).toContain('320 mails were sorted by an older set of questions')
		expect(card.textContent).toContain('€0.06')
		expect(card.textContent).toContain('corrected by hand is left alone')

		await click(getButton(card, 'Redo 100 now'))

		await waitFor(() => server.calls('POST', '/apps/mail/api/triage/backfill').length === 1)
		expect(server.calls('POST', '/apps/mail/api/triage/backfill')[0].body).toEqual({ max: 100 })
	} finally { server.restore() }
})

test('nothing to catch up: no card, no button to press by mistake', async () => {
	const server = fakeServer()
		.on('GET', '/apps/mail/api/triage/status', () => fullStatus({ outdated: { version: 'mail-v3', count: 0, perMailEur: 0.0002, estimateEur: 0 } }))
		.on('GET', '/apps/mail/api/preferences/curated-hides', () => ({ value: '[]' }))
	try {
		const { container } = await render(<MailStatus />)
		await waitFor(() => getByText(container, 'Folders'))
		expect(queryByText(container, 'Catch up')).toBeNull()
	} finally { server.restore() }
})

// --- V4-37: "Run now". The pipeline waits for the five-minute cron otherwise,
// so turning it on, adding a provider or fixing a folder looked like nothing
// happened at all.

// The shell mounts <Snackbars /> next to the app (core/web/shell/main.tsx); a
// test that reads a toast has to mount it too.
const shownToasts = () => [...document.querySelectorAll('.at-snackbar')].map((el) => el.textContent ?? '')

test('Run now classifies at once and says how many', async () => {
	const server = fakeServer()
		.on('GET', '/apps/mail/api/triage/status', () => fullStatus({ queue: { pendingNew: 7, pendingBacklog: 0, done: 3, parked: 0 } }))
		.on('GET', '/apps/mail/api/preferences/curated-hides', () => ({ value: '[]' }))
		.on('POST', '/apps/mail/api/triage/run', () => ({ ran: true, reason: null, queued: 2, classified: 4, state: 'idle', lastError: null }))
	try {
		const { container } = await render(<><MailStatus /><Snackbars /></>)
		await click(await waitFor(() => getButton(container, 'Run now')))

		await waitFor(() => server.calls('POST', '/apps/mail/api/triage/run').length === 1)
		const message = await waitFor(() => shownToasts().find((t) => t.includes('classified')))
		expect(message).toContain('4 mails classified')
		expect(message).toContain('2 newly queued')
		// The page reloads after a run, so the figures on screen are the new ones.
		expect(server.calls('GET', '/apps/mail/api/triage/status').length).toBeGreaterThan(1)
	} finally { server.restore() }
})

test('a run already going is said as such, not left looking like a dead button', async () => {
	const server = fakeServer()
		.on('GET', '/apps/mail/api/triage/status', () => fullStatus())
		.on('GET', '/apps/mail/api/preferences/curated-hides', () => ({ value: '[]' }))
		.on('POST', '/apps/mail/api/triage/run', () => ({ ran: false, reason: 'busy', queued: 0, classified: 0, state: 'running', lastError: null }))
	try {
		const { container } = await render(<><MailStatus /><Snackbars /></>)
		await click(await waitFor(() => getButton(container, 'Run now')))

		expect(await waitFor(() => shownToasts().find((t) => t.includes('already going')))).toBeTruthy()
	} finally { server.restore() }
})

test('nothing classified: the reason is shown, not an empty success', async () => {
	const server = fakeServer()
		.on('GET', '/apps/mail/api/triage/status', () => fullStatus())
		.on('GET', '/apps/mail/api/preferences/curated-hides', () => ({ value: '[]' }))
		.on('POST', '/apps/mail/api/triage/run', () => ({
			ran: true, reason: null, queued: 0, classified: 0, state: 'not_configured',
			lastError: 'No AI for mail triage: no AI provider is configured. Add one in Settings > AI.',
		}))
	try {
		const { container } = await render(<><MailStatus /><Snackbars /></>)
		await click(await waitFor(() => getButton(container, 'Run now')))

		const message = await waitFor(() => shownToasts().find((t) => t.includes('no AI provider is configured')))
		expect(message).toContain('Nothing classified')
	} finally { server.restore() }
})

test('the pipeline is off: the button is there but cannot be pressed', async () => {
	const server = fakeServer()
		.on('GET', '/apps/mail/api/triage/status', () => fullStatus({ settings: settings({ enabled: false }) }))
		.on('GET', '/apps/mail/api/preferences/curated-hides', () => ({ value: '[]' }))
	try {
		const { container } = await render(<MailStatus />)
		const button = await waitFor(() => getButton(container, 'Run now') as HTMLButtonElement)
		expect(button.disabled).toBe(true)

		await click(button)

		expect(server.calls('POST', '/apps/mail/api/triage/run')).toEqual([])
	} finally { server.restore() }
})

test('no AI provider at all: still nothing to press', async () => {
	const server = fakeServer()
		.on('GET', '/apps/mail/api/triage/status', () => fullStatus({ settings: settings({ enabled: true, configured: false }) }))
		.on('GET', '/apps/mail/api/preferences/curated-hides', () => ({ value: '[]' }))
	try {
		const { container } = await render(<MailStatus />)
		expect((await waitFor(() => getButton(container, 'Run now') as HTMLButtonElement)).disabled).toBe(true)
	} finally { server.restore() }
})

test('a reader without the right to spend the budget gets no button', async () => {
	const server = fakeServer()
		.on('GET', '/apps/mail/api/triage/status', () => fullStatus({ canManage: false }))
		.on('GET', '/apps/mail/api/preferences/curated-hides', () => ({ value: '[]' }))
	try {
		const { container } = await render(<MailStatus />)
		await waitFor(() => getByText(container, /Classification is on/))
		expect(queryByText(container, 'Run now')).toBeNull()
	} finally { server.restore() }
})
