// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Agents, recent agent actions (P3-7) against a fake server: list
// with agent names, Undo only where possible, undo result shown in place, an
// undo error shown and the list reloaded, paging.
import '../../testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { fakeServer, type FakeServer } from '../../testing/fakeServer'
import { cleanup, click, getButton, getByText, queryByText, render, waitFor } from '../../testing/render'
import { AgentActions } from './AgentActions'
import type { AgentAction } from './agentsModel'

const act = (id: string, f: Partial<AgentAction> = {}): AgentAction => ({
	action_id: id, agent: 'agent-bot', area: 'contacts', tool: 'contacts_contact_delete', summary: `Delete contact: ${id}`, request_id: null,
	at: new Date().toISOString(), undo: 'Restore the contact', undone_at: null, undo_error: null, ...f,
})
const names = new Map([['agent-bot', 'Helper bot']])
let server: FakeServer

beforeEach(() => { server = fakeServer() })
afterEach(() => { cleanup(); server.restore() })

const row = (c: Element, id: string) => c.querySelector(`[data-action="${id}"]`)!

test('lists actions; Undo only where possible; undo updates the row', async () => {
	server.on('GET', '/agent/v1/owner/actions', () => ({ actions: [act('a1'), act('a2', { tool: 'files_mkdir', summary: 'files_mkdir: /P', undo: null }), act('a3', { undone_at: new Date().toISOString(), undo: null })], next_cursor: null }))
	server.on('POST', /^\/agent\/v1\/owner\/actions\/([^/]+)\/undo$/, (_req, [id]) => act(id, { undo: null, undone_at: new Date().toISOString() }))
	const { container } = await render(<AgentActions names={names} refresh={0} />)
	await waitFor(() => getByText(container, 'Delete contact: a1'))
	expect(getByText(row(container, 'a1'), 'Helper bot')).toBeTruthy()
	expect(row(container, 'a2').querySelector('button')).toBeNull()
	expect(getByText(row(container, 'a3'), /^Undone/)).toBeTruthy()
	expect(row(container, 'a3').querySelector('button')).toBeNull()

	await click(getButton(row(container, 'a1'), 'Undo'))
	await waitFor(() => getByText(row(container, 'a1'), /^Undone/))
	expect(server.calls('POST', '/agent/v1/owner/actions/a1/undo')).toHaveLength(1)
	expect(row(container, 'a1').querySelector('button')).toBeNull()
})

test('an undo error is shown after reloading; paging', async () => {
	let failed = false
	server.on('GET', '/agent/v1/owner/actions', (req) => req.query.get('cursor') === 'c1'
		? { actions: [act('old')], next_cursor: null }
		: { actions: [act('a1', failed ? { undo_error: 'Nothing to restore' } : {})], next_cursor: 'c1' })
	server.on('POST', '/agent/v1/owner/actions/a1/undo', () => {
		failed = true
		return Response.json({ error: { code: 'conflict', message: 'Could not undo: Nothing to restore' } }, { status: 409 })
	})
	const { container } = await render(<AgentActions names={names} refresh={0} />)
	await waitFor(() => getByText(container, 'Delete contact: a1'))
	await click(getButton(row(container, 'a1'), 'Undo'))
	await waitFor(() => getByText(container, 'Undo failed: Nothing to restore'))

	await click(getButton(container, 'Show more'))
	await waitFor(() => getByText(container, 'Delete contact: old'))
	expect(getByText(container, 'Delete contact: a1')).toBeTruthy()
	expect(queryByText(container, 'Show more')).toBeNull()
})

test('nothing logged: nothing shown', async () => {
	server.on('GET', '/agent/v1/owner/actions', () => ({ actions: [], next_cursor: null }))
	const { container } = await render(<AgentActions names={names} refresh={0} />)
	await new Promise((r) => setTimeout(r, 20))
	expect(server.calls('GET', '/agent/v1/owner/actions')).toHaveLength(1)
	expect(queryByText(container, 'Recent agent actions')).toBeNull()
})
