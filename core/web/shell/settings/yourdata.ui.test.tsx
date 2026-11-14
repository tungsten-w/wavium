// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import '../../testing/dom'
import { afterEach, expect, test } from 'vitest'
import { fakeServer, type FakeServer } from '../../testing/fakeServer'
import { cleanup, click, render, testSession, waitFor } from '../../testing/render'
import { CRITERIA, tally, TOOLS } from './safety'
import { size, YourData } from './YourData'

let server: FakeServer | null = null
afterEach(() => { cleanup(); server?.restore(); server = null })

const report = {
	uid: 'alice',
	items: [
		{ id: 'files', label: 'Files', what: 'Everything in Files.', where: 'disk', container: '/var/www/html/data/alice/files', host: { kind: 'path', path: '/home/me/wavium/data/alice/files' }, bytes: 3 * 1048576 },
		{ id: 'trash', label: 'Deleted files', what: 'Trash.', where: 'disk', container: '/var/www/html/data/alice/files_trashbin' },
		{ id: 'mail', label: 'Mail', what: 'Every mail.', where: 'database', tables: ['oc_mail_messages'] },
	],
	database: { type: 'PostgreSQL', name: 'wavium', host: { kind: 'volume', volume: 'wavium_db', path: '/var/lib/docker/volumes/wavium_db/_data' } },
	notes: ['Nothing leaves this machine unless you ask.'],
}

test('shows where each kind of data is, on the machine and in Wavium', async () => {
	server = fakeServer().on('GET', '/agent/v1/storage', () => report)
	const { container } = await render(<YourData session={testSession} />)
	await waitFor(() => container.querySelector('.data-card'))
	const text = container.textContent ?? ''
	expect(text).toContain('/home/me/wavium/data/alice/files')
	expect(text).toContain('/var/www/html/data/alice/files_trashbin')
	expect(text).toContain('3.0 MB')
	expect(text).toContain('PostgreSQL “wavium”')
	expect(text).toContain('docker volume inspect wavium_db')
	expect(text).toContain('oc_mail_messages')
})

test('says so when the storage places cannot be read', async () => {
	server = fakeServer().on('GET', '/agent/v1/storage', () => new Response('{"error":{"message":"Not logged in"}}', { status: 401 }))
	const { container } = await render(<YourData session={testSession} />)
	expect((await waitFor(() => container.querySelector('.settings-bad'))).textContent).toContain('Not logged in')
})

test('safety chart: every tool answers every question, notes open on tap', async () => {
	for (const c of CRITERIA) for (const t of TOOLS) expect(c.marks[t.id], `${c.id}/${t.id}`).toBeDefined()
	const w = tally('wavium')
	expect(w.yes + w.partly + w.no).toBe(CRITERIA.length)
	// Honest: Wavium is not shown as better everywhere.
	expect(w.no).toBeGreaterThan(0)
	server = fakeServer().on('GET', '/agent/v1/storage', () => report)
	const { container } = await render(<YourData session={testSession} />)
	const marks = container.querySelectorAll<HTMLButtonElement>('.safety__table button.safety__mark')
	expect(marks).toHaveLength(CRITERIA.length * TOOLS.length)
	expect(marks[0].getAttribute('aria-label')).toMatch(/^Wavium: Yes\. /)
	await click(marks[0])
	expect(container.querySelector('.safety__note--open')?.textContent).toBe(CRITERIA[0].marks.wavium[1])
})

test('sizes read like people write them', () => {
	expect(size(512)).toBe('512 bytes')
	expect(size(1536)).toBe('1.5 KB')
	expect(size(50 * 1048576, true)).toBe('at least 50 MB')
	expect(size(undefined)).toBe('')
})
