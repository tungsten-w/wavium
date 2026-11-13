// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P1-4: a revoked token is refused at once, wherever it was revoked (Settings,
// a classic Nextcloud page, occ), not after the 60 s cache.
import { SQL } from 'bun'
import { expect, test } from 'bun:test'
import { Auth, authFingerprint, type Caller } from './auth'
import { wrap } from './db'
import type { PhpCaller } from './phpcall'
import { AgentError } from './util'

const lia: Caller = { uid: 'lia', displayName: 'Lia', isAgent: true, agentToken: true, owner: 'alice' }

/** PHP's whoami: answers from a set of valid tokens, counts the calls. */
function fakePhp(valid: Set<string>) {
	const php = {
		calls: 0,
		async ocs(_m: string, _p: string, opts: { headers?: Record<string, string> }) {
			php.calls++
			if (valid.has(opts.headers?.authorization ?? '')) return lia
			throw new AgentError('auth', 'not logged in')
		},
	}
	return php
}

function bearer(token: string): Request {
	return new Request('http://x/agent/mcp', { headers: { authorization: `Bearer ${token}` } })
}

function clock() {
	const c = { t: 1_000_000, now: () => c.t, tick: (ms: number) => { c.t += ms } }
	return c
}

test('revoked elsewhere: refused as soon as the fingerprint changes', async () => {
	const valid = new Set(['Bearer tok-1'])
	const php = fakePhp(valid)
	let fp = 'v1'
	const c = clock()
	const auth = new Auth(php as unknown as PhpCaller, async () => fp, c.now)

	expect((await auth.agent(bearer('tok-1'))).uid).toBe('lia')
	c.tick(500)
	expect((await auth.agent(bearer('tok-1'))).uid).toBe('lia')
	expect(php.calls).toBe(1) // cached

	// Revoked in Settings > Security (PHP): the token row is gone.
	valid.delete('Bearer tok-1')
	fp = 'v2'
	c.tick(1_000)
	await expect(auth.agent(bearer('tok-1'))).rejects.toThrow('Invalid or revoked token')
	expect(php.calls).toBe(2)
})

test('nothing changed: the answer stays cached up to 60 s', async () => {
	const php = fakePhp(new Set(['Bearer tok-1']))
	const c = clock()
	const auth = new Auth(php as unknown as PhpCaller, async () => 'same', c.now)
	await auth.agent(bearer('tok-1'))
	for (let i = 0; i < 50; i++) {
		c.tick(1_000)
		await auth.agent(bearer('tok-1'))
	}
	expect(php.calls).toBe(1)
	c.tick(15_000)
	await auth.agent(bearer('tok-1'))
	expect(php.calls).toBe(2)
})

test('the fingerprint is read at most once a second, even with many requests', async () => {
	const php = fakePhp(new Set(['Bearer tok-1']))
	let reads = 0
	const c = clock()
	const auth = new Auth(php as unknown as PhpCaller, async () => { reads++; return 'same' }, c.now)
	await Promise.all(Array.from({ length: 20 }, () => auth.agent(bearer('tok-1'))))
	expect(reads).toBe(1)
	c.tick(999)
	await auth.agent(bearer('tok-1'))
	expect(reads).toBe(1)
	c.tick(1)
	await auth.agent(bearer('tok-1'))
	expect(reads).toBe(2)
})

test('fingerprint unreadable (DB down): answers live 5 s only', async () => {
	const valid = new Set(['Bearer tok-1'])
	const php = fakePhp(valid)
	const c = clock()
	const auth = new Auth(php as unknown as PhpCaller, async () => { throw new Error('db down') }, c.now)
	const err = console.error
	console.error = () => {}
	try {
		await auth.agent(bearer('tok-1'))
		valid.clear()
		c.tick(5_000)
		await expect(auth.agent(bearer('tok-1'))).rejects.toThrow('Invalid or revoked token')
	} finally {
		console.error = err
	}
})

test('authFingerprint follows token deletes, adds, wipes and disabled users', async () => {
	const db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	// Same tables as Nextcloud (only the columns read here).
	await db.q('CREATE TABLE oc_authtoken (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, type INTEGER)')
	await db.q('CREATE TABLE oc_preferences (userid TEXT, appid TEXT, configkey TEXT, configvalue TEXT)')
	await db.q("INSERT INTO oc_authtoken (uid, type) VALUES ('lia', 1), ('alice', 0)")
	const seen = new Set<string>()
	const step = async () => {
		const fp = await authFingerprint(db)
		expect(seen.has(fp)).toBe(false)
		seen.add(fp)
	}
	await step()
	await db.q("DELETE FROM oc_authtoken WHERE uid = 'lia'") // revoke
	await step()
	await db.q("INSERT INTO oc_authtoken (uid, type) VALUES ('bob', 0)") // login
	await step()
	await db.q("UPDATE oc_authtoken SET type = 2 WHERE uid = 'bob'") // remote wipe
	await step()
	await db.q("INSERT INTO oc_preferences VALUES ('lia', 'core', 'enabled', 'false')") // disable
	await step()
	// Delete one and add one between two reads: still a change.
	await db.q("DELETE FROM oc_authtoken WHERE uid = 'alice'")
	await db.q("INSERT INTO oc_authtoken (uid, type) VALUES ('alice', 0)")
	await step()
	expect(await authFingerprint(db)).toBe([...seen].at(-1)!)
	await db.close()
})
