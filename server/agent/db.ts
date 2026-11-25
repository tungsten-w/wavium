// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Database access for the agent layer: one Bun.SQL connection to Nextcloud's
// database (Postgres on test/live, sqlite on dev). The agent tables
// (`<prefix>atrium_agent_*`) are created and migrated here, not by PHP.
import { SQL } from 'bun'
import type { NcConfig } from './config'

export type Dialect = 'pg' | 'sqlite'

export interface Db {
	sql: SQL
	dialect: Dialect
	/** Prefixed table name, e.g. t('atrium_agent_events') -> oc_atrium_agent_events */
	t(name: string): string
	/** Run a query with $1..$n placeholders. */
	q<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>
	close(): Promise<void>
}

export function connect(cfg: NcConfig): Db {
	let sql: SQL
	let dialect: Dialect
	if (cfg.dbtype === 'pgsql') {
		dialect = 'pg'
		sql = new SQL({
			adapter: 'postgres',
			hostname: cfg.dbhost,
			port: Number(cfg.dbport),
			database: cfg.dbname,
			username: cfg.dbuser,
			password: cfg.dbpassword,
			max: 5,
			idleTimeout: 60,
		})
	} else if (cfg.dbtype === 'sqlite3' || cfg.dbtype === 'sqlite') {
		dialect = 'sqlite'
		sql = new SQL(`sqlite://${cfg.datadirectory}/${cfg.dbname}.db`)
	} else {
		throw new Error(`Unsupported database type ${cfg.dbtype}`)
	}
	return wrap(sql, dialect, cfg.dbtableprefix)
}

export function wrap(sql: SQL, dialect: Dialect, prefix: string): Db {
	const db: Db = {
		sql,
		dialect,
		t: (name) => prefix + name,
		q: async <T>(query: string, params: unknown[] = []) => {
			const rows = await sql.unsafe(query, params as never[])
			return [...rows] as T[]
		},
		close: () => sql.close(),
	}
	if (dialect === 'sqlite') {
		// PHP writes the same file; wait for its locks instead of failing.
		void sql.unsafe('PRAGMA busy_timeout = 5000')
	}
	return db
}

/** Postgres returns BIGINT as a string. */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))
export const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 't' || v === 'true'

const now = () => Math.floor(Date.now() / 1000)

interface Migration { id: number, up: (db: Db) => Promise<void> }

function ddl(db: Db) {
	const id = db.dialect === 'pg' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'
	const blob = db.dialect === 'pg' ? 'BYTEA' : 'BLOB'
	return { id, blob }
}

const MIGRATIONS: Migration[] = [
	{
		id: 1,
		up: async (db) => {
			const { id, blob } = ddl(db)
			const T = db.t
			await db.q(`CREATE TABLE IF NOT EXISTS ${T('atrium_agent_settings')} (
				uid VARCHAR(64) PRIMARY KEY,
				paused SMALLINT NOT NULL DEFAULT 0,
				wakes SMALLINT NOT NULL DEFAULT 0,
				webhook_url TEXT,
				webhook_secret TEXT,
				notify_approvals SMALLINT NOT NULL DEFAULT 1,
				doorbell_error TEXT,
				doorbell_error_at BIGINT,
				updated_at BIGINT NOT NULL DEFAULT 0)`)
			await db.q(`CREATE TABLE IF NOT EXISTS ${T('atrium_agent_access')} (
				id ${id},
				agent_uid VARCHAR(64) NOT NULL,
				grantor_uid VARCHAR(64) NOT NULL,
				area VARCHAR(64) NOT NULL,
				modes TEXT NOT NULL,
				updated_at BIGINT NOT NULL DEFAULT 0)`)
			await db.q(`CREATE UNIQUE INDEX IF NOT EXISTS ${T('atrium_agent_access_uniq')} ON ${T('atrium_agent_access')} (agent_uid, grantor_uid, area)`)
			await db.q(`CREATE INDEX IF NOT EXISTS ${T('atrium_agent_access_grantor')} ON ${T('atrium_agent_access')} (grantor_uid, area)`)
			// Written by PHP (and TS) where things happen; moved into the log by one writer.
			await db.q(`CREATE TABLE IF NOT EXISTS ${T('atrium_agent_event_queue')} (
				id ${id},
				dedupe_key VARCHAR(200),
				app VARCHAR(64) NOT NULL,
				area VARCHAR(64) NOT NULL,
				type VARCHAR(100) NOT NULL,
				grantor_uid VARCHAR(64) NOT NULL,
				agent_uid VARCHAR(64),
				wake_hint SMALLINT NOT NULL DEFAULT 0,
				data TEXT NOT NULL,
				created_at BIGINT NOT NULL)`)
			await db.q(`CREATE UNIQUE INDEX IF NOT EXISTS ${T('atrium_agent_eq_dedupe')} ON ${T('atrium_agent_event_queue')} (dedupe_key)`)
			await db.q(`CREATE TABLE IF NOT EXISTS ${T('atrium_agent_events')} (
				id ${id},
				event_id VARCHAR(40) NOT NULL,
				dedupe_key VARCHAR(200),
				app VARCHAR(64) NOT NULL,
				area VARCHAR(64) NOT NULL,
				type VARCHAR(100) NOT NULL,
				grantor_uid VARCHAR(64) NOT NULL,
				agent_uid VARCHAR(64),
				wake_hint SMALLINT NOT NULL DEFAULT 0,
				data TEXT NOT NULL,
				occurred_at BIGINT NOT NULL)`)
			await db.q(`CREATE UNIQUE INDEX IF NOT EXISTS ${T('atrium_agent_events_dedupe')} ON ${T('atrium_agent_events')} (dedupe_key)`)
			await db.q(`CREATE INDEX IF NOT EXISTS ${T('atrium_agent_events_time')} ON ${T('atrium_agent_events')} (occurred_at)`)
			await db.q(`CREATE TABLE IF NOT EXISTS ${T('atrium_agent_approvals')} (
				id ${id},
				request_id VARCHAR(40) NOT NULL,
				agent_uid VARCHAR(64) NOT NULL,
				grantor_uid VARCHAR(64) NOT NULL,
				tool VARCHAR(100) NOT NULL,
				input TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash VARCHAR(64) NOT NULL,
				summary TEXT NOT NULL,
				ref VARCHAR(200),
				status VARCHAR(20) NOT NULL,
				requested_at BIGINT NOT NULL,
				expires_at BIGINT NOT NULL,
				decided_by VARCHAR(64),
				decided_at BIGINT,
				note TEXT,
				result TEXT,
				error TEXT)`)
			await db.q(`CREATE UNIQUE INDEX IF NOT EXISTS ${T('atrium_agent_approvals_rid')} ON ${T('atrium_agent_approvals')} (request_id)`)
			await db.q(`CREATE INDEX IF NOT EXISTS ${T('atrium_agent_approvals_agent')} ON ${T('atrium_agent_approvals')} (agent_uid, status)`)
			await db.q(`CREATE INDEX IF NOT EXISTS ${T('atrium_agent_approvals_grantor')} ON ${T('atrium_agent_approvals')} (grantor_uid, status)`)
			await db.q(`CREATE TABLE IF NOT EXISTS ${T('atrium_agent_uploads')} (
				id VARCHAR(40) PRIMARY KEY,
				agent_uid VARCHAR(64) NOT NULL,
				filename VARCHAR(255) NOT NULL,
				content_type VARCHAR(255) NOT NULL,
				size BIGINT NOT NULL,
				content ${blob} NOT NULL,
				created_at BIGINT NOT NULL,
				expires_at BIGINT NOT NULL)`)
			await db.q(`CREATE TABLE IF NOT EXISTS ${T('atrium_agent_links')} (
				id VARCHAR(64) PRIMARY KEY,
				agent_uid VARCHAR(64) NOT NULL,
				grantor_uid VARCHAR(64) NOT NULL,
				kind VARCHAR(64) NOT NULL,
				ref TEXT NOT NULL,
				created_at BIGINT NOT NULL,
				expires_at BIGINT NOT NULL)`)
			// Agent drafts written through the tools (who wrote them, discarded or sent).
			await db.q(`CREATE TABLE IF NOT EXISTS ${T('atrium_agent_drafts')} (
				local_id BIGINT PRIMARY KEY,
				agent_uid VARCHAR(64) NOT NULL,
				grantor_uid VARCHAR(64) NOT NULL,
				account_id BIGINT NOT NULL,
				created_at BIGINT NOT NULL,
				discarded_at BIGINT,
				sent_at BIGINT)`)
		},
	},
	{
		// Message row -> message/thread hash (server/agent/mail/keys.ts).
		id: 2,
		up: async (db) => {
			const T = db.t('atrium_agent_mailkeys')
			await db.q(`CREATE TABLE IF NOT EXISTS ${T} (
				id BIGINT PRIMARY KEY,
				account_id BIGINT NOT NULL,
				msg_hash VARCHAR(32) NOT NULL,
				thread_hash VARCHAR(32))`)
			await db.q(`CREATE INDEX IF NOT EXISTS ${db.t('atrium_agent_mailkeys_msg')} ON ${T} (account_id, msg_hash)`)
			await db.q(`CREATE INDEX IF NOT EXISTS ${db.t('atrium_agent_mailkeys_thr')} ON ${T} (account_id, thread_hash)`)
		},
	},
	{
		// Settings > Agents > Tokens: when and from where each agent token was last used (V4-9).
		id: 3,
		up: async (db) => {
			await db.q(`CREATE TABLE IF NOT EXISTS ${db.t('atrium_agent_token_use')} (
				token_id BIGINT PRIMARY KEY,
				agent_uid VARCHAR(64) NOT NULL,
				last_ip VARCHAR(64) NOT NULL,
				last_at BIGINT NOT NULL,
				user_agent VARCHAR(200),
				calls BIGINT NOT NULL DEFAULT 0)`)
		},
	},
	{
		// Quiet hours per agent (V4-11): JSON {from: "22:00", to: "07:00", tz: "Europe/Paris"} or NULL.
		id: 4,
		up: async (db) => {
			await db.q(`ALTER TABLE ${db.t('atrium_agent_settings')} ADD COLUMN quiet TEXT`)
		},
	},
	{
		// Talking to an agent from Wavium (V4-39): one thread per agent, both
		// directions. `taken_at` is when the agent picked an owner message up,
		// so a message is answered once even if the agent runs twice.
		id: 5,
		up: async (db) => {
			const { id } = ddl(db)
			const T = db.t('atrium_agent_chat')
			await db.q(`CREATE TABLE IF NOT EXISTS ${T} (
				id ${id},
				agent_uid VARCHAR(64) NOT NULL,
				owner_uid VARCHAR(64) NOT NULL,
				role VARCHAR(8) NOT NULL,
				body TEXT NOT NULL,
				created_at BIGINT NOT NULL,
				taken_at BIGINT)`)
			await db.q(`CREATE INDEX IF NOT EXISTS ${db.t('atrium_agent_chat_thread')} ON ${T} (agent_uid, id)`)
		},
	},
]

export async function migrate(db: Db): Promise<void> {
	await db.q(`CREATE TABLE IF NOT EXISTS ${db.t('atrium_agent_meta')} (k VARCHAR(64) PRIMARY KEY, v TEXT NOT NULL)`)
	const rows = await db.q<{ v: string }>(`SELECT v FROM ${db.t('atrium_agent_meta')} WHERE k = $1`, ['schema'])
	let version = rows.length ? Number(rows[0].v) : 0
	for (const m of MIGRATIONS) {
		if (m.id <= version) continue
		await m.up(db)
		version = m.id
		await setMeta(db, 'schema', String(version))
	}
}

export async function getMeta(db: Db, k: string): Promise<string | null> {
	const rows = await db.q<{ v: string }>(`SELECT v FROM ${db.t('atrium_agent_meta')} WHERE k = $1`, [k])
	return rows.length ? rows[0].v : null
}

export async function setMeta(db: Db, k: string, v: string): Promise<void> {
	await db.q(`INSERT INTO ${db.t('atrium_agent_meta')} (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, [k, v])
}

export { now }
