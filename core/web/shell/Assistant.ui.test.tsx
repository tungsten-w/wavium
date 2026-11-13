// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The assistant panel (P5-6) against a fake server: a streamed answer with a
// tool line, an approval approved from the panel, the history sent back, the
// "no provider" message with its link, new chat.
import '../testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { fakeServer, type FakeServer } from '../testing/fakeServer'
import { cleanup, click, getButton, getByText, getField, queryByText, render, type, waitFor } from '../testing/render'
import { Assistant } from './Assistant'

let server: FakeServer
beforeEach(() => { server = fakeServer() })
afterEach(() => { cleanup(); server.restore() })

const stream = (events: unknown[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })

async function ask(container: HTMLElement, text: string) {
	await type(getField(container, 'Message'), text)
	await click(getButton(container, 'Send'))
}

test('streams an answer with tool lines; an approval is decided in the panel; history goes back', async () => {
	let n = 0
	server.on('POST', '/agent/v1/assistant/chat', () => (++n === 1
		? stream([
			{ type: 'tool', id: 'c1', name: 'notes_note_list', input: {} },
			{ type: 'tool_result', id: 'c1', name: 'notes_note_list', ok: true, preview: '' },
			{ type: 'tool', id: 'c2', name: 'files_delete', input: {} },
			{ type: 'approval', id: 'c2', name: 'files_delete', request_id: 'apr_9', summary: 'Delete /old.txt' },
			{ type: 'tool_result', id: 'c2', name: 'files_delete', ok: true, preview: '' },
			{ type: 'text', text: 'It waits for your OK.' },
			{ type: 'done', steps: 2 },
		])
		: stream([{ type: 'text', text: 'Done.' }, { type: 'done', steps: 1 }])))
	server.on('POST', '/agent/v1/owner/approvals/apr_9/approve', () => ({ request_id: 'apr_9', status: 'executed' }))
	const { container } = await render(<Assistant onClose={() => {}} />)
	await ask(container, 'Delete /old.txt')
	await waitFor(() => getByText(container, 'It waits for your OK.'))
	expect(getByText(container, '✓ notes note list')).toBeTruthy()
	const req = server.calls('POST', '/agent/v1/assistant/chat')[0]
	expect(req.headers.get('ocs-apirequest')).toBe('true')
	expect(req.body).toEqual({ messages: [{ role: 'user', content: 'Delete /old.txt' }] })

	const card = container.querySelector('[data-request="apr_9"]')!
	expect(getByText(card, 'Delete /old.txt')).toBeTruthy()
	await click(getButton(card, 'Approve'))
	await waitFor(() => getByText(card, 'Approved and done'))
	expect(server.calls('POST', '/agent/v1/owner/approvals/apr_9/approve')).toHaveLength(1)

	await ask(container, 'Thanks')
	await waitFor(() => getByText(container, 'Done.'))
	expect(server.calls('POST', '/agent/v1/assistant/chat')[1].body).toEqual({ messages: [
		{ role: 'user', content: 'Delete /old.txt' }, { role: 'assistant', content: 'It waits for your OK.' }, { role: 'user', content: 'Thanks' },
	] })
	await click(getButton(container, 'New chat'))
	expect(queryByText(container, 'Done.')).toBeNull()
})

test('no AI provider: the server message and a link to the settings', async () => {
	server.on('POST', '/agent/v1/assistant/chat', () => Response.json({ error: { code: 'conflict', message: 'No AI provider for the assistant yet. Add one in Settings > AI providers.' } }, { status: 409 }))
	const { container } = await render(<Assistant onClose={() => {}} />)
	await ask(container, 'Hello')
	await waitFor(() => getByText(container, /No AI provider/))
	expect(container.querySelector('a[href="/settings/user/ai"]')).toBeTruthy()
})

test('a streamed error shows; rejecting an approval', async () => {
	server.on('POST', '/agent/v1/assistant/chat', () => stream([
		{ type: 'approval', id: 'c1', name: 'mail_send', request_id: 'apr_2', summary: 'Send "Hi" to bob' },
		{ type: 'error', code: 'budget', message: 'Your AI budget for now is used up.' },
	]))
	server.on('POST', '/agent/v1/owner/approvals/apr_2/reject', () => ({ request_id: 'apr_2', status: 'rejected' }))
	const { container } = await render(<Assistant onClose={() => {}} />)
	await ask(container, 'Mail bob')
	await waitFor(() => getByText(container, 'Your AI budget for now is used up.'))
	await click(getButton(container.querySelector('[data-request="apr_2"]')!, 'Reject'))
	await waitFor(() => getByText(container, 'Rejected'))
})
