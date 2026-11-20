// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Model per task (PLAN P2-5): a small cheap model for triage, a bigger one for
// summaries, drafts and the assistant. Configurable: a plain map
// `task -> { provider, model }` plus the user's providers (from the P2-2
// settings) go in; the provider to call and the model to ask for come out.
//
// Which model a task gets, first match wins:
//   1. its route's model (routes[task].model)
//   2. the provider's defaultModel, when the task's tier is 'large'
//      (the default model is what the user picked for general use)
//   3. the suggested model of the provider kind for the task's tier
//   4. the provider's defaultModel, whatever the tier
// Which provider: routes[task].provider, else defaultProvider, else the first
// configured one. A route naming a provider that does not exist is an error,
// never a silent switch to another provider (keys and costs differ).
import { AiError } from './errors'
import { createProvider } from './index'
import type { AiProvider, AiRequest, ProviderConfig, ProviderDeps, ProviderKind } from './types'

/** Known tasks; any other string is allowed (it gets the 'large' tier). */
export type AiTask = 'triage' | 'summary' | 'draft' | 'assistant' | (string & {})

export type Tier = 'small' | 'large'

export interface TaskRoute {
	/** Id of a configured provider (ProviderConfig.id, or its kind when it has no id). */
	provider?: string
	/** Model name; left out = see the order above. */
	model?: string
}

export interface RoutingConfig {
	routes?: Partial<Record<AiTask, TaskRoute>>
	/** Provider for tasks without a route. Default: the first provider. */
	defaultProvider?: string
}

export const TASK_TIERS: Record<string, Tier> = {
	triage: 'small',
	summary: 'large',
	draft: 'large',
	assistant: 'large',
}

export const tierOf = (task: string): Tier => TASK_TIERS[task] ?? 'large'

/**
 * Suggestions shown in the settings page and used when nothing else names a
 * model. Only for kinds with a fixed catalogue; Ollama and OpenAI-compatible
 * gateways serve whatever was installed, so they rely on defaultModel.
 */
export const SUGGESTED_MODELS: Partial<Record<ProviderKind, Record<Tier, string>>> = {
	anthropic: { small: 'claude-haiku-5-5', large: 'claude-sonnet-5-5' },
	openai: { small: 'gpt-4.1-mini', large: 'gpt-4.1' },
	mistral: { small: 'mistral-small-latest', large: 'mistral-large-latest' },
}

export const providerId = (p: ProviderConfig) => p.id || p.kind

export interface ResolvedRoute {
	task: string
	tier: Tier
	provider: ProviderConfig
	model: string
	/** Where the model came from, for the settings page ("suggested" can be shown greyed). */
	modelFrom: 'route' | 'provider-default' | 'suggested'
	/** Where the provider came from. */
	providerFrom: 'route' | 'default' | 'first'
}

const invalid = (provider: string, msg: string) => new AiError('invalid', msg, provider)

/** Which provider and model a task uses. Throws AiError('invalid') with a message fit for the settings page. */
export function resolveRoute(task: string, cfg: RoutingConfig, providers: ProviderConfig[]): ResolvedRoute {
	if (!providers.length) throw invalid('ai', 'no AI provider is configured')
	const byId = new Map(providers.map((p) => [providerId(p), p]))
	const route = cfg.routes?.[task]
	let provider: ProviderConfig | undefined
	let providerFrom: ResolvedRoute['providerFrom']
	if (route?.provider) {
		provider = byId.get(route.provider)
		providerFrom = 'route'
		if (!provider) throw invalid(route.provider, `task "${task}" uses provider "${route.provider}", which is not configured`)
	} else if (cfg.defaultProvider) {
		provider = byId.get(cfg.defaultProvider)
		providerFrom = 'default'
		if (!provider) throw invalid(cfg.defaultProvider, `the default provider "${cfg.defaultProvider}" is not configured`)
	} else {
		provider = providers[0]
		providerFrom = 'first'
	}
	const id = providerId(provider)
	const tier = tierOf(task)
	const suggested = SUGGESTED_MODELS[provider.kind]?.[tier]
	const fixed = route?.model?.trim()
	let model: string | undefined
	let modelFrom: ResolvedRoute['modelFrom']
	if (fixed) {
		model = fixed
		modelFrom = 'route'
	} else if (tier === 'large' && provider.defaultModel) {
		model = provider.defaultModel
		modelFrom = 'provider-default'
	} else if (suggested) {
		model = suggested
		modelFrom = 'suggested'
	} else if (provider.defaultModel) {
		model = provider.defaultModel
		modelFrom = 'provider-default'
	} else if (provider.kind === 'mock') {
		model = 'mock'
		modelFrom = 'provider-default'
	} else {
		throw invalid(id, `no model for task "${task}": set one for this task or a default model on provider "${id}"`)
	}
	return { task, tier, provider, model, modelFrom, providerFrom }
}

/** Every known task's route, and the problems, for the settings page. */
export function describeRouting(cfg: RoutingConfig, providers: ProviderConfig[], tasks: string[] = Object.keys(TASK_TIERS)) {
	const routes: ResolvedRoute[] = []
	const problems: Array<{ task: string, message: string }> = []
	const all = [...new Set([...tasks, ...Object.keys(cfg.routes ?? {})])]
	for (const task of all) {
		try {
			routes.push(resolveRoute(task, cfg, providers))
		} catch (e) {
			if (!(e instanceof AiError)) throw e
			problems.push({ task, message: e.message })
		}
	}
	return { routes, problems }
}

/** A provider that fills in `model` on each request that has none. */
export function withModel(p: AiProvider, model: string): AiProvider {
	const fill = (req: AiRequest): AiRequest => (req.model ? req : { ...req, model })
	return {
		id: p.id,
		kind: p.kind,
		complete: (req) => p.complete(fill(req)),
		stream: (req) => p.stream(fill(req)),
		listModels: () => p.listModels(),
		testConnection: () => p.testConnection(),
	}
}

export interface RoutedProvider {
	route: ResolvedRoute
	ai: AiProvider
}

/**
 * The provider a feature calls for a task, model already chosen:
 *   const { ai } = providerForTask('triage', routing, providers)
 *   await ai.complete({ messages })   // no model needed
 * Budgets (P2-3) wrap the result: budget.wrap(ai, { user, task }).
 */
export function providerForTask(
	task: string,
	cfg: RoutingConfig,
	providers: ProviderConfig[],
	deps: ProviderDeps & { create?: (c: ProviderConfig, d: ProviderDeps) => AiProvider } = {},
): RoutedProvider {
	const route = resolveRoute(task, cfg, providers)
	const create = deps.create ?? createProvider
	return { route, ai: withModel(create(route.provider, deps), route.model) }
}
