// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Messages UI (V4-4) against a fake /agent/v1/messages: link with a QR code,
// conversation list, a thread, sending, one-time code tag, offline banner.
import '../../../core/web/testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { fakeServer, type FakeServer } from '../../../core/web/testing/fakeServer'
import { cleanup, click, getButton, getByText, queryByText, renderApp, type, waitFor } from '../../../core/web/testing/render'
import App from './index'

let server: FakeServer
let status: Record<string, unknown>
const now = Date.now()
const conv = { id: 'c1', name: 'Léa Martin', contact: 'Léa Martin', is_group: false, kind: 'rcs', unread: true, last_at: now - 60_000, read_only: false, participants: [{ id: 'me', name: '', number: '', is_me: true }, { id: 'p', name: 'Léa', number: '+33600000001', is_me: false }], last_text: 'On se voit demain ?', last_from_me: false }
const bank = { ...conv, id: 'c2', name: 'BANK', contact: null, unread: false, read_only: true, kind: 'sms', last_text: 'code', participants: [conv.participants[0], { id: 'b', name: 'BANK', number: '38015', is_me: false }] }
const msgs = [
	{ id: 'm1', conversation_id: 'c1', at: now - 120_000, from_me: true, sender_name: '', sender_number: '', text: 'Salut !', status: 'read', media: [], one_time_code: false },
	{ id: 'm2', conversation_id: 'c1', at: now - 60_000, from_me: false, sender_name: 'Léa', sender_number: '+33600000001', text: 'On se voit demain ? https://cafe.example/menu', status: 'received', media: [], one_time_code: false },
]

beforeEach(() => {
	status = { state: 'connected', available: true, demo: false, phone: 'Pixel', linked_at: null, offline_since: null, error: null, qr: null, emoji: null, counts: { conversations: 2, messages: 3 } }
	server = fakeServer()
		.on('GET', '/agent/v1/messages/status', () => Response.json(status))
		.on('GET', '/agent/v1/messages/conversations', () => Response.json({ conversations: [conv, bank] }))
		.on('GET', '/agent/v1/messages/conversations/c1/messages', () => Response.json({ conversation: conv, messages: msgs }))
		.on('GET', '/agent/v1/messages/conversations/c2/messages', () => Response.json({ conversation: bank, messages: [{ ...msgs[1], id: 'm9', conversation_id: 'c2', text: 'Votre code est 482913', one_time_code: true }] }))
		.on('POST', /^\/agent\/v1\/messages\/conversations\/c\d\/read$/, () => Response.json({ read: true }))
		.on('POST', '/agent/v1/messages/send', () => Response.json({ message_id: 'tmp:1', status: 'sending' }))
		.on('POST', '/agent/v1/messages/link/qr', () => { status = { ...status, state: 'pairing', qr: 'https://support.google.com/messages/?p=web_computer#?c=X' }; return Response.json({ qr: status.qr }) })
		.on('GET', /^\/agent\/v1\/messages\/search/, () => Response.json({ results: [] }))
		.on('GET', '/index.php/csrftoken', () => Response.json({ token: 't' }))
		.on('GET', '/csrftoken', () => Response.json({ token: 't' }))
})
afterEach(() => { cleanup(); server.restore() })

test('lists conversations, unread first-class, and opens one', async () => {
	const { container, titles } = await renderApp('messages', App.Component!, '/')
	await waitFor(() => getByText(container, 'Léa Martin'))
	expect(container.querySelector('.ms-conv--unread')?.textContent).toContain('On se voit demain ?')
	expect(titles).toContain('(1) Messages')
	await click(container.querySelector('a.ms-conv')!)
	await waitFor(() => getByText(container, 'Salut !'))
	expect(location.pathname).toBe('/apps/messages/c1')
	// Links are links, text stays text.
	const a = container.querySelector('.ms-bubble__text a') as HTMLAnchorElement
	expect(a.href).toBe('https://cafe.example/menu')
	expect(a.rel).toContain('noopener')
	expect(server.calls('POST', '/agent/v1/messages/conversations/c1/read').length).toBe(1)
})

test('sends with Enter and sends the OCS header', async () => {
	const { container } = await renderApp('messages', App.Component!, '/c1')
	await waitFor(() => getByText(container, 'Salut !'))
	const box = container.querySelector('textarea.ms-compose__box') as HTMLTextAreaElement
	await type(box, 'Oui, 9h')
	box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
	await waitFor(() => server.calls('POST', '/agent/v1/messages/send')[0])
	const call = server.calls('POST', '/agent/v1/messages/send')[0]
	expect(typeof call.body === 'string' ? JSON.parse(call.body) : call.body).toEqual({ conversation_id: 'c1', text: 'Oui, 9h' })
	expect(call.headers.get('ocs-apirequest')).toBe('true')
})

test('short-code senders take no answer; codes are tagged', async () => {
	const { container } = await renderApp('messages', App.Component!, '/c2')
	await waitFor(() => getByText(container, 'Votre code est 482913'))
	expect(getByText(container, 'This sender does not take answers.')).toBeTruthy()
	expect(container.querySelector('.ms-code-tag')).not.toBeNull()
	expect(container.querySelector('textarea.ms-compose__box')).toBeNull()
})

test('unlinked: link with a QR code drawn in the page', async () => {
	status = { ...status, state: 'unpaired', phone: null }
	const { container } = await renderApp('messages', App.Component!, '/')
	await waitFor(() => getByText(container, 'Link my phone', ))
	await click(getButton(container, 'Show the QR code'))
	await waitFor(() => container.querySelector('.ms-qr svg path'))
	expect(container.querySelector('.ms-qr svg path')!.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/)
	expect(queryByText(container, 'Léa Martin')).toBeNull()
})

test('phone offline: a banner says since when', async () => {
	status = { ...status, state: 'phone_offline', offline_since: new Date(now - 3_600_000).toISOString() }
	const { container } = await renderApp('messages', App.Component!, '/')
	await waitFor(() => getByText(container, /Phone offline since/))
})

test('not set up on the server: says so instead of a broken page', async () => {
	status = { ...status, state: 'unpaired', available: false }
	const { container } = await renderApp('messages', App.Component!, '/')
	await waitFor(() => getByText(container, 'Messages is not set up on this server'))
})
