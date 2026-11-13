// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// POST /agent/v1/internal/ai/triage (P2-4): the statuses TriageService acts on.
// Mock provider, in-memory usage store, fake settings (rule A2).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { internalCheck } from '../agent/ai'
import { internalHeaderValue } from '../agent/phpcall'
import { Budget, type BudgetConfig, MemoryUsageStore } from './budget'
import { createMockProvider, type MockProvider } from './index'
import type { AiSettings } from './settings'
import { handleTriage, TRIAGE_PATH } from './triage-route'
import type { ProviderConfig } from './types'

const SECRET = 'test-secret-not-real'
const NOW = 1_800_000_000
const questions = JSON.parse(readFileSync(join(import.meta.dir, '../../apps/mail/lib/Service/Triage/questions.json'), 'utf8')).questions

function setup(opts: { providers?: Array<ProviderConfig & { id: string, scope: 'instance' | 'user' }>, budget?: BudgetConfig } = {}) {
	const providers = opts.providers ?? [{ id: 'inst', kind: 'mock', scope: 'instance', defaultModel: 'mock-big' }]
	const mocks = new Map<string, MockProvider>()
	const asked: Array<{ uid: string, id?: string }> = []
	const settings = {
		async config(_uid: string) { return { providers, defaultProvider: providers[0]?.id ?? null } },
		async provider(uid: string, id?: string) {
			asked.push({ uid, id })
			const p = providers.find((x) => x.id === id)
			if (!p) return null
			if (!mocks.has(p.id)) mocks.set(p.id, createMockProvider({ id: p.id, defaultModel: p.defaultModel }))
			return mocks.get(p.id)!
		},
	} as unknown as AiSettings
	const store = new MemoryUsageStore()
	const clock = { t: NOW }
	const budget = new Budget(store, () => opts.budget ?? {}, { now: () => clock.t, onError: () => {} })
	const mock = () => mocks.get(providers[0].id) ?? (settings.provider('x', providers[0].id), mocks.get(providers[0].id)!)
	const call = (body: unknown, headers: Record<string, string> = { 'x-atrium-internal': internalHeaderValue(SECRET) }, method = 'POST') =>
		handleTriage({ settings, budget, internal: internalCheck(SECRET), now: () => clock.t }, new Request(`http://web${TRIAGE_PATH}`, {
			method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'POST' ? JSON.stringify(body) : undefined,
		}))
	return { call, store, mock, asked, clock }
}

const body = { uid: 'alice', input: 'From: bank\nSubject: Pay now\n\nPlease pay', questions }

describe('internal triage route', () => {
	test('internal only: no header, a wrong one, GET', async () => {
		const { call, asked } = setup()
		expect((await call(body, {})).status).toBe(403)
		expect((await call(body, { 'x-atrium-internal': internalHeaderValue('other-secret') })).status).toBe(403)
		expect((await call(body, { 'x-atrium-internal': 'short' })).status).toBe(403)
		expect((await call(null, undefined, 'GET')).status).toBe(405)
		expect(asked).toEqual([])
	})

	test('bad bodies are 400', async () => {
		const { call } = setup()
		for (const b of [{ ...body, uid: '' }, { ...body, input: ' ' }, { ...body, questions: [] }, { ...body, questions: 'x' }]) {
			expect((await call(b)).status).toBe(400)
		}
	})

	test('200: decisions as the owner, small model for triage, usage recorded under task triage', async () => {
		const { call, store, mock, asked } = setup({ providers: [{ id: 'oa', kind: 'openai', scope: 'instance', apiKey: 'sk-fake', defaultModel: 'gpt-4.1' }] })
		const res = await call(body)
		expect(res.status).toBe(200)
		const d = await res.json() as any
		expect(asked).toEqual([{ uid: 'alice', id: 'oa' }])
		expect(d.answers).toHaveLength(7)
		expect(d.answers[0]).toMatchObject({ name: 'category', type: 'choice' })
		// P2-5: triage is "small" -> the suggested small model, not the provider's big default.
		expect(d.route).toEqual({ model: 'gpt-4.1-mini', modelFrom: 'suggested' })
		expect(d.providerLabel).toBe('oa') // no label in this fake: falls back to the id
		expect(mock().requests[0].model).toBe('gpt-4.1-mini')
		expect(d.usage.input_tokens).toBeGreaterThan(0)
		const t = await store.totals({ user: 'alice', task: 'triage', since: 0 })
		expect(t.calls).toBe(1)
		expect(t.inputTokens).toBe(d.usage.input_tokens)
	})

	test('409 when the user has no AI', async () => {
		const { call } = setup({ providers: [] })
		const res = await call(body)
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({ code: 'not_configured' })
		expect(((await (await call(body)).json()) as any).message).toContain('Settings > AI')
	})

	test('402 with until when a cap is reached (no provider call)', async () => {
		const { call, store, mock } = setup({ budget: { rules: [{ task: 'triage', dailyTokens: 10 }] } })
		await store.record({ user: 'alice', provider: 'inst', task: 'triage', model: 'm', at: NOW - 60, inputTokens: 50, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, estimated: false })
		const res = await call(body)
		expect(res.status).toBe(402)
		const b = await res.json() as any
		expect(b).toMatchObject({ code: 'budget', reason: 'daily_cap' })
		expect(b.until).toBeGreaterThan(NOW)
		expect(mock().requests).toHaveLength(0)
	})

	test('provider errors -> 401 / 429 / 503 / 402, and a paused provider stays refused with its until', async () => {
		const { call, mock, clock } = setup()
		const cases: Array<[Parameters<MockProvider['failNext']>, number, string]> = [
			[['rate_limit', { retryAfter: 30 }], 429, 'rate_limit'],
			[['unavailable'], 503, 'unavailable'],
			[['budget'], 402, 'budget'],
			[['auth'], 401, 'unauthorized'],
		]
		for (const [args, status, code] of cases) {
			clock.t += 3 * 86400 // past the previous pause
			mock().failNext(...args)
			const res = await call(body)
			expect(res.status).toBe(status)
			const b = await res.json() as any
			expect(b.code).toBe(code)
			if (code === 'rate_limit') expect(b.until).toBe(clock.t + 30)
		}
		// After the auth error the provider is paused 1 h: refused before any call, as 401.
		const n = mock().requests.length
		const res = await call(body)
		expect(res.status).toBe(401)
		expect(((await res.json()) as any).until).toBe(clock.t + 3600)
		expect(mock().requests.length).toBe(n)
	})

	test('422 when the model keeps answering badly', async () => {
		const { call, mock } = setup()
		mock().enqueue({ text: 'admin' }, { text: 'still no tool' })
		const res = await call(body)
		expect(res.status).toBe(422)
		expect(await res.json()).toMatchObject({ code: 'invalid' })
	})
})
