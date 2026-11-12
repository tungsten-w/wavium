// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mail identities for agents (ADR 0009):
//   message_key = "<account id>:<msg_hash>"    msg_hash = md5(Message-ID or "db:<row id>"),
//                                              the same hash as Atrium's mail_bodies/mail_triage
//   thread_key  = "<account id>:t:<md5(thread root)>"
//   draft_key   = "<account id>:d:<local message id>"
// atrium_agent_mailkeys caches the hashes per message row so lookups are plain
// SQL on sqlite and Postgres alike; new rows are added before every query.
import { type Db, num } from '../db'
import { AgentError } from '../util'

export const md5 = (s: string): string => new Bun.CryptoHasher('md5').update(s).digest('hex')

/** Same as TriageService::hash(). */
export const msgHash = (messageId: string | null, dbId: number): string => md5(messageId ? messageId : `db:${dbId}`)

export const messageKey = (account: number, hash: string): string => `${account}:${hash}`
export const threadKey = (account: number, threadHash: string): string => `${account}:t:${threadHash}`
export const draftKey = (account: number, localId: number): string => `${account}:d:${localId}`

export function parseMessageKey(key: string): { account: number, hash: string } {
	const m = /^(\d+):([0-9a-f]{32})$/.exec(key)
	if (!m) throw new AgentError('invalid_input', `Not a message key: ${key}`, 'bad_key')
	return { account: Number(m[1]), hash: m[2] }
}

export function parseThreadKey(key: string): { account: number, hash: string } {
	const m = /^(\d+):t:([0-9a-f]{32})$/.exec(key)
	if (!m) throw new AgentError('invalid_input', `Not a thread key: ${key}`, 'bad_key')
	return { account: Number(m[1]), hash: m[2] }
}

export function parseDraftKey(key: string): { account: number, id: number } {
	const m = /^(\d+):d:(\d+)$/.exec(key)
	if (!m) throw new AgentError('invalid_input', `Not a draft key: ${key}`, 'bad_key')
	return { account: Number(m[1]), id: Number(m[2]) }
}


let syncing: Promise<void> | null = null

/** Add hashes for message rows newer than the last synced one. */
export function syncKeys(db: Db): Promise<void> {
	if (!syncing) syncing = doSync(db).finally(() => { syncing = null })
	return syncing
}

async function doSync(db: Db): Promise<void> {
	const K = db.t('atrium_agent_mailkeys')
	for (;;) {
		const max = num((await db.q<{ m: unknown }>(`SELECT MAX(id) AS m FROM ${K}`))[0]?.m)
		const rows = await db.q<{ id: unknown, message_id: string | null, thread_root_id: string | null, account_id: unknown }>(
			`SELECT m.id, m.message_id, m.thread_root_id, mb.account_id FROM ${db.t('mail_messages')} m
			JOIN ${db.t('mail_mailboxes')} mb ON mb.id = m.mailbox_id WHERE m.id > $1 ORDER BY m.id LIMIT 2000`, [max])
		if (!rows.length) return
		const values: string[] = []
		const params: unknown[] = []
		for (const r of rows) {
			const id = num(r.id)
			params.push(id, num(r.account_id), msgHash(r.message_id, id), r.thread_root_id ? md5(r.thread_root_id) : null)
			const n = params.length
			values.push(`($${n - 3}, $${n - 2}, $${n - 1}, $${n})`)
		}
		await db.q(`INSERT INTO ${K} (id, account_id, msg_hash, thread_hash) VALUES ${values.join(', ')} ON CONFLICT (id) DO NOTHING`, params)
		if (rows.length < 2000) return
	}
}
