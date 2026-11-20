// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Model per task (P2-5). Fake keys and the mock provider only (rule A2).
import { describe, expect, test } from 'bun:test'
import { AiError, createProvider } from './index'
import { describeRouting, providerForTask, resolveRoute, tierOf, withModel } from './routing'
import { fakeFetch } from './testkit'
import type { ProviderConfig } from './types'

const claude: ProviderConfig = { kind: 'anthropic', id: 'claude', apiKey: 'sk-test-fake', defaultModel: 'claude-opus-x' }
const local: ProviderConfig = { kind: 'ollama', id: 'local', defaultModel: 'llama-local' }
const gw: ProviderConfig = { kind: 'openai-compatible', id: 'gw', baseUrl: 'http://gw.test/v1' }
const msg = { messages: [{ role: 'user' as const, content: 'hi' }] }

describe('resolveRoute', () => {
	test('tiers: triage is small, the rest (and unknown tasks) large', () => {
		expect(['triage', 'summary', 'draft', 'assistant', 'something-new'].map(tierOf)).toEqual(['small', 'large', 'large', 'large', 'large'])
	})

	test('no routes: first provider; triage gets the small suggested model, others the provider default', () => {
		expect(resolveRoute('triage', {}, [claude, local])).toMatchObject({ provider: claude, model: 'claude-haiku-5-5', modelFrom: 'suggested', providerFrom: 'first', tier: 'small' })
		expect(resolveRoute('summary', {}, [claude, local])).toMatchObject({ model: 'claude-opus-x', modelFrom: 'provider-default' })
	})

	test('a large task without a provider default gets the large suggestion', () => {
		const p = { ...claude, defaultModel: undefined }
		expect(resolveRoute('draft', {}, [p])).toMatchObject({ model: 'claude-sonnet-5-5', modelFrom: 'suggested' })
	})

	test('routes win: provider and model per task', () => {
		const cfg = { routes: { triage: { provider: 'local', model: 'qwen-small' }, draft: { provider: 'claude' } } }
		expect(resolveRoute('triage', cfg, [claude, local])).toMatchObject({ provider: local, model: 'qwen-small', modelFrom: 'route', providerFrom: 'route' })
		expect(resolveRoute('draft', cfg, [claude, local])).toMatchObject({ provider: claude, model: 'claude-opus-x' })
	})

	test('defaultProvider for tasks without a route', () => {
		expect(resolveRoute('summary', { defaultProvider: 'local' }, [claude, local])).toMatchObject({ provider: local, providerFrom: 'default', model: 'llama-local' })
	})

	test('kinds without a catalogue fall back to their default model for small tasks too', () => {
		expect(resolveRoute('triage', {}, [local])).toMatchObject({ model: 'llama-local', modelFrom: 'provider-default' })
	})

	test('a provider without an id is addressed by its kind', () => {
		const anon: ProviderConfig = { kind: 'mistral', apiKey: 'fake' }
		expect(resolveRoute('triage', { routes: { triage: { provider: 'mistral' } } }, [claude, anon])).toMatchObject({ provider: anon, model: 'mistral-small-latest' })
	})

	test('errors are explicit, never a silent switch to another provider', () => {
		const err = (f: () => unknown) => { try { f() } catch (e) { return e as AiError } throw new Error('no error') }
		const e1 = err(() => resolveRoute('triage', { routes: { triage: { provider: 'gone' } } }, [claude]))
		expect(e1).toBeInstanceOf(AiError)
		expect(e1.code).toBe('invalid')
		expect(e1.message).toContain('"gone"')
		expect(err(() => resolveRoute('triage', { defaultProvider: 'gone' }, [claude])).message).toContain('default provider')
		expect(err(() => resolveRoute('triage', {}, [])).message).toContain('no AI provider')
		expect(err(() => resolveRoute('summary', {}, [gw])).message).toContain('no model for task "summary"')
	})

	test('a blank model in a route is ignored', () => {
		expect(resolveRoute('summary', { routes: { summary: { model: '  ' } } }, [claude])).toMatchObject({ model: 'claude-opus-x' })
	})
})

test('describeRouting: every known task plus routed custom ones, problems listed apart', () => {
	const { routes, problems } = describeRouting({ routes: { summary: { provider: 'gone' }, 'mail-reply': { provider: 'local' } } }, [claude, local])
	expect(routes.map((r) => [r.task, r.provider.id, r.model])).toEqual([
		['triage', 'claude', 'claude-haiku-5-5'],
		['draft', 'claude', 'claude-opus-x'],
		['assistant', 'claude', 'claude-opus-x'],
		['mail-reply', 'local', 'llama-local'],
	])
	expect(problems).toEqual([{ task: 'summary', message: 'task "summary" uses provider "gone", which is not configured' }])
})

describe('providerForTask', () => {
	test('the request goes to the routed provider with the routed model; an explicit model still wins', async () => {
		const f = fakeFetch(
			() => Response.json({ id: 'x', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
			() => Response.json({ id: 'y', model: 'other', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
		)
		const { ai, route } = providerForTask('triage', {}, [claude, local], { fetch: f.fetch })
		expect(route.model).toBe('claude-haiku-5-5')
		expect(ai.id).toBe('claude')
		await ai.complete(msg)
		await ai.complete({ ...msg, model: 'other' })
		expect(f.calls.map((c) => c.body.model)).toEqual(['claude-haiku-5-5', 'other'])
	})

	test('streams get the model too; works with the mock and an injected factory', async () => {
		const mock = createProvider({ kind: 'mock', id: 'm' })
		const { ai } = providerForTask('summary', { routes: { summary: { model: 'big-one' } } }, [{ kind: 'mock', id: 'm' }], { create: () => mock })
		for await (const _ of ai.stream(msg)) { /* drain */ }
		expect(mock.requests[0].model).toBe('big-one')
	})

	test('withModel keeps the request otherwise unchanged', async () => {
		const mock = createProvider({ kind: 'mock' })
		await withModel(mock, 'x').complete({ ...msg, system: 'sys', maxTokens: 7 })
		expect(mock.requests[0]).toMatchObject({ model: 'x', system: 'sys', maxTokens: 7 })
	})
})
