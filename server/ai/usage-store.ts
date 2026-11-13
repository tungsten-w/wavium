// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UsageStore on Nextcloud's database (same Db as the agent layer: Postgres or
// sqlite). Its two tables are created here, not in server/agent/db.ts, so the
// AI layer stays independent of the agent migrations:
//   <prefix>atrium_ai_usage  one row per AI call (tokens, cost, estimated, error)
//   <prefix>atrium_ai_pause  one row per (user, provider) pause / failure count
import type { Db } from '../agent/db'
import { num } from '../agent/db'
import type { Pause, PauseReason, Totals, UsageEntry, UsageFilter, UsageStore } from './budget'

export class SqlUsageStore implements UsageStore {
	private ready?: Promise<void>

	constructor(private readonly db: Db) {}

	/** Creates the tables once (idempotent). */
	ensure(): Promise<void> {
		this.ready ??= (async () => {
			const db = this.db
			const id = db.dialect === 'pg' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'
			const real = db.dialect === 'pg' ? 'DOUBLE PRECISION' : 'REAL'
			await db.q(`CREATE TABLE IF NOT EXISTS ${db.t('atrium_ai_usage')} (
				id ${id},
				uid VARCHAR(64) NOT NULL,
				provider VARCHAR(64) NOT NULL,
				task VARCHAR(64) NOT NULL,
				model VARCHAR(255) NOT NULL,
				at BIGINT NOT NULL,
				input_tokens BIGINT NOT NULL,
				output_tokens BIGINT NOT NULL,
				cache_read_tokens BIGINT NOT NULL DEFAULT 0,
				cache_write_tokens BIGINT NOT NULL DEFAULT 0,
				cost ${real} NOT NULL DEFAULT 0,
				estimated SMALLINT NOT NULL DEFAULT 0,
				error VARCHAR(32)
			)`)
			await db.q(`CREATE INDEX IF NOT EXISTS ${db.t('atrium_ai_usage_uid_at')} ON ${db.t('atrium_ai_usage')} (uid, at)`)
			await db.q(`CREATE TABLE IF NOT EXISTS ${db.t('atrium_ai_pause')} (
				uid VARCHAR(64) NOT NULL,
				provider VARCHAR(64) NOT NULL,
				until_at BIGINT NOT NULL,
				reason VARCHAR(32) NOT NULL,
				message TEXT NOT NULL,
				failures INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (uid, provider)
			)`)
		})()
		this.ready.catch(() => { this.ready = undefined })
		return this.ready
	}

	async record(e: UsageEntry): Promise<void> {
		await this.ensure()
		await this.db.q(`INSERT INTO ${this.db.t('atrium_ai_usage')}
			(uid, provider, task, model, at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, estimated, error)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		[e.user, e.provider, e.task, e.model.slice(0, 255), e.at, e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheWriteTokens, e.cost, e.estimated ? 1 : 0, e.error ?? null])
	}

	private where(f: UsageFilter): { sql: string, params: unknown[] } {
		const params: unknown[] = [f.user, f.since]
		let sql = 'uid = $1 AND at >= $2'
		if (f.provider !== undefined) { params.push(f.provider); sql += ` AND provider = $${params.length}` }
		if (f.task !== undefined) { params.push(f.task); sql += ` AND task = $${params.length}` }
		return { sql, params }
	}

	async totals(f: UsageFilter): Promise<Totals> {
		await this.ensure()
		const w = this.where(f)
		const [r] = await this.db.q(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, COALESCE(SUM(cost), 0) AS c
			FROM ${this.db.t('atrium_ai_usage')} WHERE ${w.sql}`, w.params)
		return { calls: num(r?.calls), inputTokens: num(r?.i), outputTokens: num(r?.o), cost: num(r?.c) }
	}

	async breakdown(f: UsageFilter) {
		await this.ensure()
		const w = this.where(f)
		const rows = await this.db.q(`SELECT provider, task, COUNT(*) AS calls, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cost) AS c
			FROM ${this.db.t('atrium_ai_usage')} WHERE ${w.sql} GROUP BY provider, task ORDER BY provider, task`, w.params)
		return rows.map((r) => ({
			provider: String(r.provider), task: String(r.task),
			calls: num(r.calls), inputTokens: num(r.i), outputTokens: num(r.o), cost: num(r.c),
		}))
	}

	async getPause(user: string, provider: string): Promise<Pause | null> {
		await this.ensure()
		const [r] = await this.db.q(`SELECT until_at, reason, message, failures FROM ${this.db.t('atrium_ai_pause')} WHERE uid = $1 AND provider = $2`, [user, provider])
		return r ? { until: num(r.until_at), reason: String(r.reason) as PauseReason, message: String(r.message), failures: num(r.failures) } : null
	}

	async setPause(user: string, provider: string, p: Pause | null): Promise<void> {
		await this.ensure()
		const T = this.db.t('atrium_ai_pause')
		if (!p) {
			await this.db.q(`DELETE FROM ${T} WHERE uid = $1 AND provider = $2`, [user, provider])
			return
		}
		await this.db.q(`INSERT INTO ${T} (uid, provider, until_at, reason, message, failures) VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (uid, provider) DO UPDATE SET until_at = excluded.until_at, reason = excluded.reason, message = excluded.message, failures = excluded.failures`,
		[user, provider, p.until, p.reason, p.message.slice(0, 1000), p.failures])
	}
}
