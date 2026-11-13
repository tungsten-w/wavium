// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Connect an agent (P2-7, OAuth consent) against a fake server:
// what the user sees (app, where it goes back, local-address warning, what
// the agent may do), allow with an existing or a new agent (created without a
// token), deny, an expired request.
import '../../testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { navigate } from '@atrium/sdk'
import { fakeServer, type FakeServer } from '../../testing/fakeServer'
import { cleanup, click, getButton, getByText, getField, queryByText, render, testSession, type, waitFor } from '../../testing/render'
import { AgentConnect, leave } from './AgentConnect'
import type { OAuthFlow } from './agentsModel'

const flow: OAuthFlow = { flow_id: 'atr_flow_1', client_id: 'atr_cli_1', client_name: 'Claude Code', client_kind: 'dcr', redirect_uri: 'http://localhost:7777/cb', redirect_host: 'localhost:7777', localhost: true }
const agent = (uid: string, name: string, access = {}) => ({ uid, displayName: name, description: '', owner: 'alice', createdAt: 1, enabled: true, paused: false, wakes: false, webhookUrl: null, notifyApprovals: true, doorbellError: null, doorbellErrorAt: null, access, tokens: [] })

let server: FakeServer
let left: string[]
const realLeave = leave.to

beforeEach(() => {
	server = fakeServer()
	left = []
	leave.to = (url) => { left.push(url) }
	server.on('GET', '/agent/v1/owner/oauth/flows/atr_flow_1', () => flow)
	server.on('GET', '/agent/v1/owner/agents', () => ({ agents: [agent('agent-mail', 'Mail helper', { mail: { read: 'allowed', write: 'allowed', send: 'approval' } }), agent('agent-x', 'Empty')] }))
	navigate('/settings/user/agent-connect?flow=atr_flow_1')
})
afterEach(() => { cleanup(); server.restore(); leave.to = realLeave })

test('shows the app, where it goes back and what the chosen agent may do; allow binds the chosen agent', async () => {
	server.on('POST', '/agent/v1/owner/oauth/flows/atr_flow_1/approve', () => ({ redirect: 'http://localhost:7777/cb?code=c1&state=s' }))
	const { container } = await render(<AgentConnect session={testSession} />)
	await waitFor(() => getByText(container, 'Claude Code'))
	expect(getByText(container, 'localhost:7777')).toBeTruthy()
	expect(getByText(container, /local address/)).toBeTruthy()
	expect(getByText(container, /Mail: Read, write · send asks you/)).toBeTruthy()
	await type(getField(container, 'Act as'), 'agent-x')
	await waitFor(() => getByText(container, /Nothing yet/))
	await click(getButton(container, 'Allow'))
	await waitFor(() => left.length === 1 || null)
	expect(server.calls('POST', '/agent/v1/owner/oauth/flows/atr_flow_1/approve')[0].body).toEqual({ agent: 'agent-x' })
	expect(left).toEqual(['http://localhost:7777/cb?code=c1&state=s'])
	expect(getByText(container, 'Done. You can go back to Claude Code.')).toBeTruthy()
	expect(server.calls('POST', '/agent/v1/owner/agents')).toHaveLength(0)
})

test('a new agent is created without a token, then bound', async () => {
	server.on('POST', '/agent/v1/owner/agents', (req) => ({ agent: agent('agent-claude-code', String((req.body as { name: string }).name)), connect: null }))
	server.on('POST', '/agent/v1/owner/oauth/flows/atr_flow_1/approve', () => ({ redirect: 'http://localhost:7777/cb?code=c2' }))
	const { container } = await render(<AgentConnect session={testSession} />)
	await waitFor(() => getByText(container, 'Claude Code'))
	await type(getField(container, 'Act as'), '__new__')
	expect((getField(container, 'Name') as HTMLInputElement).value).toBe('Claude Code')
	await type(getField(container, 'What it may do'), 'everything')
	await click(getButton(container, 'Allow'))
	await waitFor(() => left.length === 1 || null)
	expect(server.calls('POST', '/agent/v1/owner/agents')[0].body).toMatchObject({ name: 'Claude Code', preset: 'everything', token: false })
	expect(server.calls('POST', '/agent/v1/owner/oauth/flows/atr_flow_1/approve')[0].body).toEqual({ agent: 'agent-claude-code' })
})

test('deny goes back to the app; an expired request says so', async () => {
	server.on('POST', '/agent/v1/owner/oauth/flows/atr_flow_1/deny', () => ({ redirect: 'http://localhost:7777/cb?error=access_denied' }))
	const { container } = await render(<AgentConnect session={testSession} />)
	await waitFor(() => getByText(container, 'Claude Code'))
	await click(getButton(container, 'Deny'))
	await waitFor(() => left.length === 1 || null)
	expect(left[0]).toContain('error=access_denied')
	expect(server.calls('POST', '/agent/v1/owner/oauth/flows/atr_flow_1/approve')).toHaveLength(0)

	cleanup()
	server.on('GET', '/agent/v1/owner/oauth/flows/atr_flow_1', () => Response.json({ error: { code: 'not_found', message: 'This connection request expired. Start again from the app.' } }, { status: 404 }))
	const again = await render(<AgentConnect session={testSession} />)
	await waitFor(() => getByText(again.container, /expired/))
	expect(queryByText(again.container, 'Allow')).toBeNull()
})
