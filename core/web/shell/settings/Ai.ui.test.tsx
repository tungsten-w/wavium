// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > AI against a fake server (P2-2): lists providers, adds one with
// a key (sent once, never shown), tests a saved one, admin-only controls.
import '../../testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Session } from '@atrium/sdk'
import { fakeServer, type FakeServer } from '../../testing/fakeServer'
import { cleanup, click, getButton, getByText, getField, queryByText, render, type, waitFor } from '../../testing/render'
import { Ai } from './Ai'
import type { AiOverview, ProviderView } from './aiModel'

const FAKE_KEY = 'sk-test-not-a-real-key-0000WXYZ'
const session = {} as Session
const kinds = [
	{ kind: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true },
	{ kind: 'ollama', baseUrl: 'http://ollama:11434/v1', needsKey: false },
	{ kind: 'mock', baseUrl: null, needsKey: false },
]
const prov = (p: Partial<ProviderView>): ProviderView => ({
	id: 'aip_i', scope: 'instance', label: 'Team Claude', kind: 'anthropic', baseUrl: null, defaultModel: 'claude-x', models: [],
	enabled: true, hasKey: true, keyHint: 'ABCD', updatedAt: 1, editable: false, ...p,
})

let server: FakeServer
let state: AiOverview

beforeEach(() => {
	server = fakeServer()
	state = { isAdmin: false, personalProviders: true, kinds, instance: [prov({})], mine: [], defaultProvider: null, instanceDefault: null, effectiveDefault: 'aip_i' } as AiOverview
	server.on('GET', '/agent/v1/ai/settings', () => state)
})
afterEach(() => { cleanup(); server.restore() })

test('a user sees the instance provider read-only and adds their own', async () => {
	server.on('POST', '/agent/v1/ai/providers', (req) => {
		const b = req.body as Record<string, unknown>
		const v = prov({ id: 'aip_m', scope: 'user', label: String(b.label), editable: true, keyHint: 'WXYZ', defaultModel: String(b.defaultModel) })
		state = { ...state, mine: [v] }
		return v
	})
	server.on('POST', '/agent/v1/ai/test', () => ({ ok: true, models: ['claude-a', 'claude-b'] }))
	const { container } = await render(<Ai session={session} />)
	await waitFor(() => getByText(container, 'Team Claude'))
	expect(getByText(container, 'Key ••••ABCD')).toBeTruthy()
	const row = container.querySelector('[data-provider="aip_i"]')!
	expect(queryByText(row, 'Edit')).toBeNull() // not editable by a user
	expect(queryByText(container, 'Instance options')).toBeNull()
	expect(getByText(container, 'Now: Team Claude.')).toBeTruthy()
	expect(getByText(row, 'used for you')).toBeTruthy()

	await click(getButton(container, 'Add a provider'))
	const dlg = await waitFor(() => document.querySelector('.ai-form')!)
	await click(getButton(document.body, 'Save'))
	expect(getByText(dlg, 'This provider needs an API key')).toBeTruthy()
	expect(server.calls('POST', '/agent/v1/ai/providers')).toHaveLength(0)

	await type(getField(dlg, 'Name'), 'My Claude')
	await type(getField(dlg, 'API key'), FAKE_KEY)
	await click(getButton(document.body, 'Test connection'))
	await waitFor(() => getByText(dlg, 'Connected: 2 models available.'))
	expect(server.calls('POST', '/agent/v1/ai/test')[0].body).toMatchObject({ kind: 'anthropic', apiKey: FAKE_KEY, scope: 'user' })
	expect(dlg.querySelectorAll('datalist option')).toHaveLength(2)
	await type(getField(dlg, 'Default model'), 'claude-a')
	await click(getButton(document.body, 'Save'))
	await waitFor(() => getByText(container, 'My Claude'))
	const sent = server.calls('POST', '/agent/v1/ai/providers')[0]
	expect(sent.body).toMatchObject({ kind: 'anthropic', label: 'My Claude', apiKey: FAKE_KEY, defaultModel: 'claude-a', scope: 'user' })
	expect(sent.headers.get('OCS-APIRequest')).toBe('true')
	expect(document.body.textContent).not.toContain(FAKE_KEY) // the dialog is gone, the key with it
	expect(server.unhandled).toEqual([])
})

test('editing keeps the stored key unless a new one is typed', async () => {
	state = { ...state, mine: [prov({ id: 'aip_m', scope: 'user', label: 'Mine', editable: true, keyHint: 'WXYZ' })] }
	server.on('PATCH', '/agent/v1/ai/providers/aip_m', (req) => ({ ...state.mine[0], ...(req.body as object) }))
	const { container } = await render(<Ai session={session} />)
	await waitFor(() => getByText(container, 'Mine'))
	await click(getButton(container.querySelector('[data-provider="aip_m"]')!, 'Edit'))
	const dlg = await waitFor(() => document.querySelector('.ai-form')!)
	expect((getField(dlg, 'API key') as HTMLInputElement).placeholder).toBe('Unchanged (Key ••••WXYZ)')
	await type(getField(dlg, 'Name'), 'Renamed')
	await click(getButton(document.body, 'Save'))
	await waitFor(() => server.calls('PATCH').length === 1)
	const body = server.calls('PATCH')[0].body as Record<string, unknown>
	expect(body.label).toBe('Renamed')
	expect('apiKey' in body).toBe(false)
})

test('test button on a saved provider shows the server error', async () => {
	server.on('POST', '/agent/v1/ai/test', () => ({ ok: false, error: { code: 'auth', message: 'anthropic: HTTP 401' } }))
	const { container } = await render(<Ai session={session} />)
	await waitFor(() => getByText(container, 'Team Claude'))
	await click(getButton(container, 'Test'))
	await waitFor(() => getByText(container, 'The key was refused: anthropic: HTTP 401'))
	expect(server.calls('POST', '/agent/v1/ai/test')[0].body).toEqual({ id: 'aip_i' })
})

test('admin: instance controls; personal providers turned off hides "your own"', async () => {
	state = { ...state, isAdmin: true, instance: [prov({ editable: true })] }
	server.on('PUT', '/agent/v1/ai/admin', (req) => { state = { ...state, personalProviders: (req.body as { personalProviders: boolean }).personalProviders }; return state })
	const { container } = await render(<Ai session={session} />)
	await waitFor(() => getByText(container, 'Instance options'))
	expect(getButton(container.querySelector('[data-provider="aip_i"]')!, 'Edit')).toBeTruthy()
	expect(getByText(container, 'Your own providers')).toBeTruthy()
	await click(getField(container, 'Users may add their own providers'))
	await waitFor(() => queryByText(container, 'Your own providers') === null)
	expect(server.calls('PUT', '/agent/v1/ai/admin')[0].body).toEqual({ personalProviders: false })
})

test('no provider at all: says AI features stay off', async () => {
	state = { ...state, instance: [], effectiveDefault: null }
	const { container } = await render(<Ai session={session} />)
	await waitFor(() => getByText(container, 'Your admin has not set up an AI provider.'))
	expect(getByText(container, 'No usable provider: AI features stay off.')).toBeTruthy()
})
