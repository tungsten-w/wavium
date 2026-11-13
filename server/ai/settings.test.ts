// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > AI store (P2-2): scopes, permissions, key encryption, the URL guard
// for personal providers and "test connection". SQLite in memory, fake fetch,
// fake keys only (rule A2).
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { type Db, wrap } from '../agent/db'
import { webhookPolicy } from '../agent/netguard'
import { AiSettings, AiSettingsError, keyCipher, keyHint } from './settings'
import { fakeFetch, jsonRes } from './testkit'
import type { FetchFn } from './types'

const FAKE_KEY = 'sk-test-not-a-real-key-0000WXYZ'
const admin = { uid: 'admin', isAdmin: true }
const alice = { uid: 'alice', isAdmin: false }
const bob = { uid: 'bob', isAdmin: false }

const dns = (table: Record<string, string[]>) => async (host: string) => {
	if (!(host in table)) throw new Error(`ENOTFOUND ${host}`)
	return table[host]
}
const policy = webhookPolicy('', dns({ 'api.anthropic.com': ['160.79.104.10'], 'api.openai.com': ['162.159.140.245'], 'evil.example': ['10.0.0.5'], 'ollama': ['172.18.0.4'] }))

let db: Db
let fetchImpl: FetchFn
let clock = 1_700_000_000_000
const seen: string[] = []

function store(opts: { allowMock?: boolean, secret?: string } = {}) {
	return new AiSettings(db, opts.secret ?? 'instance-secret-for-tests', {
		allowMock: opts.allowMock ?? true,
		policy,
		fetch: (u, i) => { seen.push(u); return fetchImpl(u, i) },
		now: () => clock++,
	})
}

const code = async (p: Promise<unknown>) => {
	try {
		await p
	} catch (e) {
		if (e instanceof AiSettingsError) return e.code
		throw e
	}
	return 'ok'
}

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await db.q('CREATE TABLE oc_group_user (gid TEXT, uid TEXT)')
	await db.q(`INSERT INTO oc_group_user VALUES ('admin', 'admin')`)
	fetchImpl = async () => { throw new Error('unexpected network call') }
	seen.length = 0
})

test('key cipher: round trip, bound to the provider id and the secret', () => {
	const c = keyCipher('s1')
	const sealed = c.seal(FAKE_KEY, 'aip_1')
	expect(sealed.startsWith('v1:')).toBe(true)
	expect(sealed).not.toContain(FAKE_KEY)
	expect(c.seal(FAKE_KEY, 'aip_1')).not.toBe(sealed) // fresh IV each time
	expect(c.open(sealed, 'aip_1')).toBe(FAKE_KEY)
	expect(() => c.open(sealed, 'aip_2')).toThrow()
	expect(() => keyCipher('s2').open(sealed, 'aip_1')).toThrow()
	const raw = Buffer.from(sealed.slice(3), 'base64')
	raw[14] ^= 1
	expect(() => c.open('v1:' + raw.toString('base64'), 'aip_1')).toThrow()
	expect(keyHint(FAKE_KEY)).toBe('WXYZ')
	expect(keyHint('short-key')).toBeNull()
})

test('the key is stored encrypted and never returned', async () => {
	const s = store()
	const v = await s.create(alice, { kind: 'anthropic', label: 'My Claude', apiKey: FAKE_KEY, defaultModel: 'claude-x' })
	expect(v).toMatchObject({ scope: 'user', label: 'My Claude', hasKey: true, keyHint: 'WXYZ', editable: true, enabled: true })
	expect(JSON.stringify(v)).not.toContain(FAKE_KEY)
	const [row] = await db.q<{ key_enc: string }>('SELECT key_enc FROM oc_atrium_ai_providers')
	expect(row.key_enc).not.toContain(FAKE_KEY)
	expect(JSON.stringify(await s.overview(alice))).not.toContain(FAKE_KEY)
	// Server code gets it back.
	const cfg = await s.config('alice')
	expect(cfg.providers[0].apiKey).toBe(FAKE_KEY)
	expect(cfg.defaultProvider).toBe(v.id)
})

test('editing: absent key keeps it, null removes it, a kind change needs the key again', async () => {
	const s = store()
	const v = await s.create(alice, { kind: 'openai', apiKey: FAKE_KEY })
	const renamed = await s.update(alice, v.id, { label: 'Work' })
	expect(renamed).toMatchObject({ label: 'Work', hasKey: true })
	expect((await s.config('alice')).providers[0].apiKey).toBe(FAKE_KEY)
	expect(await code(s.update(alice, v.id, { kind: 'mistral' }))).toBe('invalid_input')
	expect(await code(s.update(alice, v.id, { apiKey: null }))).toBe('invalid_input') // openai needs a key
	const local = await s.update(alice, v.id, { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: null })
	expect(local).toMatchObject({ hasKey: false, keyHint: null, kind: 'openai-compatible' })
})

test('validation messages', async () => {
	const s = store()
	expect(await code(s.create(alice, { kind: 'nope' }))).toBe('invalid_input')
	expect(await code(s.create(alice, { kind: 'anthropic' }))).toBe('invalid_input') // no key
	expect(await code(s.create(alice, { kind: 'openai-compatible' }))).toBe('invalid_input') // no base URL
	expect(await code(s.create(alice, { kind: 'openai-compatible', baseUrl: 'ftp://x' }))).toBe('invalid_input')
	expect(await code(s.create(alice, { kind: 'anthropic', apiKey: 42 }))).toBe('invalid_input')
	expect(await code(s.create(alice, { kind: 'anthropic', apiKey: FAKE_KEY, models: 'a, b ,a' }))).toBe('ok')
	expect((await s.overview(alice)).mine[0].models).toEqual(['a', 'b'])
})

test('scopes: only admins manage instance providers; personal ones are private', async () => {
	const s = store()
	expect(await code(s.create(alice, { scope: 'instance', kind: 'mock' }))).toBe('forbidden')
	const inst = await s.create(admin, { scope: 'instance', kind: 'ollama', label: 'LAN Ollama', defaultModel: 'llama3' })
	const mine = await s.create(alice, { kind: 'mock', label: 'alice mock' })

	const a = await s.overview(alice)
	expect(a.instance).toHaveLength(1)
	expect(a.instance[0]).toMatchObject({ editable: false, baseUrl: null }) // internal host hidden from users
	expect(a.mine.map((p) => p.id)).toEqual([mine.id])
	expect((await s.overview(admin)).instance[0].baseUrl).toBeNull() // default URL: none stored
	expect((await s.overview(bob)).mine).toEqual([])

	expect(await code(s.update(alice, inst.id, { label: 'x' }))).toBe('forbidden')
	expect(await code(s.remove(alice, inst.id))).toBe('forbidden')
	expect(await code(s.update(bob, mine.id, { label: 'x' }))).toBe('not_found') // not even visible
	expect(await code(s.remove(bob, mine.id))).toBe('not_found')
	expect(await code(s.setDefault(bob, mine.id))).toBe('not_found')

	// Both usable by alice; bob only sees the instance one.
	expect((await s.config('alice')).providers.map((p) => p.id)).toEqual([inst.id, mine.id])
	expect((await s.config('bob')).providers.map((p) => p.id)).toEqual([inst.id])
})

test('defaults: personal choice, then instance default, then the first instance provider', async () => {
	const s = store()
	const i1 = await s.create(admin, { scope: 'instance', kind: 'mock', label: 'one' })
	const i2 = await s.create(admin, { scope: 'instance', kind: 'mock', label: 'two' })
	const mine = await s.create(alice, { kind: 'mock' })
	expect((await s.config('alice')).defaultProvider).toBe(i1.id)
	expect(await code(s.setDefault(alice, i2.id, 'instance'))).toBe('forbidden')
	await s.setDefault(admin, i2.id, 'instance')
	expect((await s.config('alice')).defaultProvider).toBe(i2.id)
	await s.setDefault(alice, mine.id)
	expect((await s.config('alice')).defaultProvider).toBe(mine.id)
	expect((await s.config('bob')).defaultProvider).toBe(i2.id)
	// A disabled or deleted default falls back.
	await s.update(alice, mine.id, { enabled: false })
	expect((await s.config('alice')).defaultProvider).toBe(i2.id)
	await s.remove(admin, i2.id)
	expect((await s.config('bob')).defaultProvider).toBe(i1.id)
	expect((await s.overview(admin)).instanceDefault).toBeNull()
})

test('admin can turn personal providers off', async () => {
	const s = store()
	const mine = await s.create(alice, { kind: 'mock' })
	expect(await code(s.setPersonalAllowed(alice, false))).toBe('forbidden')
	await s.setPersonalAllowed(admin, false)
	expect(await code(s.create(alice, { kind: 'mock' }))).toBe('forbidden')
	expect((await s.config('alice')).providers).toEqual([])
	expect((await s.overview(alice)).personalProviders).toBe(false)
	await s.setPersonalAllowed(admin, true)
	expect((await s.config('alice')).providers.map((p) => p.id)).toEqual([mine.id])
})

test('mock kind only on test instances', async () => {
	const s = store({ allowMock: false })
	expect(s.kinds().map((k) => k.kind)).not.toContain('mock')
	expect(await code(s.create(admin, { scope: 'instance', kind: 'mock' }))).toBe('invalid_input')
	// Rows left from a test instance are not used.
	await store().create(admin, { scope: 'instance', kind: 'mock' })
	expect((await s.config('alice')).providers).toEqual([])
})

test('personal providers may not point to internal addresses; instance ones may', async () => {
	const s = store()
	expect(await code(s.create(alice, { kind: 'openai-compatible', baseUrl: 'http://evil.example/v1' }))).toBe('invalid_input')
	expect(await code(s.create(alice, { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' }))).toBe('invalid_input')
	expect(await code(s.create(alice, { kind: 'ollama' }))).toBe('invalid_input') // default http://ollama resolves inside
	expect(await code(s.create(admin, { scope: 'instance', kind: 'ollama' }))).toBe('ok')
	// Saved while public, then DNS points inside: refused at call time, no request sent.
	const p = await s.create(alice, { kind: 'openai-compatible', baseUrl: 'http://later.example/v1' }) // unresolved: saved
	const ai = await s.provider('alice', p.id)
	const t = await ai!.testConnection()
	expect(t.ok).toBe(false)
	expect(seen).toEqual([])
})

test('test connection: draft, saved key reuse, failures', async () => {
	const s = store()
	const { fetch, calls } = fakeFetch(
		jsonRes({ data: [{ id: 'claude-a' }, { id: 'claude-b' }] }),
		jsonRes({ data: [{ id: 'claude-a' }] }),
		jsonRes({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401),
	)
	fetchImpl = fetch
	const draft = await s.test(alice, { kind: 'anthropic', apiKey: FAKE_KEY })
	expect(draft).toEqual({ ok: true, models: ['claude-a', 'claude-b'] })
	expect(calls[0].headers['x-api-key']).toBe(FAKE_KEY)

	const saved = await s.create(alice, { kind: 'anthropic', apiKey: FAKE_KEY })
	expect((await s.test(alice, { id: saved.id })).ok).toBe(true) // stored key used
	expect(calls[1].headers['x-api-key']).toBe(FAKE_KEY)

	const bad = await s.test(alice, { id: saved.id, apiKey: 'sk-wrong-fake-key-000000' })
	expect(bad.ok).toBe(false)
	expect(bad.error?.code).toBe('auth')
	expect(JSON.stringify(bad)).not.toContain('sk-wrong')

	expect((await s.test(alice, { kind: 'anthropic' })).error?.code).toBe('invalid') // no key
	expect(await code(s.test(bob, { id: saved.id }))).toBe('not_found')
	expect(await code(s.test(alice, { scope: 'instance', kind: 'mock' }))).toBe('forbidden')
	expect((await s.test(alice, { kind: 'mock' })).ok).toBe(true)
})

test('a key sealed under another secret makes the provider unusable, not a crash', async () => {
	await store({ secret: 'old' }).create(alice, { kind: 'anthropic', apiKey: FAKE_KEY })
	const s = store({ secret: 'new' })
	expect((await s.config('alice')).providers).toEqual([])
	expect((await s.overview(alice)).mine[0].hasKey).toBe(true) // still listed: the user re-enters it
})

test('provider(): builds the default, null when nothing is set up', async () => {
	const s = store()
	expect(await s.provider('alice')).toBeNull()
	await s.create(admin, { scope: 'instance', kind: 'mock', defaultModel: 'mock-9' })
	const ai = await s.provider('alice')
	const r = await ai!.complete({ messages: [{ role: 'user', content: 'ping' }] })
	expect(r.text).toBe('mock: ping')
	expect(r.model).toBe('mock-9')
})
