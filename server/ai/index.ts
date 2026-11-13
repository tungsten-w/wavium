// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI provider layer (PLAN P2-1): one interface for Anthropic, OpenAI, Mistral,
// any OpenAI-compatible endpoint, Ollama and a mock. Not wired anywhere yet;
// settings (P2-2), budgets (P2-3) and the features build on createProvider().
import { anthropicProvider } from './anthropic'
import type { Resolved } from './common'
import { AiError, redactor } from './errors'
import { createMockProvider, type MockProvider } from './mock'
import { openaiProvider } from './openai'
import type { AiProvider, AiRequest, ProviderConfig, ProviderDeps, ProviderKind } from './types'

export * from './types'
export { AiError, type AiErrorCode } from './errors'
export { createMockProvider, type MockProvider, type MockReply, type MockScript } from './mock'

export const DEFAULT_TIMEOUT_MS = 120_000

interface KindInfo { baseUrl?: string, needsKey: boolean }

export const KINDS: Record<ProviderKind, KindInfo> = {
	anthropic: { baseUrl: 'https://api.anthropic.com', needsKey: true },
	openai: { baseUrl: 'https://api.openai.com/v1', needsKey: true },
	mistral: { baseUrl: 'https://api.mistral.ai/v1', needsKey: true },
	// Local gateways (LiteLLM, vLLM) often run without a key.
	'openai-compatible': { needsKey: false },
	ollama: { baseUrl: 'http://ollama:11434/v1', needsKey: false },
	mock: { needsKey: false },
}

const invalid = (provider: string, msg: string) => new AiError('invalid', `${provider}: ${msg}`, provider)

/** Checks a config and fills the defaults; throws AiError('invalid') with a message fit for the settings page. */
export function resolveConfig(config: ProviderConfig, deps: ProviderDeps = {}): Resolved {
	const kind = config?.kind
	const info = KINDS[kind as ProviderKind]
	const id = config?.id || String(kind ?? 'ai')
	if (!info) throw invalid(id, `unknown provider kind "${String(kind)}" (expected one of ${Object.keys(KINDS).join(', ')})`)
	const apiKey = config.apiKey?.trim() || undefined
	if (info.needsKey && !apiKey) throw invalid(id, `an API key is required for ${kind}`)
	const baseUrl = (config.baseUrl?.trim() || info.baseUrl || '').replace(/\/+$/, '')
	if (!baseUrl) throw invalid(id, `a base URL is required for ${kind}`)
	let url: URL
	try {
		url = new URL(baseUrl)
	} catch {
		throw invalid(id, `base URL "${baseUrl}" is not a URL`)
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid(id, 'base URL must be http or https')
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
	if (!(timeoutMs > 0)) throw invalid(id, 'timeoutMs must be positive')
	const fetchFn = deps.fetch ?? ((u: string, init?: RequestInit) => fetch(u, init))
	return {
		id,
		kind,
		baseUrl,
		apiKey,
		headers: { ...config.headers },
		http: { provider: id, fetch: fetchFn, timeoutMs, redact: redactor(apiKey) },
		model(req: AiRequest) {
			const m = req.model || config.defaultModel
			if (!m) throw invalid(id, 'no model given and no default model configured')
			return m
		},
	}
}

export function createProvider(config: ProviderConfig & { kind: 'mock' }, deps?: ProviderDeps): MockProvider
export function createProvider(config: ProviderConfig, deps?: ProviderDeps): AiProvider
export function createProvider(config: ProviderConfig, deps: ProviderDeps = {}): AiProvider {
	if (config?.kind === 'mock') return createMockProvider({ id: config.id, defaultModel: config.defaultModel })
	const r = resolveConfig(config, deps)
	return r.kind === 'anthropic' ? anthropicProvider(r) : openaiProvider(r)
}
