// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today card (daily digest, P5-1) against a fake server: shows the digest with
// links into the apps, refreshes, names a source that failed, saves settings.
import '../../../core/web/testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { fakeServer, type FakeServer } from '../../../core/web/testing/fakeServer'
import { cleanup, click, getButton, getByText, queryByText, render, waitFor } from '../../../core/web/testing/render'
import { type Digest, TodayCard } from './Today'

let server: FakeServer
const digest = (over: Partial<Digest> = {}): Digest => ({
	day: '2026-11-13', timezone: 'UTC', headline: '1 mail needs a reply · 1 event, the first at 09:30', ai_summary: null,
	mail: [{ message_key: 'k1', subject: 'Contract to sign', from: 'Ann', date: '2026-11-13T06:00:00Z', urgency: 'today', deadline: true, reason: 'reply', link: '/apps/mail/box/1/thread/7' }],
	events: [{ event_id: 'c/1', title: 'Standup', start: '2026-11-13T09:30:00Z', end: null, all_day: false, location: 'Room 2' }],
	tasks: [{ task_id: 't/1', title: 'Pay rent', due: '2026-11-12', overdue: true }],
	todo: [{ item_id: 1, title: 'Groceries', kind: 'item' }],
	counts: { reply: 1, action: 0, events: 1, tasks: 1, overdue: 1, todo: 1 },
	errors: {},
	...over,
})

beforeEach(() => { server = fakeServer() })
afterEach(() => { cleanup(); server.restore() })

test('shows the digest with links into the apps', async () => {
	server.on('GET', '/agent/v1/digest', () => digest())
	const { container } = await render(<TodayCard />)
	await waitFor(() => getByText(container, 'Contract to sign'))
	expect(getByText(container, '1 mail needs a reply · 1 event, the first at 09:30')).toBeTruthy()
	expect(getByText(container, 'Contract to sign').closest('a')!.getAttribute('href')).toBe('/apps/mail/box/1/thread/7')
	expect(getByText(container, 'Reply')).toBeTruthy()
	expect(getByText(container, 'today')).toBeTruthy()
	expect(getByText(container, '09:30')).toBeTruthy()
	expect(getByText(container, 'Standup').closest('a')!.getAttribute('href')).toBe('/apps/calendar/')
	expect(getByText(container, 'overdue')).toBeTruthy()
	expect(getByText(container, 'Groceries')).toBeTruthy()
	expect(queryByText(container, /Left out/)).toBeNull()
})

test('refresh asks for a new digest (with the AI summary) and a failed source is named', async () => {
	server.on('GET', '/agent/v1/digest', () => digest({ errors: { calendar: 'down' }, events: [] }))
	server.on('POST', '/agent/v1/digest/refresh', () => digest({ ai_summary: 'Sign the contract first; the rest can wait.' }))
	const { container } = await render(<TodayCard />)
	await waitFor(() => getByText(container, 'Left out: Calendar could not be read.'))
	await click(getButton(container, 'Refresh'))
	await waitFor(() => getByText(container, 'Sign the contract first; the rest can wait.'))
	expect(server.calls('POST', '/agent/v1/digest/refresh')).toHaveLength(1)
	expect(queryByText(container, /Left out/)).toBeNull()
})

test('nothing to do, and a load error', async () => {
	let fail = false
	server.on('GET', '/agent/v1/digest', () => fail
		? new Response(JSON.stringify({ error: { message: 'Not logged in' } }), { status: 401, headers: { 'content-type': 'application/json' } })
		: digest({ headline: 'Nothing needs you today.', mail: [], events: [], tasks: [], todo: [] }))
	const { container } = await render(<TodayCard />)
	await waitFor(() => getByText(container, 'Nothing needs you today.'))
	cleanup()
	fail = true
	const r = await render(<TodayCard />)
	await waitFor(() => getByText(r.container, 'Could not load today’s digest: Not logged in'))
})

test('settings: turn the morning digest on with notification', async () => {
	let saved: Record<string, unknown> = {}
	let s = { enabled: false, time: '07:30', notify: false, ai: false }
	server.on('GET', '/agent/v1/digest', () => digest())
	server.on('GET', '/agent/v1/digest/settings', () => s)
	server.on('PUT', '/agent/v1/digest/settings', (req) => { saved = req.body as Record<string, unknown>; s = { ...s, ...saved }; return s })
	const { container } = await render(<TodayCard />)
	await click(getButton(container, 'Digest settings'))
	const on = await waitFor(() => getByText(document.body, 'Prepare it every morning').querySelector('input')!)
	const notify = getByText(document.body, 'Send it as a notification (ntfy)').querySelector('input')!
	expect(notify.disabled).toBe(true)
	await click(on)
	await waitFor(() => (saved.enabled === true ? true : null))
	expect(server.calls('PUT', '/agent/v1/digest/settings')[0].headers.get('ocs-apirequest')).toBe('true')
	await waitFor(() => (!getByText(document.body, 'Send it as a notification (ntfy)').querySelector('input')!.disabled ? true : null))
	await click(getByText(document.body, 'Send it as a notification (ntfy)').querySelector('input')!)
	await waitFor(() => (saved.notify === true ? true : null))
})
