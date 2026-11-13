// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Agent activity (P2-8) against a fake server: the timeline with
// agent names and states, Undo, the agent filter in the URL, a request opened
// from a line or from a deep link (?request=), approving a waiting request.
import '../../testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { navigate } from '@atrium/sdk'
import { fakeServer, type FakeServer } from '../../testing/fakeServer'
import { cleanup, click, getButton, getByText, getField, queryByText, render, testSession, type, waitFor } from '../../testing/render'
import { AgentActivity } from './AgentActivity'
import type { ActivityItem, Approval } from './agentsModel'

const now = new Date().toISOString()
const action = (id: string, f: Partial<Extract<ActivityItem, { kind: 'action' }>> = {}): ActivityItem => ({
	kind: 'action', action_id: id, agent: 'agent-a', area: 'contacts', tool: 'contacts_contact_create', summary: `New contact: ${id}`, request_id: null,
	at: now, undo: 'Delete the contact', undone_at: null, undo_error: null, ...f,
})
const request = (rid: string, status: Approval['status'], f: Partial<Extract<ActivityItem, { kind: 'request' }>> = {}): ActivityItem => ({
	kind: 'request', at: now, agent: 'agent-b', tool: 'files_delete', summary: `Delete ${rid}`, request_id: rid, status, decided_by: null, decided_at: null, error: null, ...f,
})
const approval = (rid: string, status: Approval['status']): Approval => ({
	request_id: rid, agent: 'agent-b', tool: 'files_delete', status, summary: `Delete ${rid}`, input: {}, payload: { path: '/x.md' },
	requested_at: now, expires_at: now, decided_by: null, decided_at: null, note: null, error: null, result: null,
})

let server: FakeServer
const row = (id: string) => document.querySelector(`[data-item="${id}"]`)!
const dialog = () => document.querySelector('.agent-request')

beforeEach(() => {
	server = fakeServer()
	server.on('GET', '/agent/v1/owner/agents', () => ({ agents: [{ uid: 'agent-a', displayName: 'Mail bot' }, { uid: 'agent-b', displayName: 'Files bot' }] }))
	navigate('/settings/user/agent-activity')
})
afterEach(() => { cleanup(); server.restore() })

test('timeline with names and states; Undo; a request opens with its details', async () => {
	server.on('GET', '/agent/v1/owner/activity', () => ({ items: [
		request('apr_1', 'rejected'),
		action('act_2', { request_id: 'apr_0', summary: 'Delete contact: Ada', undo: 'Restore the contact' }),
		action('act_1'),
		action('act_0', { undo: null, tool: 'files_mkdir', summary: 'New folder: /P' }),
	], next_cursor: null }))
	server.on('POST', '/agent/v1/owner/actions/act_1/undo', () => ({ ...action('act_1'), undo: null, undone_at: now }))
	server.on('GET', '/agent/v1/owner/approvals/apr_1', () => approval('apr_1', 'rejected'))
	const { container } = await render(<AgentActivity session={testSession} />)
	await waitFor(() => getByText(container, 'Delete apr_1'))
	expect(getByText(row('apr_1'), 'Files bot')).toBeTruthy()
	expect(getByText(row('apr_1'), 'Rejected')).toBeTruthy()
	expect(getByText(row('act_2'), 'Done after your OK')).toBeTruthy()
	expect(getByText(row('act_1'), 'Mail bot')).toBeTruthy()
	expect(row('act_0').querySelector('button')).toBeNull()
	expect(queryByText(row('act_1'), 'Request')).toBeNull()

	await click(getButton(row('act_1'), 'Undo'))
	await waitFor(() => getByText(row('act_1'), /^Undone/))
	expect(server.calls('POST', '/agent/v1/owner/actions/act_1/undo')).toHaveLength(1)

	await click(getButton(row('apr_1'), 'Request'))
	expect(location.search).toBe('?request=apr_1')
	await waitFor(() => dialog() && getByText(dialog()!, '/x.md'))
	expect(getByText(dialog()!, 'Files bot')).toBeTruthy()
	expect(queryByText(document.body, 'Approve')).toBeNull()
	await click(getButton(document.body, 'Close'))
	expect(location.search).toBe('')
})

test('agent filter goes in the URL and the query; deep link opens a waiting request; approve', async () => {
	let status: Approval['status'] = 'pending'
	server.on('GET', '/agent/v1/owner/activity', (req) => ({ items: req.query.get('agent') === 'agent-b' ? [request('apr_9', status)] : [action('act_1'), request('apr_9', status)], next_cursor: null }))
	server.on('GET', '/agent/v1/owner/approvals/apr_9', () => approval('apr_9', status))
	server.on('POST', '/agent/v1/owner/approvals/apr_9/approve', () => { status = 'executed'; return approval('apr_9', status) })
	navigate('/settings/user/agent-activity?agent=agent-b&request=apr_9')
	const { container } = await render(<AgentActivity session={testSession} />)
	await waitFor(() => getByText(container, 'Delete apr_9'))
	expect(server.calls('GET', '/agent/v1/owner/activity')[0].query.get('agent')).toBe('agent-b')
	expect(queryByText(container, 'New contact: act_1')).toBeNull()
	await waitFor(() => dialog() && getByText(dialog()!, 'Waiting'))
	await click(getButton(document.body, 'Approve'))
	await waitFor(() => getByText(dialog()!, 'Done'))
	expect(server.calls('POST', '/agent/v1/owner/approvals/apr_9/approve')).toHaveLength(1)
	await waitFor(() => getByText(row('apr_9'), 'Done'))

	await click(getButton(document.body, 'Close'))
	await type(getField(container, 'Agent'), '')
	await waitFor(() => getByText(container, 'New contact: act_1'))
	expect(location.search).toBe('')
})

test('paging and empty state', async () => {
	server.on('GET', '/agent/v1/owner/activity', (req) => req.query.get('cursor') === 'c1'
		? { items: [action('old')], next_cursor: null }
		: { items: [action('new')], next_cursor: 'c1' })
	const { container } = await render(<AgentActivity session={testSession} />)
	await waitFor(() => getByText(container, 'New contact: new'))
	await click(getButton(container, 'Show more'))
	await waitFor(() => getByText(container, 'New contact: old'))
	expect(getByText(container, 'New contact: new')).toBeTruthy()
	expect(queryByText(container, 'Show more')).toBeNull()

	cleanup()
	server.on('GET', '/agent/v1/owner/activity', () => ({ items: [], next_cursor: null }))
	const again = await render(<AgentActivity session={testSession} />)
	await waitFor(() => getByText(again.container, 'Nothing yet'))
})
