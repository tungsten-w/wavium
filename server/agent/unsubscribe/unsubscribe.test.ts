// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Assisted unsubscribe (P5-5): the agent tools on the sqlite mail fixture with a
// fake PHP bridge (no HTTP request ever leaves the test).
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { type Db, migrate, wrap } from '../db'
import { seedMail } from '../mail/fixture'
import { md5 } from '../mail/keys'
import type { Tool, ToolCtx } from '../tools'
import { type ListInfo, manualAdvice, unsubscribeTools } from './index'

let db: Db
let info: ListInfo
let posted: Array<[string, number, string]>
let tools: Record<string, Tool>
const A = `1:${md5('<c@x>')}` // mail 4, INBOX, from shop@y.test
const ONE = 'https://lists.y.test/u?id=1'

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	await seedMail(db)
	info = { url: ONE, one_click: true, mailto: 'mailto:leave@y.test' }
	posted = []
	const bridge = () => ({
		info: async (_uid: string, id: number) => { if (id !== 4) throw new Error('wrong id'); return info },
		unsubscribe: async (uid: string, id: number, url: string) => { posted.push([uid, id, url]); return { ok: true, status: 200 } },
	})
	tools = Object.fromEntries(unsubscribeTools(bridge)({} as never).map((t) => [t.name, t]))
})

const ctx = (grantor = 'ann') => ({ db, grantor }) as unknown as ToolCtx

test('info says what the list offers and what the owner can do', async () => {
	expect(await tools.mail_unsubscribe_info.run!(ctx(), { message_key: A })).toEqual({ message_key: A, one_click: true, has_web_link: true, has_mailto: true, advice: null })
	info = { url: 'https://y.test/page', one_click: false, mailto: null }
	expect(await tools.mail_unsubscribe_info.run!(ctx(), { message_key: A })).toMatchObject({ one_click: false, advice: expect.stringContaining('web page') })
	expect(manualAdvice({ url: null, one_click: false, mailto: 'mailto:x@y' })).toContain('by email')
	expect(manualAdvice({ url: null, one_click: false, mailto: null })).toContain('no unsubscribe header')
	await expect(tools.mail_unsubscribe_info.run!(ctx('bob'), { message_key: A })).rejects.toMatchObject({ code: 'not_found' })
})

test('unsubscribe needs the owner\'s approval and freezes the link', async () => {
	const t = tools.mail_unsubscribe
	expect(t.action).toBe('send')
	const p = await t.prepare!(ctx(), { message_key: A })
	expect(p).toEqual({ payload: { message_key: A, id: 4, url: ONE }, summary: 'Unsubscribe from the list of "Invoice" (lists.y.test)', ref: A })
	expect(posted).toEqual([]) // preparing never contacts the list
	expect(await t.stillValid!(ctx(), p.payload)).toBe(true)
	expect(await t.execute!(ctx(), p.payload, { request_id: 'apr_1' })).toEqual({ message_key: A, unsubscribed: true, http_status: 200 })
	expect(posted).toEqual([['ann', 4, ONE]])
	// The link changed after the request: the approval is void.
	info = { ...info, url: 'https://evil.test/x' }
	expect(await t.stillValid!(ctx(), p.payload)).toBe(false)
})

test('no one-click link: refused with what to do instead; gone mail refused', async () => {
	info = { url: 'https://y.test/page', one_click: false, mailto: 'mailto:leave@y.test' }
	await expect(tools.mail_unsubscribe.prepare!(ctx(), { message_key: A })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('web page') })
	await db.q(`UPDATE oc_mail_messages SET server_gone_at = 1 WHERE id = 4`)
	info = { url: ONE, one_click: true, mailto: null }
	await expect(tools.mail_unsubscribe.prepare!(ctx(), { message_key: A })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('no longer on the mail server') })
	expect(posted).toEqual([])
})
