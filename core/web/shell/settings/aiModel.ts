// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > AI (P2-2): types of the /agent/v1/ai API and the form logic,
// kept out of the component so it can be tested without a DOM.

export type ProviderKind = 'anthropic' | 'openai' | 'mistral' | 'openai-compatible' | 'ollama' | 'mock'
export type Scope = 'instance' | 'user'

export interface ProviderView {
	id: string
	scope: Scope
	label: string
	kind: ProviderKind
	baseUrl: string | null
	defaultModel: string | null
	models: string[]
	enabled: boolean
	hasKey: boolean
	keyHint: string | null
	updatedAt: number
	editable: boolean
}

export interface KindInfo { kind: ProviderKind, baseUrl: string | null, needsKey: boolean }

export interface AiOverview {
	isAdmin: boolean
	personalProviders: boolean
	kinds: KindInfo[]
	instance: ProviderView[]
	mine: ProviderView[]
	defaultProvider: string | null
	instanceDefault: string | null
	effectiveDefault: string | null
}

export interface ConnectionTest { ok: boolean, error?: { code: string, message: string }, models?: string[] }

export const kindLabels: Record<ProviderKind, string> = {
	anthropic: 'Anthropic (Claude)',
	openai: 'OpenAI',
	mistral: 'Mistral',
	'openai-compatible': 'OpenAI-compatible (LiteLLM, vLLM, OpenRouter...)',
	ollama: 'Ollama',
	mock: 'Mock (test only, no network)',
}

/** Where to get a key, shown under the key field. */
export const keyHelp: Partial<Record<ProviderKind, string>> = {
	anthropic: 'Create one at console.anthropic.com > API keys.',
	openai: 'Create one at platform.openai.com > API keys.',
	mistral: 'Create one at console.mistral.ai > API keys.',
	'openai-compatible': 'Only if your server asks for one.',
}

export interface ProviderForm {
	scope: Scope
	kind: ProviderKind
	label: string
	baseUrl: string
	/** What the user typed; empty = keep the stored key. */
	apiKey: string
	removeKey: boolean
	defaultModel: string
	/** Comma- or space-separated. */
	models: string
	enabled: boolean
}

export function emptyForm(scope: Scope, kinds: KindInfo[]): ProviderForm {
	const kind = kinds.find((k) => k.kind === 'anthropic')?.kind ?? kinds[0]?.kind ?? 'anthropic'
	return { scope, kind, label: '', baseUrl: '', apiKey: '', removeKey: false, defaultModel: '', models: '', enabled: true }
}

export function formFromView(p: ProviderView): ProviderForm {
	return {
		scope: p.scope,
		kind: p.kind,
		label: p.label,
		baseUrl: p.baseUrl ?? '',
		apiKey: '',
		removeKey: false,
		defaultModel: p.defaultModel ?? '',
		models: p.models.join(', '),
		enabled: p.enabled,
	}
}

export const parseModels = (s: string): string[] => [...new Set(s.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean))]

/**
 * Body for POST/PATCH and for "test". The key is sent only when typed (or
 * null to remove it); editing without typing it keeps the stored one.
 */
export function payload(form: ProviderForm, editing: ProviderView | null): Record<string, unknown> {
	const body: Record<string, unknown> = {
		kind: form.kind,
		label: form.label.trim() || null,
		baseUrl: form.baseUrl.trim() || null,
		defaultModel: form.defaultModel.trim() || null,
		models: parseModels(form.models),
		enabled: form.enabled,
	}
	if (!editing) body.scope = form.scope
	if (form.apiKey.trim()) body.apiKey = form.apiKey.trim()
	else if (form.removeKey || !editing) body.apiKey = null
	return body
}

/** Client-side check before sending (the server checks again). Null = fine. */
export function formError(form: ProviderForm, kinds: KindInfo[], editing: ProviderView | null): string | null {
	const info = kinds.find((k) => k.kind === form.kind)
	if (!info) return 'Choose a provider'
	const keyKept = !!editing?.hasKey && !form.removeKey && editing.kind === form.kind
	if (info.needsKey && !form.apiKey.trim() && !keyKept) return 'This provider needs an API key'
	if (editing?.hasKey && editing.kind !== form.kind && !form.apiKey.trim()) return 'Enter the API key again when changing the provider'
	if (!info.baseUrl && form.kind !== 'mock' && !form.baseUrl.trim()) return 'This provider needs a base URL'
	if (form.baseUrl.trim() && !/^https?:\/\/[^\s/]+/i.test(form.baseUrl.trim())) return 'The base URL must start with http:// or https://'
	return null
}

/** "Key ••••WXYZ", "Key saved" or "No key". */
export const keyText = (p: Pick<ProviderView, 'hasKey' | 'keyHint'>): string =>
	(p.hasKey ? (p.keyHint ? `Key ••••${p.keyHint}` : 'Key saved') : 'No key')

export function testText(t: ConnectionTest): string {
	if (t.ok) {
		const n = t.models?.length ?? 0
		return n ? `Connected: ${n} model${n > 1 ? 's' : ''} available.` : 'Connected.'
	}
	const why: Record<string, string> = {
		auth: 'The key was refused',
		budget: 'No credit left on this account',
		rate_limit: 'Too many requests, try again in a moment',
		unavailable: 'The server did not answer',
		invalid: 'The settings are not valid',
	}
	const head = why[t.error?.code ?? ''] ?? 'Failed'
	return t.error?.message ? `${head}: ${t.error.message}` : head
}

/** Every provider the user may pick as their default, with its label. */
export function defaultChoices(o: AiOverview): Array<{ id: string, label: string }> {
	const usable = (p: ProviderView) => p.enabled
	return [
		...o.instance.filter(usable).map((p) => ({ id: p.id, label: `${p.label} (instance)` })),
		...(o.personalProviders ? o.mine.filter(usable).map((p) => ({ id: p.id, label: p.label })) : []),
	]
}
