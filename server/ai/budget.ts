// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Budgets and usage (PLAN P2-3): caps per day and per month for each provider
// and each task, a token and cost counter, and automatic pauses on errors.
//
// `budget.wrap(provider, { user, task })` returns an AiProvider with the same
// interface. Before each call it refuses (BudgetBlocked, an AiError 'budget')
// when the provider is paused or a cap is reached; after each call it records
// the tokens and the cost (AiRequest.onUsage, also for failed or aborted
// streams) and turns provider errors into pauses, the way TriageService does:
//   budget (no credit)  -> paused until the next local midnight
//   auth (bad key)      -> paused 1 h
//   rate_limit          -> paused Retry-After seconds (default: backoff)
//   unavailable         -> backoff 30 s, 60 s, ... up to 30 min; reset on success
//   invalid             -> no pause (our request is wrong, not the provider)
// Pauses are per user and provider: a bad key or no credit hits every task.
//
// Day and month boundaries are local time of the server process (TZ).
// Caps are checked before a call: calls already running when a cap is reached
// finish and are counted, so a cap can be passed by what was in flight.
import { AiError } from './errors'
import type { AiProvider, AiRequest, AiResult, AiStreamEvent, Usage } from './types'

/** Price in USD per million tokens. Cached parts fall back to the input price. */
export interface Price {
	input: number
	output: number
	cacheRead?: number
	cacheWrite?: number
}

/** "provider:model", "provider:*", "*:model" or "model" -> price. Most specific wins. */
export type PriceTable = Record<string, Price>

/** A cap on a scope. A field left out matches everything (no provider = all providers). */
export interface BudgetRule {
	provider?: string
	task?: string
	/** USD. */
	dailyCost?: number
	monthlyCost?: number
	/** Input + output tokens. */
	dailyTokens?: number
	monthlyTokens?: number
}

export interface UsageEntry {
	user: string
	provider: string
	task: string
	model: string
	/** Unix seconds. */
	at: number
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	/** USD; 0 when the model has no price. */
	cost: number
	/** True when the server sent no usage and the tokens were estimated (4 chars = 1 token). */
	estimated: boolean
	/** AiError code when the call failed, else undefined. */
	error?: string
}

export interface Totals { calls: number, inputTokens: number, outputTokens: number, cost: number }

export interface UsageFilter { user: string, provider?: string, task?: string, since: number }

export type PauseReason = 'budget' | 'auth' | 'rate_limit' | 'unavailable'

export interface Pause {
	/** Unix seconds; 0 = not paused (kept to remember the failure count). */
	until: number
	reason: PauseReason
	message: string
	/** Consecutive 'unavailable' failures, for the backoff. */
	failures: number
}

export interface UsageStore {
	record(e: UsageEntry): Promise<void>
	totals(f: UsageFilter): Promise<Totals>
	/** Totals grouped by provider and task (for a usage page). */
	breakdown(f: UsageFilter): Promise<Array<Totals & { provider: string, task: string }>>
	getPause(user: string, provider: string): Promise<Pause | null>
	setPause(user: string, provider: string, p: Pause | null): Promise<void>
}

export interface BudgetConfig {
	rules?: BudgetRule[]
	prices?: PriceTable
}

export interface BudgetOptions {
	/** Unix seconds; injected in tests. */
	now?: () => number
	/** Where a bookkeeping failure goes (never breaks the call). Default: console.error. */
	onError?: (e: unknown) => void
}

export interface WrapOptions {
	user: string
	/** What the call is for: 'triage', 'summary', 'draft', 'assistant', ... */
	task: string
}

export const AUTH_PAUSE_S = 3600
export const BACKOFF_BASE_S = 30
export const BACKOFF_MAX_S = 1800

/** Refused by Atrium before reaching the provider: a cap is reached or the provider is paused. */
export class BudgetBlocked extends AiError {
	constructor(
		provider: string,
		message: string,
		/** Unix seconds when calls may work again. */
		public until: number,
		public reason: PauseReason | 'daily_cap' | 'monthly_cap',
	) {
		super('budget', message, provider, undefined, undefined)
		this.name = 'BudgetBlocked'
	}

	override toJSON() {
		return { ...super.toJSON(), blocked: true, until: this.until, reason: this.reason }
	}
}

// ------------------------------------------------------------------- time

/** Unix seconds of local midnight starting the day of `t`. */
export function dayStart(t: number): number {
	const d = new Date(t * 1000)
	return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000)
}

export function nextDayStart(t: number): number {
	const d = new Date(t * 1000)
	return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() / 1000)
}

export function monthStart(t: number): number {
	const d = new Date(t * 1000)
	return Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000)
}

export function nextMonthStart(t: number): number {
	const d = new Date(t * 1000)
	return Math.floor(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() / 1000)
}

// ------------------------------------------------------------------- cost

export function priceOf(prices: PriceTable | undefined, provider: string, model: string): Price | undefined {
	if (!prices) return undefined
	return prices[`${provider}:${model}`] ?? prices[`*:${model}`] ?? prices[model] ?? prices[`${provider}:*`]
}

/** USD for one call. inputTokens includes the cached parts (types.ts). */
export function costOf(u: Pick<Usage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>, p: Price | undefined): number {
	if (!p) return 0
	const read = u.cacheReadTokens ?? 0
	const write = u.cacheWriteTokens ?? 0
	const plain = Math.max(0, u.inputTokens - read - write)
	const c = plain * p.input + read * (p.cacheRead ?? p.input) + write * (p.cacheWrite ?? p.input) + u.outputTokens * p.output
	return c / 1e6
}

/** Characters sent, for estimating tokens when the server reports none. */
export function requestChars(req: AiRequest): number {
	let n = req.system?.length ?? 0
	for (const m of req.messages) {
		if (typeof m.content === 'string') n += m.content.length
		else for (const b of m.content) n += b.type === 'text' ? b.text.length : b.type === 'tool_result' ? b.content.length : JSON.stringify(b.input ?? null).length
	}
	for (const t of req.tools ?? []) n += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length
	return n
}

const estimate = (chars: number) => Math.ceil(chars / 4)

// ------------------------------------------------------------------- budget

const matches = (r: BudgetRule, provider: string, task: string) =>
	(r.provider === undefined || r.provider === provider) && (r.task === undefined || r.task === task)

const fmt = (n: number) => (n < 1 ? n.toFixed(4) : n.toFixed(2))

export class Budget {
	private readonly now: () => number
	private readonly onError: (e: unknown) => void

	constructor(
		private readonly store: UsageStore,
		/** A function so settings changes (P2-2) apply at the next call. */
		private readonly config: () => BudgetConfig | Promise<BudgetConfig>,
		opts: BudgetOptions = {},
	) {
		this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
		this.onError = opts.onError ?? ((e) => console.error('[ai budget]', e))
	}

	/** Throws BudgetBlocked when a call for (user, provider, task) must not run now. */
	async check(user: string, provider: string, task: string): Promise<void> {
		const now = this.now()
		const pause = await this.store.getPause(user, provider)
		if (pause && pause.until > now) {
			throw new BudgetBlocked(provider, `${provider}: paused (${pause.reason}) until ${new Date(pause.until * 1000).toISOString()}: ${pause.message}`, pause.until, pause.reason)
		}
		const { rules = [] } = await this.config()
		for (const r of rules) {
			if (!matches(r, provider, task)) continue
			const scope = `${r.provider ?? 'all providers'} / ${r.task ?? 'all tasks'}`
			const filter = { user, provider: r.provider, task: r.task }
			if (r.dailyCost !== undefined || r.dailyTokens !== undefined) {
				const t = await this.store.totals({ ...filter, since: dayStart(now) })
				const over = r.dailyCost !== undefined && t.cost >= r.dailyCost
					? `$${fmt(t.cost)} of $${fmt(r.dailyCost)}`
					: r.dailyTokens !== undefined && t.inputTokens + t.outputTokens >= r.dailyTokens
						? `${t.inputTokens + t.outputTokens} of ${r.dailyTokens} tokens` : null
				if (over) throw new BudgetBlocked(provider, `${provider}: daily cap reached for ${scope} (${over})`, nextDayStart(now), 'daily_cap')
			}
			if (r.monthlyCost !== undefined || r.monthlyTokens !== undefined) {
				const t = await this.store.totals({ ...filter, since: monthStart(now) })
				const over = r.monthlyCost !== undefined && t.cost >= r.monthlyCost
					? `$${fmt(t.cost)} of $${fmt(r.monthlyCost)}`
					: r.monthlyTokens !== undefined && t.inputTokens + t.outputTokens >= r.monthlyTokens
						? `${t.inputTokens + t.outputTokens} of ${r.monthlyTokens} tokens` : null
				if (over) throw new BudgetBlocked(provider, `${provider}: monthly cap reached for ${scope} (${over})`, nextMonthStart(now), 'monthly_cap')
			}
		}
	}

	/** Records one call. Missing usage is estimated from the characters sent and received. */
	async record(user: string, provider: string, task: string, model: string, usage: Usage, chars: { in: number, out: number }, error?: string): Promise<UsageEntry> {
		const estimated = !usage.reported
		const u = estimated
			? { ...usage, inputTokens: usage.inputTokens || estimate(chars.in), outputTokens: usage.outputTokens || estimate(chars.out) }
			: usage
		const { prices } = await this.config()
		const entry: UsageEntry = {
			user, provider, task, model,
			at: this.now(),
			inputTokens: u.inputTokens,
			outputTokens: u.outputTokens,
			cacheReadTokens: u.cacheReadTokens ?? 0,
			cacheWriteTokens: u.cacheWriteTokens ?? 0,
			cost: costOf(u, priceOf(prices, provider, model)),
			estimated,
			...(error ? { error } : {}),
		}
		await this.store.record(entry)
		return entry
	}

	/** Pause (or not) after a provider error. */
	async onFailure(user: string, provider: string, e: AiError): Promise<void> {
		if (e instanceof BudgetBlocked) return
		const now = this.now()
		const prev = await this.store.getPause(user, provider)
		const failures = prev?.failures ?? 0
		let p: Pause | null = null
		switch (e.code) {
		case 'budget': p = { until: nextDayStart(now), reason: 'budget', message: e.message, failures }; break
		case 'auth': p = { until: now + AUTH_PAUSE_S, reason: 'auth', message: e.message, failures }; break
		case 'rate_limit': p = { until: now + (e.retryAfter ?? backoff(failures)), reason: 'rate_limit', message: e.message, failures }; break
		case 'unavailable': p = { until: now + (e.retryAfter ?? backoff(failures + 1)), reason: 'unavailable', message: e.message, failures: failures + 1 }; break
		case 'invalid': return
		}
		await this.store.setPause(user, provider, p)
	}

	async onSuccess(user: string, provider: string): Promise<void> {
		const prev = await this.store.getPause(user, provider)
		if (prev && (prev.failures > 0 || prev.until > 0)) await this.store.setPause(user, provider, null)
	}

	/** Lifts a pause by hand (settings page "resume" button). */
	resume(user: string, provider: string): Promise<void> {
		return this.store.setPause(user, provider, null)
	}

	/** What a usage page shows: today, this month, per provider and task, plus caps and pauses. */
	async summary(user: string, providers: string[] = []) {
		const now = this.now()
		const { rules = [] } = await this.config()
		const [today, month, byTask] = await Promise.all([
			this.store.totals({ user, since: dayStart(now) }),
			this.store.totals({ user, since: monthStart(now) }),
			this.store.breakdown({ user, since: monthStart(now) }),
		])
		const pauses: Record<string, Pause> = {}
		for (const id of providers) {
			const p = await this.store.getPause(user, id)
			if (p && p.until > now) pauses[id] = p
		}
		const caps = await Promise.all(rules.map(async (r) => {
			const f = { user, provider: r.provider, task: r.task }
			const [d, m] = await Promise.all([
				this.store.totals({ ...f, since: dayStart(now) }),
				this.store.totals({ ...f, since: monthStart(now) }),
			])
			return { rule: r, today: d, month: m }
		}))
		return { today, month, byTask, caps, pauses }
	}

	/** The same provider, with checks before and bookkeeping after each call. */
	wrap(p: AiProvider, { user, task }: WrapOptions): AiProvider {
		const self = this
		const safe = async (f: () => Promise<unknown>) => {
			try { await f() } catch (e) { this.onError(e) }
		}
		// outcome: 'ok', 'stopped' (the consumer left a stream early), or the error thrown.
		const after = async (req: AiRequest, model: string, usage: Usage | undefined, outChars: number, outcome: unknown) => {
			const error = outcome === 'ok' ? undefined : outcome === 'stopped' ? 'stopped' : outcome instanceof AiError ? outcome.code : 'aborted'
			if (usage) await safe(() => self.record(user, p.id, task, model, usage, { in: requestChars(req), out: outChars }, error))
			if (outcome instanceof AiError) await safe(() => self.onFailure(user, p.id, outcome))
			else if (outcome === 'ok') await safe(() => self.onSuccess(user, p.id))
		}
		const withSink = (req: AiRequest) => {
			const box: { usage?: Usage } = {}
			const r: AiRequest = { ...req, onUsage: (u) => { box.usage = u; req.onUsage?.(u) } }
			return { r, box }
		}
		return {
			id: p.id,
			kind: p.kind,
			listModels: () => p.listModels(),
			testConnection: () => p.testConnection(),
			async complete(req: AiRequest): Promise<AiResult> {
				await self.check(user, p.id, task)
				const { r, box } = withSink(req)
				let res: AiResult | undefined
				try {
					res = await p.complete(r)
					return res
				} catch (e) {
					await after(req, req.model ?? '', box.usage, 0, e)
					throw e
				} finally {
					if (res) await after(req, res.model, box.usage ?? res.usage, res.text.length + JSON.stringify(res.toolCalls).length, 'ok')
				}
			},
			async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
				await self.check(user, p.id, task)
				const { r, box } = withSink(req)
				let out = 0
				let model = req.model ?? ''
				let outcome: unknown = 'stopped'
				try {
					for await (const ev of p.stream(r)) {
						if (ev.type === 'text') out += ev.text.length
						else if (ev.type === 'tool_call') out += JSON.stringify(ev.call).length
						else { model = ev.result.model; outcome = 'ok' }
						yield ev
					}
				} catch (e) {
					outcome = e
					throw e
				} finally {
					// A consumer that stops early (break) is not a provider error: no pause.
					// Providers send no usage then (onUsage only fires on done or on an
					// error), but tokens were spent: estimate them from the characters.
					const usage = box.usage ?? (outcome === 'stopped' ? { inputTokens: 0, outputTokens: 0, reported: false } : undefined)
					await after(req, model, usage, out, outcome)
				}
			},
		}
	}
}

/** 30 s, 60 s, 120 s, ... capped at 30 min (TriageService's backoff). */
export function backoff(failures: number): number {
	return Math.min(BACKOFF_MAX_S, BACKOFF_BASE_S * 2 ** Math.min(Math.max(failures - 1, 0), 6))
}

// ------------------------------------------------------------------- memory store

/** In-memory store: tests, and a fallback when there is no database. */
export class MemoryUsageStore implements UsageStore {
	readonly entries: UsageEntry[] = []
	private pauses = new Map<string, Pause>()

	async record(e: UsageEntry) { this.entries.push({ ...e }) }

	private pick(f: UsageFilter) {
		return this.entries.filter((e) => e.user === f.user && e.at >= f.since
			&& (f.provider === undefined || e.provider === f.provider) && (f.task === undefined || e.task === f.task))
	}

	async totals(f: UsageFilter): Promise<Totals> {
		return sum(this.pick(f))
	}

	async breakdown(f: UsageFilter) {
		const groups = new Map<string, UsageEntry[]>()
		for (const e of this.pick(f)) {
			const k = JSON.stringify([e.provider, e.task])
			groups.set(k, [...(groups.get(k) ?? []), e])
		}
		return [...groups].map(([k, es]) => {
			const [provider, task] = JSON.parse(k) as [string, string]
			return { provider, task, ...sum(es) }
		})
	}

	async getPause(user: string, provider: string) {
		const p = this.pauses.get(JSON.stringify([user, provider]))
		return p ? { ...p } : null
	}

	async setPause(user: string, provider: string, p: Pause | null) {
		const k = JSON.stringify([user, provider])
		if (p) this.pauses.set(k, { ...p })
		else this.pauses.delete(k)
	}
}

function sum(es: UsageEntry[]): Totals {
	const t: Totals = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 }
	for (const e of es) {
		t.calls++
		t.inputTokens += e.inputTokens
		t.outputTokens += e.outputTokens
		t.cost += e.cost
	}
	return t
}
