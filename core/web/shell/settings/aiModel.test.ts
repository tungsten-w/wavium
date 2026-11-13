// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'vitest'
import { type AiOverview, defaultChoices, emptyForm, formError, formFromView, type KindInfo, keyText, parseModels, payload, type ProviderView, testText } from './aiModel'

const kinds: KindInfo[] = [
	{ kind: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true },
	{ kind: 'openai-compatible', baseUrl: null, needsKey: false },
	{ kind: 'ollama', baseUrl: 'http://ollama:11434/v1', needsKey: false },
	{ kind: 'mock', baseUrl: null, needsKey: false },
]
const view = (p: Partial<ProviderView> = {}): ProviderView => ({
	id: 'aip_1', scope: 'user', label: 'Claude', kind: 'anthropic', baseUrl: null, defaultModel: 'claude-x', models: ['a', 'b'],
	enabled: true, hasKey: true, keyHint: 'WXYZ', updatedAt: 1, editable: true, ...p,
})

describe('payload', () => {
	test('new provider: scope and null key when none typed', () => {
		const f = { ...emptyForm('instance', kinds), kind: 'ollama' as const }
		expect(payload(f, null)).toEqual({ kind: 'ollama', label: null, baseUrl: null, defaultModel: null, models: [], enabled: true, scope: 'instance', apiKey: null })
	})
	test('editing: the key is left out unless typed or removed', () => {
		const f = formFromView(view())
		expect(f.models).toBe('a, b')
		expect('apiKey' in payload(f, view())).toBe(false)
		expect('scope' in payload(f, view())).toBe(false)
		expect(payload({ ...f, apiKey: ' sk-new ' }, view()).apiKey).toBe('sk-new')
		expect(payload({ ...f, removeKey: true }, view()).apiKey).toBeNull()
	})
	test('models are split and deduplicated', () => {
		expect(parseModels('a, b  c,,a')).toEqual(['a', 'b', 'c'])
	})
})

test('formError', () => {
	const f = emptyForm('user', kinds)
	expect(f.kind).toBe('anthropic')
	expect(formError(f, kinds, null)).toMatch(/API key/)
	expect(formError({ ...f, apiKey: 'k' }, kinds, null)).toBeNull()
	expect(formError(formFromView(view()), kinds, view())).toBeNull() // stored key kept
	expect(formError({ ...formFromView(view()), removeKey: true }, kinds, view())).toMatch(/API key/)
	expect(formError({ ...formFromView(view({ kind: 'openai-compatible', baseUrl: 'https://x' })), kind: 'ollama' }, kinds, view({ kind: 'openai-compatible' }))).toMatch(/again/)
	expect(formError({ ...f, kind: 'openai-compatible' }, kinds, null)).toMatch(/base URL/)
	expect(formError({ ...f, kind: 'openai-compatible', baseUrl: 'llm.lan' }, kinds, null)).toMatch(/http/)
	expect(formError({ ...f, kind: 'mock' }, kinds, null)).toBeNull()
	expect(formError({ ...f, kind: 'mistral' }, kinds, null)).toMatch(/Choose/)
})

test('texts', () => {
	expect(keyText(view())).toBe('Key ••••WXYZ')
	expect(keyText(view({ keyHint: null }))).toBe('Key saved')
	expect(keyText(view({ hasKey: false, keyHint: null }))).toBe('No key')
	expect(testText({ ok: true, models: ['a', 'b'] })).toBe('Connected: 2 models available.')
	expect(testText({ ok: true, models: [] })).toBe('Connected.')
	expect(testText({ ok: false, error: { code: 'auth', message: 'anthropic: HTTP 401' } })).toBe('The key was refused: anthropic: HTTP 401')
	expect(testText({ ok: false })).toBe('Failed')
})

test('defaultChoices: enabled ones; personal only when allowed', () => {
	const o = { instance: [view({ id: 'i', label: 'Inst' }), view({ id: 'off', enabled: false })], mine: [view({ id: 'm', label: 'Mine' })], personalProviders: true } as AiOverview
	expect(defaultChoices(o)).toEqual([{ id: 'i', label: 'Inst (instance)' }, { id: 'm', label: 'Mine' }])
	expect(defaultChoices({ ...o, personalProviders: false }).map((c) => c.id)).toEqual(['i'])
})
