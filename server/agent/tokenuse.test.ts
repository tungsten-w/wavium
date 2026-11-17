// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// V4-9: each agent token's last use (time, address, client), and the address
// behind a proxy without trusting what a client puts in X-Forwarded-For.
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { Auth, type Caller, clientIp, TokenUse } from './auth'
import { type Db, migrate, wrap } from './db'

let db: Db
beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
})

const caller = (tokenId: number | null): Caller => ({ uid: 'agent-bot', displayName: 'Bot', isAgent: true, agentToken: true, owner: 'alice', tokenId })

test('client address: the peer, or what a private proxy appended', () => {
	expect(clientIp('203.0.113.9', null)).toBe('203.0.113.9')
	// A public client cannot pick its own address.
	expect(clientIp('203.0.113.9', '1.2.3.4')).toBe('203.0.113.9')
	// Behind Caddy/Docker: the last entry is the one the proxy added.
	expect(clientIp('172.18.0.5', '6.6.6.6, 198.51.100.7')).toBe('198.51.100.7')
	expect(clientIp('10.0.0.2', 'not an ip<script>')).toBe('10.0.0.2')
})

test('records the last use per token, at most every 30 s, and counts calls', async () => {
	let t = 1_800_000_000_000
	const use = new TokenUse(db, () => t)
	await use.record(caller(7), '198.51.100.7', 'curl/8.9')
	await use.record(caller(7), '198.51.100.8', 'curl/8.9')
	expect((await use.forAgent('agent-bot')).get(7)).toEqual({ ip: '198.51.100.7', at: 1_800_000_000, userAgent: 'curl/8.9' })
	t += 31_000
	await use.record(caller(7), '198.51.100.8', 'python-httpx/0.28')
	expect((await use.forAgent('agent-bot')).get(7)?.ip).toBe('198.51.100.8')
	const [row] = await db.q<{ calls: unknown }>('SELECT calls FROM oc_atrium_agent_token_use WHERE token_id = 7')
	expect(Number(row.calls)).toBe(2)
	await use.record(caller(null), '1.1.1.1', null) // no id: nothing
	expect((await use.forAgent('agent-bot')).size).toBe(1)
	expect((await use.forAgent('someone-else')).size).toBe(0)
})

test('Auth.agent calls the use hook only for accepted agent tokens', async () => {
	const answers: Record<string, Caller | null> = {
		'Bearer good': caller(9),
		'Bearer person': { ...caller(3), isAgent: false, agentToken: false },
	}
	const php = { ocs: async (_m: string, _p: string, o: { headers: Record<string, string> }) => {
		const a = answers[o.headers.authorization]
		if (!a) { const { AgentError } = await import('./util'); throw new AgentError('auth', 'no') }
		return a
	} } as never
	const auth = new Auth(php)
	const seen: number[] = []
	auth.onAgent = (c) => { seen.push(c.tokenId!) }
	const req = (h: string) => new Request('https://w.test/agent/mcp', { headers: { authorization: h } })
	await auth.agent(req('Bearer good'))
	await expect(auth.agent(req('Bearer person'))).rejects.toMatchObject({ code: 'forbidden' })
	await expect(auth.agent(req('Bearer bad'))).rejects.toMatchObject({ code: 'auth' })
	expect(seen).toEqual([9])
})
