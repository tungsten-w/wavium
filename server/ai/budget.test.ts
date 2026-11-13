// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Budgets and usage (P2-3). Mock provider only (rule A2), fake clock.
import { describe, expect, test } from 'bun:test'
import { wrap as wrapDb } from '../agent/db'
import {
	backoff, Budget, BudgetBlocked, type BudgetConfig, costOf, dayStart, MemoryUsageStore, monthStart, nextDayStart,
	nextMonthStart, priceOf, type UsageStore,
} from './budget'
import { AiError, createProvider } from './index'
import { fakeFetch } from './testkit'
import { SqlUsageStore } from './usage-store'

const msg = (text = 'hello') => ({ messages: [{ role: 'user' as const, content: text }] })

// 2026-03-15 12:00 local time.
const NOON = Math.floor(new Date(2026, 2, 15, 12, 0, 0).getTime() / 1000)

function setup(cfg: BudgetConfig = {}, store: UsageStore = new MemoryUsageStore()) {
	const clock = { t: NOON }
	const errors: unknown[] = []
	const budget = new Budget(store, () => cfg, { now: () => clock.t, onError: (e) => errors.push(e) })
	const mock = createProvider({ kind: 'mock', id: 'cheap', defaultModel: 'small' })
	const ai = budget.wrap(mock, { user: 'alice', task: 'triage' })
	return { clock, budget, mock, ai, store, errors, cfg }
}

describe('time boundaries (local time)', () => {
	test('day and month starts', () => {
		expect(new Date(dayStart(NOON) * 1000)).toEqual(new Date(2026, 2, 15))
		expect(new Date(nextDayStart(NOON) * 1000)).toEqual(new Date(2026, 2, 16))
		expect(new Date(monthStart(NOON) * 1000)).toEqual(new Date(2026, 2, 1))
		expect(new Date(nextMonthStart(NOON) * 1000)).toEqual(new Date(2026, 3, 1))
		const dec31 = Math.floor(new Date(2026, 11, 31, 23, 59).getTime() / 1000)
		expect(new Date(nextMonthStart(dec31) * 1000)).toEqual(new Date(2027, 0, 1))
	})
})

describe('cost', () => {
	test('price lookup: most specific first', () => {
		const prices = { 'cheap:small': { input: 1, output: 2 }, '*:big': { input: 3, output: 4 }, 'cheap:*': { input: 9, output: 9 } }
		expect(priceOf(prices, 'cheap', 'small')?.input).toBe(1)
		expect(priceOf(prices, 'other', 'big')?.input).toBe(3)
		expect(priceOf(prices, 'cheap', 'unknown')?.input).toBe(9)
		expect(priceOf(prices, 'other', 'unknown')).toBeUndefined()
	})

	test('cached tokens are priced apart, and fall back to the input price', () => {
		const p = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
		// 1M input of which 400k read from cache and 100k written; 100k output.
		expect(costOf({ inputTokens: 1e6, outputTokens: 1e5, cacheReadTokens: 4e5, cacheWriteTokens: 1e5 }, p))
			.toBeCloseTo(0.5 * 3 + 0.4 * 0.3 + 0.1 * 3.75 + 0.1 * 15, 10)
		expect(costOf({ inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 1e6 }, { input: 2, output: 0 })).toBeCloseTo(2, 10)
		expect(costOf({ inputTokens: 1e6, outputTokens: 1e6 }, undefined)).toBe(0)
	})
})

describe('recording', () => {
	test('each call is recorded with its tokens and cost; the caller\'s onUsage still runs', async () => {
		const { ai, mock, store } = setup({ prices: { 'cheap:small': { input: 1, output: 2 } } })
		mock.enqueue({ text: 'ok', usage: { inputTokens: 1000, outputTokens: 500 } })
		const seen: number[] = []
		await ai.complete({ ...msg(), onUsage: (u) => seen.push(u.inputTokens) })
		expect(seen).toEqual([1000])
		const [e] = (store as MemoryUsageStore).entries
		expect(e).toMatchObject({ user: 'alice', provider: 'cheap', task: 'triage', model: 'small', inputTokens: 1000, outputTokens: 500, estimated: false })
		expect(e.cost).toBeCloseTo((1000 * 1 + 500 * 2) / 1e6, 12)
		expect(e.error).toBeUndefined()
	})

	test('streams are recorded once at the end, also when the consumer stops early', async () => {
		const { ai, mock, store } = setup()
		mock.enqueue({ text: 'one two three', usage: { inputTokens: 10, outputTokens: 3 } })
		for await (const _ of ai.stream(msg())) { /* drain */ }
		mock.enqueue({ text: 'a long story', usage: { inputTokens: 20, outputTokens: 5 } })
		for await (const ev of ai.stream(msg())) if (ev.type === 'text') break
		const es = (store as MemoryUsageStore).entries
		expect(es.length).toBe(2)
		expect(es[0]).toMatchObject({ inputTokens: 10, outputTokens: 3 })
		expect(es[0].error).toBeUndefined()
		expect(es[1].error).toBe('stopped')
		expect(es[1].estimated).toBe(true) // no usage sent on an early stop: estimated
		expect(es[1].inputTokens).toBeGreaterThan(0)
	})

	test('a server without usage: tokens are estimated (4 chars = 1 token) and flagged', async () => {
		const { budget, store } = setup()
		const body = { id: 'x', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'x'.repeat(40) }, finish_reason: 'stop' }] }
		const p = createProvider({ kind: 'openai-compatible', id: 'local', baseUrl: 'http://gw.test/v1', defaultModel: 'm' }, { fetch: fakeFetch(() => Response.json(body)).fetch })
		await budget.wrap(p, { user: 'alice', task: 'summary' }).complete(msg('y'.repeat(400)))
		const [e] = (store as MemoryUsageStore).entries
		expect(e.estimated).toBe(true)
		expect(e.inputTokens).toBe(100)
		expect(e.outputTokens).toBeGreaterThanOrEqual(10)
	})

	test('a failing store never breaks the call (the error goes to onError)', async () => {
		const store = new MemoryUsageStore()
		store.record = async () => { throw new Error('disk full') }
		const { ai, errors } = setup({}, store)
		const r = await ai.complete(msg())
		expect(r.text.length).toBeGreaterThan(0)
		expect(String(errors[0])).toContain('disk full')
	})
})

describe('caps', () => {
	test('daily cost cap for one task: refused before the call, other tasks still work, reopens at midnight', async () => {
		const { ai, mock, budget, clock } = setup({
			rules: [{ task: 'triage', dailyCost: 0.01 }],
			prices: { 'cheap:*': { input: 10, output: 10 } }, // $10 / M tokens
		})
		mock.enqueue({ text: 'a', usage: { inputTokens: 999, outputTokens: 0 } }) // $0.00999
		await ai.complete(msg())
		mock.enqueue({ text: 'b', usage: { inputTokens: 1, outputTokens: 0 } }) // reaches $0.01
		await ai.complete(msg())
		const sent = mock.requests.length
		const e = await ai.complete(msg()).catch((e) => e)
		expect(e).toBeInstanceOf(BudgetBlocked)
		expect(e).toBeInstanceOf(AiError)
		expect(e.code).toBe('budget')
		expect(e.reason).toBe('daily_cap')
		expect(e.until).toBe(nextDayStart(NOON))
		expect(e.message).toContain('daily cap reached')
		expect(mock.requests.length).toBe(sent) // the provider was not called

		const other = budget.wrap(mock, { user: 'alice', task: 'draft' })
		await other.complete(msg())
		const bob = budget.wrap(mock, { user: 'bob', task: 'triage' })
		await bob.complete(msg())

		clock.t = nextDayStart(NOON) + 1
		await ai.complete(msg())
	})

	test('monthly token cap on a provider, across tasks; stream refused before any event', async () => {
		const { mock, budget, clock } = setup({ rules: [{ provider: 'cheap', monthlyTokens: 100 }] })
		const a = budget.wrap(mock, { user: 'alice', task: 'triage' })
		const b = budget.wrap(mock, { user: 'alice', task: 'summary' })
		mock.enqueue({ text: 'x', usage: { inputTokens: 60, outputTokens: 0 } })
		await a.complete(msg())
		mock.enqueue({ text: 'x', usage: { inputTokens: 30, outputTokens: 10 } })
		await b.complete(msg())
		const events: unknown[] = []
		const e = await (async () => { for await (const ev of b.stream(msg())) events.push(ev) })().catch((e) => e)
		expect(e).toBeInstanceOf(BudgetBlocked)
		expect(e.reason).toBe('monthly_cap')
		expect(e.until).toBe(nextMonthStart(NOON))
		expect(events).toEqual([])
		clock.t = nextMonthStart(NOON)
		await a.complete(msg())
	})

	test('rules are read at each call: raising a cap applies at once', async () => {
		const { ai, cfg } = setup({ rules: [{ dailyTokens: 1 }] })
		await ai.complete(msg())
		await expect(ai.complete(msg())).rejects.toBeInstanceOf(BudgetBlocked)
		cfg.rules = [{ dailyTokens: 1e9 }]
		await ai.complete(msg())
	})
})

describe('pauses on provider errors', () => {
	test('no credit: paused until midnight, for every task of that provider; other providers unaffected', async () => {
		const { ai, mock, budget, clock } = setup()
		mock.failNext('budget', { status: 402 })
		const e = await ai.complete(msg()).catch((e) => e)
		expect(e).toBeInstanceOf(AiError)
		expect(e).not.toBeInstanceOf(BudgetBlocked)
		const sent = mock.requests.length
		const other = budget.wrap(mock, { user: 'alice', task: 'draft' })
		const blocked = await other.complete(msg()).catch((e) => e)
		expect(blocked).toBeInstanceOf(BudgetBlocked)
		expect(blocked.reason).toBe('budget')
		expect(blocked.until).toBe(nextDayStart(NOON))
		expect(mock.requests.length).toBe(sent)

		const second = createProvider({ kind: 'mock', id: 'other' })
		await budget.wrap(second, { user: 'alice', task: 'triage' }).complete(msg())

		clock.t = nextDayStart(NOON)
		await ai.complete(msg())
	})

	test('bad key: paused 1 h; resume() lifts it by hand', async () => {
		const { ai, mock, budget, clock } = setup()
		mock.failNext('auth', { status: 401 })
		await ai.complete(msg()).catch(() => {})
		clock.t += 3599
		await expect(ai.complete(msg())).rejects.toBeInstanceOf(BudgetBlocked)
		await budget.resume('alice', 'cheap')
		await ai.complete(msg())
	})

	test('rate limit: paused Retry-After seconds', async () => {
		const { ai, mock, clock } = setup()
		mock.failNext('rate_limit', { status: 429, retryAfter: 20 })
		await ai.complete(msg()).catch(() => {})
		clock.t += 19
		await expect(ai.complete(msg())).rejects.toBeInstanceOf(BudgetBlocked)
		clock.t += 1
		await ai.complete(msg())
	})

	test('unavailable: backoff 30 s, 60 s, 120 s ..., reset by a success', async () => {
		expect([1, 2, 3, 7, 8, 50].map(backoff)).toEqual([30, 60, 120, 1800, 1800, 1800])
		const { ai, mock, clock, store } = setup()
		for (const wait of [30, 60, 120]) {
			mock.failNext('unavailable', { status: 503 })
			await ai.complete(msg()).catch(() => {})
			clock.t += wait - 1
			await expect(ai.complete(msg())).rejects.toBeInstanceOf(BudgetBlocked)
			clock.t += 1
		}
		await ai.complete(msg())
		expect(await store.getPause('alice', 'cheap')).toBeNull()
		mock.failNext('unavailable', { status: 503 })
		await ai.complete(msg()).catch(() => {})
		expect((await store.getPause('alice', 'cheap'))?.until).toBe(clock.t + 30)
	})

	test('invalid request and caller aborts: no pause', async () => {
		const { ai, mock, store } = setup()
		mock.failNext('invalid', { status: 400 })
		await ai.complete(msg()).catch(() => {})
		expect(await store.getPause('alice', 'cheap')).toBeNull()
		await ai.complete(msg())
	})

	test('a stream failing mid-way pauses and records its partial usage with the error code', async () => {
		const { budget, store } = setup()
		const cut = () => new Response(new ReadableStream({
			start(s) {
				s.enqueue(new TextEncoder().encode('data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":9,"output_tokens":1}}}\n\n'))
				s.enqueue(new TextEncoder().encode('data: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n'))
				s.close()
			},
		}))
		const p = createProvider({ kind: 'anthropic', id: 'claude', apiKey: 'sk-test-fake', defaultModel: 'm' }, { fetch: fakeFetch(cut).fetch })
		const ai = budget.wrap(p, { user: 'alice', task: 'assistant' })
		await (async () => { for await (const _ of ai.stream(msg())) { /* */ } })().catch(() => {})
		const [e] = (store as MemoryUsageStore).entries
		expect(e).toMatchObject({ provider: 'claude', inputTokens: 9, outputTokens: 1, error: 'unavailable' })
		expect((await store.getPause('alice', 'claude'))?.reason).toBe('unavailable')
	})
})

test('summary: today, month, per provider and task, caps and live pauses', async () => {
	const { ai, mock, budget, clock } = setup({ rules: [{ task: 'triage', dailyTokens: 1000 }] })
	mock.enqueue({ text: 'x', usage: { inputTokens: 100, outputTokens: 10 } })
	await ai.complete(msg())
	clock.t += 86400 // tomorrow
	mock.enqueue({ text: 'x', usage: { inputTokens: 50, outputTokens: 5 } })
	await ai.complete(msg())
	mock.failNext('auth')
	await ai.complete(msg()).catch(() => {})
	const s = await budget.summary('alice', ['cheap', 'other'])
	expect(s.today.calls).toBe(1)
	expect(s.today.inputTokens).toBe(50)
	expect(s.month.inputTokens).toBe(150)
	expect(s.byTask).toEqual([{ provider: 'cheap', task: 'triage', calls: 2, inputTokens: 150, outputTokens: 15, cost: 0 }])
	expect(s.caps[0].today.inputTokens).toBe(50)
	expect(Object.keys(s.pauses)).toEqual(['cheap'])
})

describe('SqlUsageStore (sqlite)', () => {
	test('same behaviour as the memory store: record, totals, breakdown, pauses', async () => {
		const db = wrapDb(new Bun.SQL('sqlite://:memory:'), 'sqlite', 'oc_')
		const store = new SqlUsageStore(db)
		const { ai, mock, budget, clock } = setup({ rules: [{ task: 'triage', dailyCost: 0.002 }], prices: { small: { input: 1, output: 1 } } }, store)
		mock.enqueue({ text: 'x', usage: { inputTokens: 1500, outputTokens: 500 } })
		await ai.complete(msg())
		await expect(ai.complete(msg())).rejects.toBeInstanceOf(BudgetBlocked)
		const t = await store.totals({ user: 'alice', since: dayStart(clock.t) })
		expect(t).toEqual({ calls: 1, inputTokens: 1500, outputTokens: 500, cost: 0.002 })
		expect(await store.totals({ user: 'alice', task: 'draft', since: 0 })).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 })
		await budget.wrap(mock, { user: 'alice', task: 'draft' }).complete(msg())
		expect((await store.breakdown({ user: 'alice', since: 0 })).map((r) => r.task)).toEqual(['draft', 'triage'])

		mock.failNext('auth')
		await budget.wrap(mock, { user: 'alice', task: 'draft' }).complete(msg()).catch(() => {})
		expect(await store.getPause('alice', 'cheap')).toMatchObject({ reason: 'auth', until: clock.t + 3600, failures: 0 })
		await budget.resume('alice', 'cheap')
		expect(await store.getPause('alice', 'cheap')).toBeNull()
		await db.q("SELECT 1 FROM oc_atrium_ai_usage WHERE estimated = 0 AND error IS NULL")
		await db.close()
	})
})
