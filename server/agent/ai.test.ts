// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /agent/v1/ai/* routes (Settings > AI, P2-2): auth, routing, error codes, and
// that no answer ever carries the key back.
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { AiSettings } from '../ai/settings'
import { aiModule } from './ai'
import { type Db, wrap } from './db'
import type { LayerCore } from './index'
import { AgentError, errorResponse } from './util'

const FAKE_KEY = 'sk-test-not-a-real-key-0000WXYZ'
let db: Db
let core: LayerCore
let mod: ReturnType<typeof aiModule>
/** PHP calls the module made (V4-26 asks Mail to turn classification on). */
let phpCalls: Array<{ method: string, path: string }>
let phpFails: boolean

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await db.q('CREATE TABLE oc_group_user (gid TEXT, uid TEXT)')
	await db.q(`INSERT INTO oc_group_user VALUES ('admin', 'admin')`)
	// Owner auth stand-in: the user name is the cookie; writes need OCS-APIRequest (like Auth.owner).
	const auth = {
		async owner(req: Request) {
			const uid = req.headers.get('cookie')
			if (!uid) throw new AgentError('auth', 'Not logged in')
			if (req.method !== 'GET' && req.headers.get('ocs-apirequest') !== 'true') throw new AgentError('forbidden', 'Missing OCS-APIRequest header')
			return { uid, displayName: uid, isAgent: false, agentToken: false, owner: null }
		},
	}
	phpCalls = []
	phpFails = false
	const php = {
		async app(method: string, path: string) {
			phpCalls.push({ method, path })
			if (phpFails) throw new AgentError('unavailable', 'Mail is not answering')
			return { enabled: true, changed: true, reason: 'first AI provider' }
		},
	}
	core = { db, cfg: { secret: 'test-secret' }, auth, php } as unknown as LayerCore
	mod = aiModule((c) => new AiSettings(c.db, c.cfg.secret, { allowMock: true }))
})

async function call(method: string, path: string, user: string | null, body?: unknown): Promise<{ status: number, json: any, text: string }> {
	const headers: Record<string, string> = { 'ocs-apirequest': 'true' }
	if (user) headers.cookie = user
	if (body !== undefined) headers['content-type'] = 'application/json'
	const req = new Request(`http://x/agent/v1/ai/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
	let res: Response | null
	try {
		res = await mod.route!(core, req, new URL(req.url), new URL(req.url).pathname)
	} catch (e) {
		if (!(e instanceof AgentError)) throw e
		res = errorResponse(e)
	}
	if (!res) return { status: 0, json: null, text: '' }
	const text = await res.text()
	return { status: res.status, json: text ? JSON.parse(text) : null, text }
}

test('other paths are left to other modules', async () => {
	const req = new Request('http://x/agent/v1/owner/agents')
	expect(await mod.route!(core, req, new URL(req.url), '/agent/v1/owner/agents')).toBeNull()
})

test('needs a logged-in user and the OCS header on writes', async () => {
	expect((await call('GET', 'settings', null)).status).toBe(401)
	const req = new Request('http://x/agent/v1/ai/providers', { method: 'POST', headers: { cookie: 'alice' }, body: '{}' })
	await expect(mod.route!(core, req, new URL(req.url), '/agent/v1/ai/providers')).rejects.toMatchObject({ code: 'forbidden' })
})

test('full flow: add, list, test, edit, default, delete; the key never comes back', async () => {
	const add = await call('POST', 'providers', 'alice', { kind: 'anthropic', label: 'Claude', apiKey: FAKE_KEY })
	expect(add.status).toBe(200)
	expect(add.json).toMatchObject({ label: 'Claude', hasKey: true, keyHint: 'WXYZ' })
	const id = add.json.id as string
	// Exactly these fields: no key, not even encrypted.
	expect(Object.keys(add.json).sort()).toEqual(['baseUrl', 'defaultModel', 'editable', 'enabled', 'hasKey', 'id', 'keyHint', 'kind', 'label', 'models', 'scope', 'updatedAt'])
	const [row] = await db.q<{ key_enc: string }>('SELECT key_enc FROM oc_atrium_ai_providers')
	for (const v of [row.key_enc, row.key_enc.slice(3)]) expect(add.text).not.toContain(v)

	const list = await call('GET', 'settings', 'alice')
	expect(list.json).toMatchObject({ isAdmin: false, personalProviders: true, effectiveDefault: id })
	expect(list.json.kinds.map((k: { kind: string }) => k.kind)).toContain('mock')
	for (const r of [add, list]) expect(r.text).not.toContain(FAKE_KEY)

	expect((await call('POST', 'test', 'alice', { kind: 'mock' })).json).toEqual({ ok: true, models: ['mock-1'] })
	const edit = await call('PATCH', `providers/${id}`, 'alice', { label: 'Claude perso' })
	expect(edit.json.label).toBe('Claude perso')
	expect(edit.text).not.toContain(FAKE_KEY)

	expect((await call('PUT', 'default', 'alice', { provider: id })).json.defaultProvider).toBe(id)
	expect((await call('PUT', 'default', 'alice', { provider: null })).json.defaultProvider).toBeNull()
	expect((await call('DELETE', `providers/${id}`, 'bob')).status).toBe(404)
	expect((await call('DELETE', `providers/${id}`, 'alice')).json).toEqual({ deleted: true })
	expect((await call('GET', 'settings', 'alice')).json.mine).toEqual([])
})

test('error codes: bad input 400, not an admin 403, unknown route 404', async () => {
	expect((await call('POST', 'providers', 'alice', { kind: 'nope' })).status).toBe(400)
	expect((await call('POST', 'providers', 'alice', [1])).status).toBe(400)
	expect((await call('POST', 'providers', 'alice', { scope: 'instance', kind: 'mock' })).status).toBe(403)
	expect((await call('PUT', 'admin', 'alice', { personalProviders: false })).status).toBe(403)
	expect((await call('PUT', 'admin', 'admin', { personalProviders: 'no' })).status).toBe(400)
	expect((await call('PUT', 'admin', 'admin', { personalProviders: false })).json.personalProviders).toBe(false)
	expect((await call('GET', 'nothing', 'alice')).status).toBe(404)
	expect((await call('POST', 'providers', 'alice', { kind: 'mock' })).status).toBe(403) // turned off above
})

// --- V4-26: adding an instance provider turns mail classification on ---

const TRIAGE_CALL = { method: 'POST', path: 'apps/mail/api/atrium-agent/triage-auto-enable' }

test('an instance provider asks Mail to turn classification on', async () => {
	const add = await call('POST', 'providers', 'admin', { scope: 'instance', kind: 'mock', label: 'Instance AI' })
	expect(add.status).toBe(200)
	expect(add.json.scope).toBe('instance')
	expect(phpCalls).toEqual([TRIAGE_CALL])
})

test('a personal provider does not: triage_enabled is instance-wide', async () => {
	expect((await call('POST', 'providers', 'alice', { kind: 'anthropic', label: 'Mine', apiKey: FAKE_KEY })).status).toBe(200)
	expect(phpCalls).toEqual([])
})

test('a provider added switched off does not turn classification on', async () => {
	expect((await call('POST', 'providers', 'admin', { scope: 'instance', kind: 'mock', label: 'Later', enabled: false })).status).toBe(200)
	expect(phpCalls).toEqual([])
})

test('Mail not answering does not lose the provider', async () => {
	phpFails = true
	const add = await call('POST', 'providers', 'admin', { scope: 'instance', kind: 'mock', label: 'Instance AI' })
	expect(add.status).toBe(200)
	expect(add.json.label).toBe('Instance AI')
	expect(phpCalls).toEqual([TRIAGE_CALL])
	expect((await call('GET', 'settings', 'admin')).json.instance).toHaveLength(1)
})
