// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test fixture: the Mail tables the agent layer reads, on in-memory sqlite.
import type { Db } from '../db'
import { md5 } from './keys'

const MAIL_TABLES = [
	`CREATE TABLE oc_mail_accounts (id INTEGER PRIMARY KEY, user_id TEXT, email TEXT, name TEXT, archive_mailbox_id INTEGER, trash_mailbox_id INTEGER, junk_mailbox_id INTEGER, sent_mailbox_id INTEGER, drafts_mailbox_id INTEGER)`,
	`CREATE TABLE oc_mail_mailboxes (id INTEGER PRIMARY KEY, account_id INTEGER, name TEXT, special_use TEXT, messages INTEGER DEFAULT 0, unseen INTEGER DEFAULT 0)`,
	`CREATE TABLE oc_mail_messages (id INTEGER PRIMARY KEY, uid INTEGER, message_id TEXT, mailbox_id INTEGER, subject TEXT, sent_at INTEGER, flag_seen INTEGER DEFAULT 0, flag_flagged INTEGER DEFAULT 0, flag_answered INTEGER DEFAULT 0, flag_forwarded INTEGER DEFAULT 0, flag_attachments INTEGER, flag_important INTEGER DEFAULT 0, flag_junk INTEGER DEFAULT 0, flag_deleted INTEGER DEFAULT 0, preview_text TEXT, in_reply_to TEXT, thread_root_id TEXT, server_gone_at INTEGER)`,
	`CREATE TABLE oc_mail_recipients (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER, local_message_id INTEGER, type INTEGER, label TEXT, email TEXT)`,
	`CREATE TABLE oc_mail_triage (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, msg_hash TEXT, version TEXT, model TEXT, category TEXT, category_confidence REAL, urgency TEXT, urgency_score REAL, needs_reply REAL, needs_action REAL, has_deadline REAL, written_by_person REAL, suspicious REAL, classified_at INTEGER)`,
	`CREATE TABLE oc_mail_triage_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, msg_hash TEXT, db_id INTEGER, priority INTEGER, sent_at INTEGER, status TEXT, attempts INTEGER DEFAULT 0, last_error TEXT, enqueued_at INTEGER, updated_at INTEGER)`,
	`CREATE TABLE oc_mail_bodies (account_id INTEGER, msg_hash TEXT, body TEXT, reader_body TEXT, reader_meta TEXT, headers TEXT, attachments TEXT)`,
	`CREATE TABLE oc_preferences (userid TEXT, appid TEXT, configkey TEXT, configvalue TEXT)`,
	`CREATE TABLE oc_appconfig (appid TEXT, configkey TEXT, configvalue TEXT)`,
	`CREATE TABLE oc_mail_local_messages (id INTEGER PRIMARY KEY, type INTEGER, account_id INTEGER, subject TEXT, body_plain TEXT, editor_body TEXT, in_reply_to_message_id TEXT, updated_at INTEGER)`,
	`CREATE TABLE oc_mail_attachments (id INTEGER PRIMARY KEY, local_message_id INTEGER, file_name TEXT, mime_type TEXT)`,
]

/**
 * Account 1 (ann): Gmail-like, INBOX (10), All Mail (11), Trash (12).
 * Account 2 belongs to bob. Mails 1+2 are one mail (<a@x>) in two folders.
 */
export async function seedMail(db: Db): Promise<void> {
	for (const s of MAIL_TABLES) await db.q(s)
	await db.q(`INSERT INTO oc_mail_accounts (id, user_id, email, name, trash_mailbox_id) VALUES (1, 'ann', 'ann@x.test', 'Ann', 12), (2, 'bob', 'bob@x.test', 'Bob', NULL)`)
	await db.q(`INSERT INTO oc_mail_mailboxes (id, account_id, name, special_use) VALUES (10, 1, 'INBOX', '["\\\\inbox"]'), (11, 1, '[Gmail]/All Mail', '["\\\\all"]'), (12, 1, '[Gmail]/Trash', '["\\\\trash"]'), (20, 2, 'INBOX', '[]')`)
	await addMail(db, 1, 10, '<a@x>', 'Hello', 1000)
	await addMail(db, 2, 11, '<a@x>', 'Hello', 1000)
	await addMail(db, 3, 11, '<b@x>', 'Re: Hello', 2000, { root: '<a@x>', seen: 1 })
	await addMail(db, 4, 10, '<c@x>', 'Invoice', 3000)
	await addMail(db, 5, 12, '<d@x>', 'Old junk', 4000)
	await addMail(db, 6, 20, '<e@x>', 'Bob only', 5000)
	await db.q(`INSERT INTO oc_mail_recipients (message_id, type, label, email) VALUES (1, 0, 'Zed', 'zed@y.test'), (1, 1, 'ann@x.test', 'ann@x.test'), (4, 0, 'Shop', 'shop@y.test'), (3, 0, 'Ann', 'ann@x.test'), (3, 2, 'Cee', 'c@y.test')`)
	await classify(db, 1, '<a@x>', 'personal', { urgency: 'today', needs_reply: 0.9, needs_action: 0.1, at: 1000 })
	await classify(db, 1, '<c@x>', 'ads', { urgency: 'never', suspicious: 0.2, at: 3000 })
	await db.q(`INSERT INTO oc_mail_bodies (account_id, msg_hash, body, reader_body, reader_meta, attachments) VALUES (1, $1, 'Full body text', '<p>Full</p>', $2, '[{"id":"2"}]')`,
		[md5('<c@x>'), JSON.stringify({ attachments: [{ id: '2', fileName: 'invoice.pdf', mime: 'application/pdf', size: 21 }], inlineAttachments: [{ id: '2' }, { id: '3', mime: 'image/png' }], replyTo: [{ label: 'Billing', email: 'billing@y.test' }] })])
}

export function addMail(db: Db, id: number, mbox: number, mid: string, subject: string, sentAt: number, extra: { preview?: string, root?: string, att?: number, seen?: number } = {}) {
	return db.q(`INSERT INTO oc_mail_messages (id, uid, message_id, mailbox_id, subject, sent_at, preview_text, thread_root_id, flag_attachments, flag_seen) VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		[id, mid, mbox, subject, sentAt, extra.preview ?? `preview ${subject}`, extra.root ?? mid, extra.att ?? null, extra.seen ?? 0])
}

export function classify(db: Db, account: number, mid: string, category: string, f: { urgency?: string, needs_reply?: number, needs_action?: number, suspicious?: number, at?: number } = {}) {
	return db.q(`INSERT INTO oc_mail_triage (account_id, msg_hash, version, category, urgency, needs_reply, needs_action, suspicious, classified_at) VALUES ($1, $2, 'mail-v2', $3, $4, $5, $6, $7, $8)`,
		[account, md5(mid), category, f.urgency ?? 'whenever', f.needs_reply ?? 0, f.needs_action ?? 0, f.suspicious ?? 0, f.at ?? 0])
}

export function queue(db: Db, account: number, mid: string, f: { priority?: number, sentAt?: number, status?: string, enqueuedAt: number }) {
	return db.q(`INSERT INTO oc_mail_triage_queue (account_id, msg_hash, db_id, priority, sent_at, status, enqueued_at, updated_at) VALUES ($1, $2, 0, $3, $4, $5, $6, $6)`,
		[account, md5(mid), f.priority ?? 1, f.sentAt ?? f.enqueuedAt, f.status ?? 'pending', f.enqueuedAt])
}
