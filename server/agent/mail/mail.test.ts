// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { type Db, migrate, wrap } from '../db'
import { AgentError } from '../util'
import { seedMail } from './fixture'
import { md5, msgHash, parseDraftKey, parseMessageKey, parseThreadKey, syncKeys } from './keys'
import { attachmentsFromMeta, curatedHides, DEFAULT_CURATED_HIDES, getMessage, getThread, listMessages, mailScope, pageText, roleOf, type Account } from './read'
import { addresses, readDraft, sendSnapshot, sendSummary } from './write'

let db: Db

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	await seedMail(db)
})

test('keys parse and hash like TriageService', () => {
	expect(msgHash('<a@x>', 9)).toBe(md5('<a@x>'))
	expect(msgHash(null, 9)).toBe(md5('db:9'))
	const h = md5('x')
	expect(parseMessageKey(`3:${h}`)).toEqual({ account: 3, hash: h })
	expect(parseThreadKey(`3:t:${h}`)).toEqual({ account: 3, hash: h })
	expect(parseDraftKey('3:d:17')).toEqual({ account: 3, id: 17 })
	for (const bad of ['3:xyz', `x:${h}`, `3:t:${h}`]) expect(() => parseMessageKey(bad)).toThrow(AgentError)
	expect(() => parseDraftKey(`3:${h}`)).toThrow(AgentError)
})

test('syncKeys is incremental', async () => {
	await syncKeys(db)
	expect((await db.q(`SELECT * FROM oc_atrium_agent_mailkeys`)).length).toBe(6)
	await db.q(`INSERT INTO oc_mail_messages (id, uid, message_id, mailbox_id, subject, sent_at) VALUES (7, 7, NULL, 10, 'No id', 6000)`)
	await syncKeys(db)
	const rows = await db.q<{ msg_hash: string, thread_hash: string | null }>(`SELECT msg_hash, thread_hash FROM oc_atrium_agent_mailkeys WHERE id = 7`)
	expect(rows[0]).toEqual({ msg_hash: md5('db:7'), thread_hash: null })
})

test('folder roles: Gmail All Mail is the archive', () => {
	const acc: Account = { id: 1, email: '', name: '', archiveId: null, trashId: 12, junkId: null, sentId: null, draftsId: null }
	expect(roleOf(acc, 12, null, false)).toBe('trash')
	expect(roleOf(acc, 10, '["\\\\Inbox"]', false)).toBe('inbox')
	expect(roleOf(acc, 11, '["\\\\all"]', false)).toBe('archive')
	expect(roleOf(acc, 11, '["\\\\all"]', true)).toBe('other')
	expect(roleOf({ ...acc, archiveId: 30 }, 11, '["\\\\all"]', false)).toBe('other')
	expect(roleOf(acc, 99, 'not json', false)).toBe('other')
})

test('curated hides: default, stored, bad values', async () => {
	expect(await curatedHides(db, 'ann')).toEqual(DEFAULT_CURATED_HIDES)
	await db.q(`INSERT INTO oc_preferences VALUES ('ann', 'mail', 'curated-hides', '["spam","bogus"]')`)
	expect(await curatedHides(db, 'ann')).toEqual(['spam'])
	await db.q(`UPDATE oc_preferences SET configvalue = 'nope'`)
	expect(await curatedHides(db, 'ann')).toEqual(DEFAULT_CURATED_HIDES)
})

test('list: inbox+archive by default, deduped, own accounts only', async () => {
	const res = await listMessages(db, 'ann', {})
	expect(res.messages.map((m) => m.subject)).toEqual(['Invoice', 'Re: Hello', 'Hello'])
	const hello = res.messages[2]
	expect(hello.folder?.role).toBe('inbox') // INBOX copy wins over All Mail
	expect(hello.from).toEqual({ name: 'Zed', address: 'zed@y.test' })
	expect(hello.to).toEqual([{ name: '', address: 'ann@x.test' }])
	expect(hello.classification).toEqual({ category: 'personal', urgency: 'today', needs_reply: 0.9, needs_action: 0.1, suspicious: 0 })
	expect(res.messages[1].thread_key).toBe(hello.thread_key)
	expect((await listMessages(db, 'ann', { folder: 'trash' })).messages.map((m) => m.subject)).toEqual(['Old junk'])
	expect((await listMessages(db, 'ann', { folder: 'all' })).messages.length).toBe(4)
	await expect(listMessages(db, 'ann', { account: 2 })).rejects.toThrow('No mail account 2')
	await expect(listMessages(db, 'ann', { folder: 20 })).rejects.toThrow('No folder 20')
})

test('list filters', async () => {
	const subjects = async (input: Parameters<typeof listMessages>[2]) => (await listMessages(db, 'ann', input)).messages.map((m) => m.subject)
	expect(await subjects({ has_attachments: true })).toEqual(['Invoice']) // known from the stored body only
	expect(await subjects({ has_attachments: false })).toEqual(['Re: Hello', 'Hello'])
	expect(await subjects({ curated: true })).toEqual(['Hello'])
	expect(await subjects({ curated: false })).toEqual(['Invoice', 'Re: Hello'])
	expect(await subjects({ category: 'ads' })).toEqual(['Invoice'])
	expect(await subjects({ urgency_min: 'this_week' })).toEqual(['Hello'])
	expect(await subjects({ needs_reply: true })).toEqual(['Hello'])
	expect(await subjects({ from: 'zed' })).toEqual(['Hello'])
	expect(await subjects({ to: 'c@y' })).toEqual(['Re: Hello'])
	expect(await subjects({ text: 'full body' })).toEqual(['Invoice'])
	expect(await subjects({ subject: '100%' })).toEqual([])
	expect(await subjects({ seen: true })).toEqual(['Re: Hello'])
	expect(await subjects({ after: '1970-01-01T00:30:00Z', before: '1970-01-01T00:50:00Z' })).toEqual(['Re: Hello'])
	await expect(subjects({ category: 'nope' })).rejects.toThrow(AgentError)
	await expect(subjects({ urgency_min: 'soon' })).rejects.toThrow(AgentError)
	await expect(subjects({ cursor: 'm_bad' })).rejects.toThrow('Bad cursor')
})

test('list paging with cursor', async () => {
	const p1 = await listMessages(db, 'ann', { limit: 2 })
	expect(p1.messages.map((m) => m.subject)).toEqual(['Invoice', 'Re: Hello'])
	expect(p1.next_cursor).not.toBeNull()
	const p2 = await listMessages(db, 'ann', { limit: 2, cursor: p1.next_cursor! })
	expect(p2.messages.map((m) => m.subject)).toEqual(['Hello'])
	expect(p2.next_cursor).toBeNull()
})

test('get message: stored body, attachments, paging, scope', async () => {
	const key = `1:${md5('<c@x>')}`
	let fetched = 0
	const m = await getMessage(db, 'ann', { message_key: key, max_chars: 4, offset: 5, html: true }, async () => { fetched++ })
	expect(fetched).toBe(0)
	expect(m.body_source).toBe('stored')
	expect(m.body).toBe('body')
	expect(m.body_truncated).toBe(true)
	expect(m.html).toBe('<p>Full</p>')
	expect(m.has_attachments).toBe(true)
	expect(m.attachments).toEqual([
		{ attachment_id: '2', filename: 'invoice.pdf', content_type: 'application/pdf', size: 21, inline: false },
		{ attachment_id: '3', filename: 'part-3', content_type: 'image/png', size: 0, inline: true },
	])
	expect(m.reply_to).toEqual([{ name: 'Billing', address: 'billing@y.test' }])
	expect(m.classification?.category).toBe('ads')
	await expect(getMessage(db, 'bob', { message_key: key }, null)).rejects.toThrow('No mail')
})

test('get message: fetches a missing body once, falls back to preview', async () => {
	const key = `1:${md5('<a@x>')}`
	const ids: number[] = []
	const m = await getMessage(db, 'ann', { message_key: key }, async (_g, id) => { ids.push(id) })
	expect(ids).toEqual([1])
	expect(m.body_source).toBe('preview')
	expect(m.body).toBe('preview Hello')
	expect(m.folders.map((f) => f?.role)).toEqual(['inbox', 'archive'])
	const failing = await getMessage(db, 'ann', { message_key: key }, async () => { throw new Error('imap down') })
	expect(failing.body_source).toBe('preview')
})

test('get message: a classified mail without reader copy is fetched so attachments show', async () => {
	// What classification leaves behind: text body only (empty for a PDF-only mail), no reader_meta.
	const key = `1:${md5('<c@x>')}`
	await db.q(`UPDATE oc_mail_bodies SET body = '', reader_body = NULL, reader_meta = NULL WHERE msg_hash = $1`, [md5('<c@x>')])
	const meta = JSON.stringify({ attachments: [{ id: '2', fileName: 'INR108.pdf', mime: 'application/pdf', size: 9 }] })
	let fetched = 0
	const m = await getMessage(db, 'ann', { message_key: key }, async () => {
		fetched++
		await db.q(`UPDATE oc_mail_bodies SET reader_body = '<p></p>', reader_meta = $1 WHERE msg_hash = $2`, [meta, md5('<c@x>')])
	})
	expect(fetched).toBe(1)
	expect(m.body_source).toBe('stored')
	expect(m.attachments.map((a) => a.filename)).toEqual(['INR108.pdf'])
	// Once the reader copy exists, no second fetch.
	await getMessage(db, 'ann', { message_key: key }, async () => { fetched++ })
	expect(fetched).toBe(1)
})

test('thread: messages in order, deduped', async () => {
	const t = await getThread(db, 'ann', { thread_key: `1:t:${md5('<a@x>')}` })
	expect(t.messages.map((m) => m.subject)).toEqual(['Hello', 'Re: Hello'])
	expect(t.messages[1].cc).toEqual([{ name: 'Cee', address: 'c@y.test' }])
	await expect(getThread(db, 'bob', { thread_key: `1:t:${md5('<a@x>')}` })).rejects.toThrow('No thread')
})

test('scope keeps other users out', async () => {
	const s = await mailScope(db, 'bob')
	expect(s.accounts.map((a) => a.id)).toEqual([2])
	expect((await listMessages(db, 'bob', {})).messages.map((m) => m.subject)).toEqual([]) // bob's INBOX has no special use
	expect((await listMessages(db, 'bob', { folder: 'other' })).messages.map((m) => m.subject)).toEqual(['Bob only'])
})

test('attachment meta and text paging helpers', () => {
	expect(attachmentsFromMeta(null)).toEqual([])
	expect(attachmentsFromMeta({ attachments: [{ fileName: 'no id' }] })).toEqual([])
	expect(pageText('abcdef', 10, 3)).toEqual({ body: '', body_length: 6, offset: 6, body_truncated: false })
	expect(pageText('abcdef', 0, 3)).toEqual({ body: 'abc', body_length: 6, offset: 0, body_truncated: true })
})

test('addresses validate and keep names', () => {
	expect(addresses(undefined, 'to')).toEqual([])
	expect(addresses(['a@b.c', { address: ' d@e.f ', name: 'Dee' }], 'to')).toEqual([{ label: 'a@b.c', email: 'a@b.c' }, { label: 'Dee', email: 'd@e.f' }])
	expect(() => addresses(['nope'], 'cc')).toThrow('cc[0]: not an e-mail address')
	expect(() => addresses([{ address: 'a b@c.d' }], 'to')).toThrow(AgentError)
})

test('draft read, send snapshot and summary', async () => {
	await db.q(`INSERT INTO oc_mail_local_messages (id, type, account_id, subject, body_plain, in_reply_to_message_id, updated_at) VALUES (5, 1, 1, 'Re: Hello', 'Thanks!', '<a@x>', 7000)`)
	await db.q(`INSERT INTO oc_mail_recipients (local_message_id, type, label, email) VALUES (5, 1, 'Zed', 'zed@y.test'), (5, 2, 'c@y.test', 'c@y.test'), (5, 3, 'X', 'x@y.test'), (5, 1, 'W', 'w@y.test')`)
	await db.q(`INSERT INTO oc_mail_attachments (id, local_message_id, file_name, mime_type) VALUES (8, 5, 'a.txt', 'text/plain')`)
	await db.q(`INSERT INTO oc_atrium_agent_drafts (local_id, agent_uid, grantor_uid, account_id, created_at) VALUES (5, 'agent-nova', 'ann', 1, 7000)`)
	const d = await readDraft(db, 'ann', '1:d:5', 'agent-nova')
	expect(d.created_by_agent).toBe(true)
	expect(d.to).toEqual([{ name: 'Zed', address: 'zed@y.test' }, { name: 'W', address: 'w@y.test' }])
	expect(d.cc).toEqual([{ name: '', address: 'c@y.test' }])
	expect(d.attachments).toEqual([{ attachment_id: '8', filename: 'a.txt', content_type: 'text/plain' }])
	expect((await readDraft(db, 'ann', '1:d:5', 'agent-other')).created_by_agent).toBe(false)
	await expect(readDraft(db, 'bob', '1:d:5')).rejects.toThrow('No draft')
	await expect(readDraft(db, 'ann', '1:d:6')).rejects.toThrow('No draft')
	const snap = sendSnapshot(d, 'ann@x.test')
	expect(snap.from).toBe('ann@x.test')
	expect(sendSummary(snap)).toBe('Send "Re: Hello" to zed@y.test, w@y.test, c@y.test +1 with 1 attachment')
	expect(sendSummary({ ...snap, subject: '', to: [], cc: [], bcc: [], attachments: [] })).toBe('Send "(no subject)" to nobody')
})
