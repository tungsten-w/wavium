// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// V4-23: a folder Wavium has no local copy of yet.
//
// The plain list always knew how to handle that ("not cached" -> run the initial
// sync -> ask again). The label list did not: it reads the local copy directly,
// so on an account that had just been connected Curated answered "this folder is
// empty" and nothing ever started the sync, while All showed every mail. That is
// exactly what a first mail account looked like.
import { expect, test, beforeEach, afterEach } from 'vitest'
import { fakeServer, type FakeServer } from '../../../core/web/testing/fakeServer'
import { defaultLabel, listByLabel, listMessages, mailErrorText, notCachedIds } from './api'
import { HttpError } from '@atrium/sdk'

/** The answer Mail gives for a folder that was never synced, as jsend. */
const notCached = (mailboxIds?: number[]) => new Response(JSON.stringify({
	status: 'fail',
	data: { message: 'mailbox is not cached', type: 'OCA\\Mail\\Exception\\MailboxNotCachedException', ...(mailboxIds ? { mailboxIds } : {}) },
}), { status: 400, headers: { 'Content-Type': 'application/json' } })

const mail = { databaseId: 11, subject: 'Dinner on Friday?' }
let server: FakeServer

beforeEach(() => { server = fakeServer() })
afterEach(() => server.restore())

test('Curated over a folder with no local copy syncs it, then lists it', async () => {
	let cached = false
	server
		.on('GET', '/apps/mail/api/triage/list', () => cached ? [mail] : notCached([7]))
		.on('POST', '/apps/mail/api/mailboxes/7/sync', () => { cached = true; return { newMessages: [], changedMessages: [], vanishedMessages: [], stats: { total: 1, unread: 0 } } })

	expect(await listByLabel([7], defaultLabel)).toEqual([mail])
	const syncs = server.calls('POST', '/apps/mail/api/mailboxes/7/sync')
	expect(syncs, 'the initial sync ran once').toHaveLength(1)
	expect(syncs[0].body, 'and it is the initial one, not an incremental round').toMatchObject({ init: true })
	expect(server.calls('GET', '/apps/mail/api/triage/list'), 'asked again after the sync').toHaveLength(2)
})

test('only the folders the server names are synced', async () => {
	let cached = false
	server
		.on('GET', '/apps/mail/api/triage/list', () => cached ? [mail] : notCached([9]))
		.on('POST', /^\/apps\/mail\/api\/mailboxes\/(\d+)\/sync$/, () => { cached = true; return { newMessages: [], changedMessages: [], vanishedMessages: [], stats: { total: 1, unread: 0 } } })

	// The unified Inbox lists three accounts' folders; only one of them is new.
	await listByLabel([8, 9, 10], defaultLabel)
	expect(server.calls('POST', /sync$/).map((c) => c.path)).toEqual(['/apps/mail/api/mailboxes/9/sync'])
})

test('an older server that names no folder gets every listed folder synced', async () => {
	let cached = false
	server
		.on('GET', '/apps/mail/api/triage/list', () => cached ? [mail] : notCached())
		.on('POST', /^\/apps\/mail\/api\/mailboxes\/(\d+)\/sync$/, () => { cached = true; return { newMessages: [], changedMessages: [], vanishedMessages: [], stats: { total: 1, unread: 0 } } })

	await listByLabel([3, 4], defaultLabel)
	expect(server.calls('POST', /sync$/).map((c) => c.path)).toEqual(['/apps/mail/api/mailboxes/3/sync', '/apps/mail/api/mailboxes/4/sync'])
})

test('the plain list still handles it the same way', async () => {
	let cached = false
	server
		.on('GET', '/apps/mail/api/messages', () => cached ? [mail] : notCached())
		.on('POST', '/apps/mail/api/mailboxes/5/sync', () => { cached = true; return { newMessages: [], changedMessages: [], vanishedMessages: [], stats: { total: 1, unread: 0 } } })

	expect(await listMessages(5)).toEqual([mail])
	expect(server.calls('POST', '/apps/mail/api/mailboxes/5/sync')).toHaveLength(1)
})

test('any other failure is passed on, not retried forever', async () => {
	server.on('GET', '/apps/mail/api/triage/list', () => new Response(JSON.stringify({ status: 'error', message: 'Database is on fire' }), { status: 500 }))

	await expect(listByLabel([1], defaultLabel)).rejects.toThrow('Database is on fire')
	expect(server.calls('GET', '/apps/mail/api/triage/list')).toHaveLength(1)
	expect(server.calls('POST', /sync$/)).toHaveLength(0)
})

test('notCachedIds reads the folders out of the failure, and nothing out of anything else', () => {
	const of = (body: unknown) => notCachedIds(new HttpError(400, 'x', body))
	expect(of({ data: { mailboxIds: [2, 3] } })).toEqual([2, 3])
	expect(of({ data: { mailboxIds: ['nope', 4] } })).toEqual([4])
	expect(of({ data: {} })).toEqual([])
	expect(of(null)).toEqual([])
	expect(notCachedIds(new Error('plain'))).toEqual([])
})

test('a setup failure says what the mail server said, not "HTTP 400"', () => {
	const fail = (data: unknown) => new HttpError(400, 'Bad Request', { status: 'fail', data })

	const wrong = mailErrorText(fail({ error: 'AUTHENTICATION', service: 'IMAP', host: 'imap.gmail.com', port: 993, details: 'Authentication failed.' }))
	expect(wrong).toContain('IMAP at imap.gmail.com:993')
	expect(wrong).toContain('did not accept the sign-in')
	expect(wrong).toContain('Authentication failed.')
	expect(wrong, 'and it says what to do about it').toContain('app password')

	const unreachable = mailErrorText(fail({ error: 'CONNECTION_ERROR', service: 'SMTP', host: 'smtp.example.org', port: 465 }))
	expect(unreachable).toContain('SMTP at smtp.example.org:465 did not answer')
	expect(unreachable).toContain('port')

	// An unknown reason still names the server instead of hiding behind the code.
	expect(mailErrorText(fail({ error: 'OTHER', service: 'IMAP', host: 'imap.free.fr', port: 993 }))).toContain('imap.free.fr')
	// Anything that is not a Mail failure keeps its own message.
	expect(mailErrorText(new Error('Your browser blocked the Google window'))).toBe('Your browser blocked the Google window')
	expect(mailErrorText(new HttpError(500, 'Could not create account', { status: 'error', message: 'Could not create account' }))).toBe('Could not create account')
})
