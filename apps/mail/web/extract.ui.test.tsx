// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mail -> calendar and tasks (P5-7): proposals shown, each created only on its click.
import '../../../core/web/testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { fakeServer, type FakeServer } from '../../../core/web/testing/fakeServer'
import { cleanup, click, getButton, getByText, queryByText, render, waitFor } from '../../../core/web/testing/render'
import { ExtractDialog } from './Extract'

let server: FakeServer
beforeEach(() => {
	server = fakeServer()
		.on('POST', '/agent/v1/extract', () => ({
			events: [{ title: 'Dentiste', start: '2026-11-20T13:00:00.000Z', end: '2026-11-20T14:00:00.000Z', all_day: false, location: 'Lyon' }],
			tasks: [{ title: 'Payer la facture', due: '2026-11-30' }],
			source: { message_key: 'k', subject: 'RDV' },
		}))
})
afterEach(() => { cleanup(); server.restore() })

test('proposals are listed; only the clicked one is created', async () => {
	server.on('POST', '/agent/v1/extract/create', () => ({ kind: 'event', event_id: 'c/1' }))
	await render(<ExtractDialog dbId={11} open onClose={() => {}} />)
	await waitFor(() => getByText(document.body, 'Dentiste'))
	expect(server.calls('POST', '/agent/v1/extract')[0].body).toEqual({ db_id: 11 })
	expect(getByText(document.body, 'Payer la facture')).toBeTruthy()
	expect(document.body.textContent).toContain('Lyon')
	expect(server.calls('POST', '/agent/v1/extract/create')).toHaveLength(0)
	await click(getButton(document.body, 'Add to calendar'))
	await waitFor(() => getByText(document.body, 'Added'))
	const c = server.calls('POST', '/agent/v1/extract/create')
	expect(c).toHaveLength(1)
	expect(c[0].body).toMatchObject({ kind: 'event', db_id: 11, item: { title: 'Dentiste', location: 'Lyon' } })
	expect(c[0].headers.get('ocs-apirequest')).toBe('true')
	expect(getButton(document.body, 'Add task')).toBeTruthy()
})

test('a failed creation says why', async () => {
	server.on('POST', '/agent/v1/extract/create', () => new Response(JSON.stringify({ error: { message: 'No writable calendar' } }), { status: 409, headers: { 'content-type': 'application/json' } }))
	await render(<ExtractDialog dbId={11} open onClose={() => {}} />)
	await click(await waitFor(() => getButton(document.body, 'Add task')))
	await waitFor(() => getByText(document.body, 'No writable calendar'))
	expect(queryByText(document.body, 'Added')).toBeNull()
})
