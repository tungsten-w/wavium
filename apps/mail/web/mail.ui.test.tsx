// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mail UI against a fake server (P1-6): the list, opening a mail, writing and
// sending a message, saving a draft. The fake answers like apps/mail's API.
import '../../../core/web/testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { fakeServer, type FakeServer } from '../../../core/web/testing/fakeServer'
import { cleanup, click, getButton, getByText, getField, queryByText, renderApp, type, waitFor } from '../../../core/web/testing/render'
import MailApp from './index'
import type { Account, Mailbox, Message, MessageBody } from './api'

const account: Account = {
	id: 1, accountId: 1, name: 'Alice', emailAddress: 'alice@atrium.test', imapHost: 'greenmail', imapPort: 3143, imapSslMode: 'none',
	imapUser: 'alice@atrium.test', smtpHost: 'greenmail', smtpPort: 3025, smtpSslMode: 'none', smtpUser: 'alice@atrium.test',
	signature: null, editorMode: 'plaintext', draftsMailboxId: 3, sentMailboxId: 2, trashMailboxId: 4, archiveMailboxId: null,
	junkMailboxId: null, snoozeMailboxId: null, showSubscribedOnly: false, aliases: [], isDelegated: false,
}
const box = (databaseId: number, name: string, specialRole: string, unread = 0): Mailbox => ({
	databaseId, id: btoa(name), name, accountId: 1, displayName: name, attributes: [], delimiter: '/', specialUse: specialRole ? [specialRole] : [],
	specialRole, mailboxes: [], syncInBackground: true, unread, shared: false,
})
const boxes = [box(1, 'INBOX', 'inbox', 1), box(2, 'Sent', 'sent'), box(3, 'Drafts', 'drafts'), box(4, 'Trash', 'trash')]
const flags = { seen: false, flagged: false, answered: false, deleted: false, draft: false, forwarded: false, hasAttachments: false, important: false }
const msg = (databaseId: number, subject: string, from: string, preview: string, seen = false): Message => ({
	databaseId, uid: databaseId, subject, dateInt: 1_794_500_000 - databaseId * 60, flags: { ...flags, seen }, from: [{ label: from.split('@')[0], email: from }],
	to: [{ label: 'Alice', email: 'alice@atrium.test' }], cc: [], bcc: [], mailboxId: 1, messageId: `<m${databaseId}@atrium.test>`, inReplyTo: null,
	threadRootId: null, previewText: preview, summary: null, encrypted: false, attachments: [],
})
const inbox = [msg(11, 'Dinner on Friday?', 'bob@atrium.test', 'Are you free on Friday evening'), msg(12, 'Your invoice', 'shop@example.org', 'Invoice #42 is attached', true)]
const body = (m: Message): MessageBody => ({
	uid: m.uid, messageId: m.messageId, from: m.from, to: m.to, replyTo: [], cc: [], bcc: [], subject: m.subject, dateInt: m.dateInt,
	body: `<p>${m.previewText} — full text of ${m.subject}.</p>`, hasHtmlBody: true, attachments: [], inlineAttachments: [], accountId: 1, mailboxId: 1,
	databaseId: m.databaseId, isSenderTrusted: false, atriumCopy: { source: 'atrium', goneFromServer: false, text: true, full: true },
})

let server: FakeServer

beforeEach(() => {
	server = fakeServer()
		.on('GET', '/apps/mail/api/accounts', () => [account])
		.on('GET', '/apps/mail/api/mailboxes', () => ({ id: 1, email: account.emailAddress, mailboxes: boxes, delimiter: '/' }))
		.on('GET', '/apps/mail/api/outbox', () => ({ messages: [] }))
		.on('GET', /^\/apps\/mail\/api\/preferences\/(.+)$/, () => ({ value: '' }))
		// The default Inbox view is "Curated": the label list over the inbox folders.
		// One page: asking for the next one (cursor) gets nothing more.
		.on('GET', '/apps/mail/api/triage/list', (req) => req.query.has('cursor') ? [] : inbox)
		.on('GET', '/apps/mail/api/messages', (req) => req.query.has('cursor') ? [] : inbox)
		.on('GET', '/apps/mail/api/triage/messages', () => ({}))
		.on('GET', '/apps/mail/api/triage/status', () => ({ enabled: false }))
		.on('POST', /^\/apps\/mail\/api\/mailboxes\/\d+\/sync$/, () => ({ newMessages: [], changedMessages: [], vanishedMessages: [], stats: { total: 2, unread: 1 } }))
		.on('GET', /^\/apps\/mail\/api\/messages\/(\d+)\/body$/, (_r, [id]) => body(inbox.find((m) => m.databaseId === Number(id))!))
		.on('PUT', /^\/apps\/mail\/api\/messages\/(\d+)\/flags$/, () => ({}))
})

afterEach(() => {
	cleanup()
	server.restore()
})

test('the inbox lists the mails with sender, address and subject', async () => {
	const { container } = await renderApp('mail', MailApp.Component!, '/')
	// Opens on Inbox (the merged view) once accounts and folders are in.
	await waitFor(() => getByText(container, 'Dinner on Friday?'))
	expect(location.pathname).toBe('/apps/mail/view/inbox')
	expect(getByText(container, 'Your invoice')).toBeTruthy()
	// The sender address is always shown (scam check, user request 2026-11-01).
	expect(getByText(container, 'shop@example.org')).toBeTruthy()
	expect(container.querySelector('.ml-message--unread')?.textContent).toContain('Dinner on Friday?')
	// Curated: asks the label list for the inbox folder, hiding ads/spam/newsletter/social.
	const list = server.calls('GET', '/apps/mail/api/triage/list')[0]
	expect(list.query.get('mailboxIds')).toBe('1')
	expect(list.query.get('exclude')).toBe('ads,spam,newsletter,social')
	expect(server.unhandled.map((r) => `${r.method} ${r.path}`)).toEqual([])
})

test('opening a mail shows it and marks it read', async () => {
	const { container } = await renderApp('mail', MailApp.Component!, '/view/inbox')
	await waitFor(() => getByText(container, 'Dinner on Friday?'))
	await click(getByText(container, 'Dinner on Friday?').closest('button')!)
	await waitFor(() => server.calls('GET', '/apps/mail/api/messages/11/body').length === 1)
	expect(location.pathname).toBe('/apps/mail/view/inbox/thread/11')
	const reader = container.querySelector('[aria-label="Message"]')!
	await waitFor(() => getByText(reader, 'Dinner on Friday?'))
	expect(reader.textContent).toContain('bob@atrium.test')
	await waitFor(() => server.calls('PUT', '/apps/mail/api/messages/11/flags').length === 1)
	expect(server.calls('PUT', '/apps/mail/api/messages/11/flags')[0].body).toEqual({ flags: { seen: true } })
	expect(server.unhandled.map((r) => `${r.method} ${r.path}`)).toEqual([])
})

test('writing and sending a message goes through the outbox', async () => {
	server
		.on('POST', '/apps/mail/api/outbox', (req) => ({ id: 77, ...(req.body as object) }))
		.on('POST', '/apps/mail/api/outbox/77', () => ({}))
	const { container } = await renderApp('mail', MailApp.Component!, '/view/inbox')
	await waitFor(() => getByText(container, 'Dinner on Friday?'))
	await click(getButton(container, 'New message'))
	const dialog = await waitFor(() => document.querySelector<HTMLElement>('.ml-composer') ?? document.querySelector<HTMLElement>('[role=dialog]'))
	await type(getField(dialog, 'To'), 'Bob <bob@atrium.test>')
	await type(getField(dialog, 'Subject'), 'Re: Dinner')
	await type(getField(dialog, 'Message'), 'Yes, Friday works.')
	await click(getButton(dialog, 'Send'))
	await waitFor(() => server.calls('POST', '/apps/mail/api/outbox/77').length === 1)
	const created = server.calls('POST', '/apps/mail/api/outbox')[0].body as Record<string, unknown>
	expect(created).toMatchObject({ accountId: 1, subject: 'Re: Dinner', bodyPlain: 'Yes, Friday works.', isHtml: false, to: [{ label: 'Bob', email: 'bob@atrium.test' }] })
	// The composer closes once the message is handed to the outbox.
	await waitFor(() => !document.querySelector('.ml-composer'))
	expect(server.unhandled.map((r) => `${r.method} ${r.path}`)).toEqual([])
})

test('a message without recipient is not sent', async () => {
	const { container } = await renderApp('mail', MailApp.Component!, '/view/inbox')
	await waitFor(() => getByText(container, 'Dinner on Friday?'))
	await click(getButton(container, 'New message'))
	const dialog = await waitFor(() => document.querySelector<HTMLElement>('.ml-composer') ?? document.querySelector<HTMLElement>('[role=dialog]'))
	await type(getField(dialog, 'Subject'), 'No one')
	await click(getButton(dialog, 'Send'))
	await new Promise((r) => setTimeout(r, 50))
	expect(server.calls('POST', '/apps/mail/api/outbox')).toEqual([])
})

test('save draft sends the fields to the draft endpoint', async () => {
	server.on('POST', '/apps/mail/api/accounts/1/draft', () => ({ id: 501 }))
	const { container } = await renderApp('mail', MailApp.Component!, '/view/inbox')
	await waitFor(() => getByText(container, 'Dinner on Friday?'))
	await click(getButton(container, 'New message'))
	const dialog = await waitFor(() => document.querySelector<HTMLElement>('.ml-composer') ?? document.querySelector<HTMLElement>('[role=dialog]'))
	await type(getField(dialog, 'To'), 'carol@example.org')
	await type(getField(dialog, 'Subject'), 'Plan')
	await type(getField(dialog, 'Message'), 'Draft text')
	await click(getButton(dialog, 'Save draft'))
	await waitFor(() => server.calls('POST', '/apps/mail/api/accounts/1/draft').length === 1)
	expect(server.calls('POST', '/apps/mail/api/accounts/1/draft')[0].body).toMatchObject({ subject: 'Plan', body: 'Draft text', to: 'carol@example.org', isHtml: false })
	expect(queryByText(document.body, 'Could not')).toBeNull()
})
