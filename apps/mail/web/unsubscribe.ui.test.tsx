// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Assisted unsubscribe banner (P5-5): nothing happens without the confirmation;
// one-click goes to Mail's route, a web link opens a tab, a mailto fills the composer.
import '../../../core/web/testing/dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fakeServer, type FakeServer } from '../../../core/web/testing/fakeServer'
import { cleanup, click, getButton, getByText, queryByText, render, waitFor } from '../../../core/web/testing/render'
import { parseMailto, type MessageBody } from './api'
import { UnsubscribeBanner } from './Unsubscribe'

let server: FakeServer
const body = (over: Partial<MessageBody>): MessageBody => ({
	uid: 1, messageId: '<n@x>', from: [{ label: 'News', email: 'news@list.test' }], to: [], replyTo: [], cc: [], bcc: [], subject: 'Weekly', dateInt: 0,
	body: '', hasHtmlBody: false, attachments: [], inlineAttachments: [], accountId: 1, mailboxId: 1, databaseId: 11, isSenderTrusted: false, ...over,
})

beforeEach(() => { server = fakeServer() })
afterEach(() => { cleanup(); server.restore(); vi.restoreAllMocks() })

test('one-click: confirm, then Mail\'s unsubscribe route; nothing before the click', async () => {
	server.on('POST', '/apps/mail/api/list/unsubscribe/11', () => ({ status: 'success', data: null }))
	const { container } = await render(<UnsubscribeBanner body={body({ unsubscribeUrl: 'https://list.test/u?id=9', isOneClickUnsubscribe: true })} onMailto={() => {}} />)
	await click(getButton(container, 'Unsubscribe…'))
	expect(getByText(document.body, /ask list\.test to remove you/)).toBeTruthy()
	expect(server.calls('POST', '/apps/mail/api/list/unsubscribe/11')).toHaveLength(0)
	await click(getButton(document.body, 'Unsubscribe'))
	await waitFor(() => getByText(container, /Unsubscribed\./))
	expect(server.calls('POST', '/apps/mail/api/list/unsubscribe/11')).toHaveLength(1)
})

test('cancel does nothing; a web page opens in a new tab', async () => {
	const open = vi.spyOn(window, 'open').mockImplementation(() => null)
	const { container } = await render(<UnsubscribeBanner body={body({ unsubscribeUrl: 'https://promo.test/u/bob', isOneClickUnsubscribe: false })} onMailto={() => {}} />)
	await click(getButton(container, 'Unsubscribe…'))
	await click(getButton(document.body, 'Cancel'))
	expect(open).not.toHaveBeenCalled()
	await click(getButton(container, 'Unsubscribe…'))
	expect(getByText(document.body, /opens in a new tab/)).toBeTruthy()
	await click(getButton(document.body, 'Open the page'))
	expect(open).toHaveBeenCalledWith('https://promo.test/u/bob', '_blank', 'noopener,noreferrer')
	expect(server.log).toHaveLength(0)
})

test('mailto fills the composer; no header or a non-web link shows nothing', async () => {
	const onMailto = vi.fn()
	const { container } = await render(<UnsubscribeBanner body={body({ unsubscribeMailto: 'mailto:leave@list.test?subject=Remove%20me' })} onMailto={onMailto} />)
	await click(getButton(container, 'Unsubscribe…'))
	await click(getButton(document.body, 'Prepare the mail'))
	expect(onMailto).toHaveBeenCalledWith({ to: 'leave@list.test', subject: 'Remove me', body: '' })
	cleanup()
	const none = await render(<UnsubscribeBanner body={body({})} onMailto={onMailto} />)
	expect(queryByText(none.container, /mailing list/)).toBeNull()
	cleanup()
	const js = await render(<UnsubscribeBanner body={body({ unsubscribeUrl: 'javascript:alert(1)', isOneClickUnsubscribe: true })} onMailto={onMailto} />)
	expect(queryByText(js.container, /mailing list/)).toBeNull()
})

test('parseMailto', () => {
	expect(parseMailto('mailto:a@b.test')).toEqual({ to: 'a@b.test', subject: 'unsubscribe', body: '' })
	expect(parseMailto('MAILTO:a@b.test?subject=x&body=y%20z')).toEqual({ to: 'a@b.test', subject: 'x', body: 'y z' })
	expect(parseMailto('https://x')).toBeNull()
	expect(parseMailto('mailto:not-an-address')).toBeNull()
	expect(parseMailto('mailto:a@b.test,c@d.test')).toBeNull()
})
