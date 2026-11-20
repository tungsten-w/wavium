// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// V4-8: "Test" next to the doorbell URL: one signed POST with the real
// guards (no private addresses, no redirects), an answer in plain words.
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { updateSettings } from './access'
import { type Db, migrate, wrap } from './db'
import { Doorbell, testDoorbell } from './events'
import { webhookPolicy } from './netguard'

let db: Db
const dns = (map: Record<string, string[]>) => async (h: string) => map[h] ?? []
const policy = webhookPolicy('', dns({ 'hooks.example.com': ['93.184.216.34'], 'inside.example.com': ['10.0.0.5'] }), false)
let sent: Array<{ url: string, headers: Headers, body: string }>
const fetcher = (status: number) => (async (url: string, init: RequestInit) => {
	sent.push({ url, headers: new Headers(init.headers), body: String(init.body) })
	expect(init.redirect).toBe('manual')
	return new Response(null, { status })
}) as unknown as typeof fetch

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	sent = []
})

async function setHook(url: string | null) {
	await updateSettings(db, 'agent-bot', { webhookUrl: url, webhookSecret: 'whsec_test' }, policy)
}

test('a working doorbell: signed, marked as a test, answer with timing', async () => {
	await setHook('https://hooks.example.com/doorbell')
	const r = await testDoorbell(db, 'agent-bot', fetcher(204), policy)
	expect(r).toMatchObject({ ok: true, status: 204 })
	expect(r.message).toContain('It works')
	const { headers, body } = sent[0]
	expect(JSON.parse(body)).toMatchObject({ agent: 'agent-bot', wake: false, test: true })
	expect(headers.get('x-atrium-test')).toBe('1')
	expect(headers.get('x-atrium-signature')).toBe(Doorbell.sign('whsec_test', Number(headers.get('x-atrium-timestamp')), body))
})

test('plain-words failures: no URL, no secret, refused, redirected', async () => {
	expect((await testDoorbell(db, 'agent-bot', fetcher(200), policy)).message).toContain('No webhook URL')
	await setHook('https://hooks.example.com/d')
	await db.q("UPDATE oc_atrium_agent_settings SET webhook_secret = NULL WHERE uid = 'agent-bot'")
	expect((await testDoorbell(db, 'agent-bot', fetcher(200), policy)).message).toContain('no webhook secret')
	await setHook('https://hooks.example.com/d')
	expect((await testDoorbell(db, 'agent-bot', fetcher(401), policy))).toMatchObject({ ok: false, status: 401 })
	expect((await testDoorbell(db, 'agent-bot', fetcher(302), policy)).message).toContain('redirects are not followed')
})

test('the test never reaches inside the network, even if DNS changed since saving', async () => {
	await setHook('https://hooks.example.com/d')
	const moved = webhookPolicy('', dns({ 'hooks.example.com': ['127.0.0.1'] }), false)
	const r = await testDoorbell(db, 'agent-bot', fetcher(200), moved)
	expect(r.ok).toBe(false)
	expect(r.message).toMatch(/^Not sent/)
	expect(sent).toEqual([])
})

test('public demo: nothing is sent', async () => {
	await setHook('https://hooks.example.com/d')
	const demo = webhookPolicy('', dns({ 'hooks.example.com': ['93.184.216.34'] }), true)
	const r = await testDoorbell(db, 'agent-bot', fetcher(200), demo)
	expect(r.ok).toBe(false)
	expect(sent).toEqual([])
})
