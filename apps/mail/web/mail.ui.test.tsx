// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mail UI against a fake server (P1-6): the list, opening a mail, writing and
// sending a message, saving a draft. The fake answers like apps/mail's API.
import '../../../core/web/testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { fakeServer, type FakeServer } from '../../../core/web/testing/fakeServer'
import { cleanup, click, getButton, getByText, getField, queryByText, render, renderApp, type, waitFor } from '../../../core/web/testing/render'
import { Snackbars } from '@atrium/ui'
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
		.on('GET', /^\/apps\/mail\/api\/messages\/\d+\/thread$/, () => [])
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

test('suggest a reply: the AI text lands in the composer, nothing is sent', async () => {
	server.on('POST', '/agent/v1/reply/suggest', () => ({ subject: 'Re: Dinner on Friday?', body: 'Yes, Friday works for me.', model: 'mock-1', draft_key: '', sent: false }))
	const { container } = await renderApp('mail', MailApp.Component!, '/view/inbox')
	await waitFor(() => getByText(container, 'Dinner on Friday?'))
	await click(getByText(container, 'Dinner on Friday?').closest('button')!)
	const reader = await waitFor(() => container.querySelector('[aria-label="Message"]'))
	await click(await waitFor(() => getButton(reader, 'Suggest a reply')))
	const dialog = await waitFor(() => document.querySelector<HTMLElement>('.ml-composer'))
	const call = server.calls('POST', '/agent/v1/reply/suggest')[0]
	expect(call.body).toEqual({ db_id: 11, save: false })
	expect(call.headers.get('ocs-apirequest')).toBe('true')
	expect((getField(dialog, 'Subject') as HTMLInputElement).value).toBe('Re: Dinner on Friday?')
	expect((getField(dialog, 'Message') as HTMLTextAreaElement).value).toMatch(/^Yes, Friday works for me\.[\s\S]*wrote:\n> /)
	expect((getField(dialog, 'To') as HTMLInputElement).value).toContain('bob@atrium.test')
	expect(server.calls('POST', '/apps/mail/api/outbox')).toHaveLength(0)
})

test('suggest a reply without an AI opens nothing', async () => {
	server.on('POST', '/agent/v1/reply/suggest', () => new Response(JSON.stringify({ error: { message: 'No AI is set up for drafting: add one in Settings > AI' } }), { status: 503, headers: { 'content-type': 'application/json' } }))
	const { container } = await renderApp('mail', MailApp.Component!, '/view/inbox')
	await waitFor(() => getByText(container, 'Dinner on Friday?'))
	await click(getByText(container, 'Dinner on Friday?').closest('button')!)
	const reader = await waitFor(() => container.querySelector('[aria-label="Message"]'))
	await click(await waitFor(() => getButton(reader, 'Suggest a reply')))
	await waitFor(() => server.calls('POST', '/agent/v1/reply/suggest').length === 1)
	// The error goes to a toast (the shell shows it); the composer never opens and the button is usable again.
	await waitFor(() => !(getButton(reader, 'Suggest a reply') as HTMLButtonElement).disabled)
	expect(document.querySelector('.ml-composer')).toBeNull()
})

test('delete moves to Trash with Undo; Undo syncs Trash and puts the mail back', async () => {
	server
		.on('DELETE', '/apps/mail/api/messages/11', () => ({}))
		.on('POST', '/agent/v1/mail/undo-delete', () => ({ restored: true, to: 1 }))
	const bar = await render(<Snackbars />)
	const { container } = await renderApp('mail', MailApp.Component!, '/view/inbox')
	await waitFor(() => getByText(container, 'Dinner on Friday?'))
	await click(getByText(container, 'Dinner on Friday?').closest('button')!)
	const reader = await waitFor(() => container.querySelector('[aria-label="Message"]'))
	await click(getButton(reader, 'Delete message'))
	await waitFor(() => server.calls('DELETE', '/apps/mail/api/messages/11').length === 1)
	await waitFor(() => getByText(document.body, 'Moved to Trash'))
	expect(server.calls('POST', '/agent/v1/mail/undo-delete')).toHaveLength(0)
	await click(getButton(document.body, 'Undo'))
	await waitFor(() => server.calls('POST', '/agent/v1/mail/undo-delete').length === 1)
	// Trash (4) is synced first, then the mail is looked up by its Message-ID and sent back to INBOX (1).
	expect(server.calls('POST', '/apps/mail/api/mailboxes/4/sync')).toHaveLength(1)
	expect(server.calls('POST', '/agent/v1/mail/undo-delete')[0].body).toEqual({ account: 1, message_id: expect.any(String), to: 1 })
	await waitFor(() => getByText(document.body, 'Message restored'))
	void bar
})

test('To suggests contacts after two letters; picking one completes the last address', async () => {
	server.on('GET', '/apps/mail/api/autoComplete', (req) => req.query.get('term') === 'bo' ? [{ id: 1, label: 'Bob Durand', email: 'bob@atrium.test' }, { id: 2, label: 'bob2@x.test', email: 'bob2@x.test' }] : [])
	const { container } = await renderApp('mail', MailApp.Component!, '/view/inbox')
	await waitFor(() => getByText(container, 'Dinner on Friday?'))
	await click(getButton(container, 'New message'))
	const dialog = await waitFor(() => document.querySelector<HTMLElement>('.ml-composer'))
	const to = getField(dialog, 'To') as HTMLInputElement
	to.focus()
	await type(to, 'claire@x.test, bo')
	const list = await waitFor(() => dialog.querySelector('[aria-label="To suggestions"]'))
	expect(server.calls('GET', '/apps/mail/api/autoComplete').at(-1)!.query.get('term')).toBe('bo')
	expect(list.textContent).toContain('bob@atrium.test')
	await click(getByText(list as HTMLElement, 'Bob Durand').closest('button')!)
	expect(to.value).toBe('claire@x.test, Bob Durand <bob@atrium.test>, ')
	await waitFor(() => !dialog.querySelector('[aria-label="To suggestions"]'))
})

test('the reader lists the other messages of the conversation; one click opens one', async () => {
	server.on('GET', '/apps/mail/api/messages/11/thread', () => [inbox[0], { ...inbox[1], databaseId: 12, previewText: 'Earlier: shall we?' }])
	const { container } = await renderApp('mail', MailApp.Component!, '/view/inbox')
	await waitFor(() => getByText(container, 'Dinner on Friday?'))
	await click(getByText(container, 'Dinner on Friday?').closest('button')!)
	const conv = await waitFor(() => container.querySelector('[aria-label="Conversation"]'))
	expect(conv.textContent).toContain('1 other message in this conversation')
	expect(conv.textContent).toContain('Earlier: shall we?')
	await click(conv.querySelector('button')!)
	await waitFor(() => location.pathname === '/apps/mail/view/inbox/thread/12')
})

test('snooze: the first time creates the Snoozed folder, then snoozes the mail', async () => {
	server
		.on('POST', '/apps/mail/api/mailboxes', () => box(9, 'Snoozed', ''))
		.on('PATCH', '/apps/mail/api/accounts/1', () => ({ ...account, snoozeMailboxId: 9 }))
		.on('POST', '/apps/mail/api/messages/11/snooze', () => ({}))
	const { container } = await renderApp('mail', MailApp.Component!, '/view/inbox')
	await waitFor(() => getByText(container, 'Dinner on Friday?'))
	await click(getByText(container, 'Dinner on Friday?').closest('button')!)
	const reader = await waitFor(() => container.querySelector('[aria-label="Message"]'))
	await click(getButton(reader, 'More actions'))
	await click(await waitFor(() => getByText(document.body, 'Snooze…')))
	await click(await waitFor(() => getButton(document.body, 'Tomorrow morning (08:00)')))
	await waitFor(() => server.calls('POST', '/apps/mail/api/messages/11/snooze').length === 1)
	expect(server.calls('POST', '/apps/mail/api/mailboxes')[0].body).toEqual({ accountId: 1, name: 'Snoozed' })
	expect(server.calls('PATCH', '/apps/mail/api/accounts/1')[0].body).toEqual({ snoozeMailboxId: 9 })
	const s = server.calls('POST', '/apps/mail/api/messages/11/snooze')[0].body as { unixTimestamp: number, destMailboxId: number }
	expect(s.destMailboxId).toBe(9)
	expect(new Date(s.unixTimestamp * 1000).getHours()).toBe(8)
	await waitFor(() => !getByText(container, 'Your invoice') || !queryByText(container, 'Dinner on Friday?') ? true : null)
})
