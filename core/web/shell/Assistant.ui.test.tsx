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

const AGENT = { uid: 'claude-mail', name: 'Claude Mail', paused: false, waiting: 0, lastAt: 0 }

test('with no agent to talk to, the panel is exactly the assistant it was', async () => {
	server.on('GET', '/agent/v1/chat', () => ({ agents: [] }))
	const { container } = await render(<Assistant onClose={() => {}} />)
	await waitFor(() => getByText(container, 'Assistant'))
	expect(container.querySelector('.assistant__who')).toBeNull()
	expect(getField(container, 'Message')).toBeTruthy()
})

test('an agent can be picked, and its thread is read from the server', async () => {
	server.on('GET', '/agent/v1/chat', () => ({ agents: [{ ...AGENT, waiting: 1 }] }))
	server.on('GET', '/agent/v1/chat/claude-mail', () => ({
		agent: { uid: 'claude-mail', name: 'Claude Mail', paused: false },
		messages: [
			{ id: 1, from: 'you', text: 'Tague les factures', at: 1795600000, taken: true },
			{ id: 2, from: 'agent', text: '14 factures taguees', at: 1795600100, taken: false },
		],
	}))
	const { container } = await render(<Assistant onClose={() => {}} />)
	const who = await waitFor(() => getField(container, 'Talking to') as HTMLSelectElement)
	// The waiting count is in the choice, so you can see it without opening it.
	expect(who.textContent).toContain('Claude Mail (1 waiting)')
	await type(who, 'claude-mail')
	await waitFor(() => getByText(container, '14 factures taguees'))
	expect(getByText(container, 'Tague les factures')).toBeTruthy()
	// Nothing was asked of the AI provider: this agent has its own.
	expect(server.calls('POST', '/agent/v1/assistant/chat')).toEqual([])
})

test('a message to an agent is sent, kept on screen, and says it is not picked up yet', async () => {
	server.on('GET', '/agent/v1/chat', () => ({ agents: [AGENT] }))
	server.on('GET', '/agent/v1/chat/claude-mail', () => ({ agent: { uid: 'claude-mail', name: 'Claude Mail', paused: false }, messages: [] }))
	server.on('POST', '/agent/v1/chat/claude-mail', (req) => ({
		message: { id: 1, from: 'you', text: String((req.body as { text: string }).text), at: 1795600000, taken: false },
	}))
	const { container } = await render(<Assistant onClose={() => {}} startWith="claude-mail" />)
	await waitFor(() => getField(container, 'Message to Claude Mail'))
	await type(getField(container, 'Message to Claude Mail'), 'Verifie les mails de la fac')
	await click(getButton(container, 'Send'))
	await waitFor(() => getByText(container, 'Verifie les mails de la fac'))
	expect(server.calls('POST', '/agent/v1/chat/claude-mail')[0].body).toEqual({ text: 'Verifie les mails de la fac' })
	expect(getByText(container, 'Waiting for Claude Mail to pick this up. It checks in regularly.')).toBeTruthy()
})

test('a paused agent is not pretended to be listening', async () => {
	server.on('GET', '/agent/v1/chat', () => ({ agents: [{ ...AGENT, paused: true }] }))
	server.on('GET', '/agent/v1/chat/claude-mail', () => ({
		agent: { uid: 'claude-mail', name: 'Claude Mail', paused: true },
		messages: [{ id: 1, from: 'you', text: 'tu dors ?', at: 1795600000, taken: false }],
	}))
	const { container } = await render(<Assistant onClose={() => {}} startWith="claude-mail" />)
	await waitFor(() => getByText(container, /is paused, so it will not read this/))
})

test('a thread that cannot be read says so instead of looking empty', async () => {
	server.on('GET', '/agent/v1/chat', () => ({ agents: [AGENT] }))
	server.on('GET', '/agent/v1/chat/claude-mail', () => new Response(JSON.stringify({ error: { message: 'No agent claude-mail to talk to' } }), { status: 404 }))
	const { container } = await render(<Assistant onClose={() => {}} startWith="claude-mail" />)
	await waitFor(() => container.querySelector('.assistant__error')!)
	expect(container.querySelector('.assistant__error')!.textContent).toContain('claude-mail')
})
