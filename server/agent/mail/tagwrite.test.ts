// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// mail_message_tag (V4-24): the tool that finally lets an agent sort mail.
// Before it, the only write an agent had on a mail was seen/starred/folder, so
// `claude-mail` could star a mail and nothing else.
//
// What matters here: the tag lands in the classification and reads back; the
// owner's own answer wins; and tagging never moves or deletes a mail (rule A10).
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { type Db, migrate, wrap } from '../db'
import type { Tool, ToolCtx } from '../tools'
import { AgentError } from '../util'
import { classify, seedMail } from './fixture'
import { md5 } from './keys'
import { listMessages } from './read'
import { mailWrites, type MailBridge } from './write'
import { CORRECTED_BY_USER, TAGGED_BY_AGENT } from './tags'

let db: Db
let touched: string[]
let tool: Tool

/** A bridge that records anything that would reach the mail server. */
const bridge = (): MailBridge => ({
	fetchBody: async () => { touched.push('fetchBody') },
	flags: async () => { touched.push('flags') },
	move: async () => { touched.push('move') },
	trash: async () => { touched.push('trash') },
	attachment: async () => { touched.push('attachment'); throw new Error('unused') },
	saveDraft: async () => { touched.push('saveDraft'); return 0 },
	send: async () => { touched.push('send') },
	route: async () => null,
})

const ctx = (grantor = 'ann'): ToolCtx => ({ db, grantor, agent: { uid: 'agent1', displayName: 'Agent', owner: grantor } } as unknown as ToolCtx)
/** The same two steps callTool() runs for a tool with prepare/execute. */
let lastSummary = ''
async function tag(input: Record<string, unknown>, grantor?: string) {
	const c = ctx(grantor)
	const prepared = await tool.prepare!(c, input)
	lastSummary = prepared.summary
	return tool.execute!(c, prepared.payload, null)
}
const key = (account: number, mid: string) => `${account}:${md5(mid)}`
const triage = async (account: number, mid: string) => (await db.q<Record<string, unknown>>(`SELECT * FROM oc_mail_triage WHERE account_id = $1 AND msg_hash = $2`, [account, md5(mid)]))[0]

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	await seedMail(db)
	touched = []
	tool = mailWrites(bridge()).find((t) => t.name === 'mail_message_tag')!
})

test('it is a mail write, so the owner\'s mail grant governs it', () => {
	expect(tool).toBeDefined()
	expect(tool.area).toBe('mail')
	expect(tool.action).toBe('write')
	// `write` is allowed or off, never "approval" (access.ts gates delete, send
	// and share only), which is why there is no stillValid here.
	expect(tool.prepare).toBeDefined()
	expect(tool.execute).toBeDefined()
})

test('the owner reads a sentence, not a message key, in Settings > Agents', async () => {
	await tag({ message_key: key(1, '<c@x>'), add: ['promo', 'important'], remove: ['urgent'] })
	expect(lastSummary).toBe('Tagged "Invoice" as promo, important, no longer urgent')
})

test('tagging a classified mail changes the classification and reads back', async () => {
	// Fixture: <c@x> (mail 4, account 1) is classified ads/never.
	expect(await tag({ message_key: key(1, '<c@x>'), add: ['spam'] })).toEqual({ message_key: key(1, '<c@x>'), tags: ['spam'] })
	const row = await triage(1, '<c@x>')
	expect(row.category).toBe('spam')
	expect(Number(row.category_confidence)).toBe(1)
	expect(Number(row.suspicious)).toBe(1)
	expect(row.model).toBe(TAGGED_BY_AGENT)
})

test('the two planes stack on one mail', async () => {
	await tag({ message_key: key(1, '<c@x>'), add: ['etudes', 'important', 'urgent'] })
	const res = await tag({ message_key: key(1, '<c@x>'), remove: ['urgent'] })
	expect(res).toEqual({ message_key: key(1, '<c@x>'), tags: ['important', 'etudes'] })
})

test('a mail nobody classified yet gets a classification from the agent', async () => {
	// Fixture: <b@x> (Re: Hello) has no triage row.
	expect(await triage(1, '<b@x>')).toBeUndefined()
	expect(await tag({ message_key: key(1, '<b@x>'), add: ['important'] })).toEqual({ message_key: key(1, '<b@x>'), tags: ['important'] })
	const row = await triage(1, '<b@x>')
	expect(row.version).toBe('agent')
	expect(row.model).toBe(TAGGED_BY_AGENT)
	expect(row.category).toBeNull()
	expect(Number(row.needs_action)).toBe(1)
})

test('the owner\'s own answer is the last word', async () => {
	await classify(db, 1, '<b@x>', 'personal', { model: CORRECTED_BY_USER, confidence: 1 })
	await expect(tag({ message_key: key(1, '<b@x>'), add: ['spam'] })).rejects.toMatchObject({ code: 'conflict' })
	expect((await triage(1, '<b@x>')).category).toBe('personal')
})

test('tagging never reaches the mail server: nothing moved, nothing trashed', async () => {
	await tag({ message_key: key(1, '<c@x>'), add: ['spam'] })
	await tag({ message_key: key(1, '<c@x>'), add: ['important'] })
	expect(touched).toEqual([])
	// And the mail is still in the folder it was in.
	const [m] = await db.q<{ mailbox_id: unknown }>(`SELECT mailbox_id FROM oc_mail_messages WHERE id = 4`)
	expect(Number(m.mailbox_id)).toBe(10)
})

test('refusals: unknown tag, someone else\'s mail, nothing to change', async () => {
	await expect(tag({ message_key: key(1, '<c@x>'), add: ['vacances'] })).rejects.toThrow(AgentError)
	await expect(tag({ message_key: key(1, '<c@x>'), remove: ['spam'] })).rejects.toThrow(/add the right tag instead/)
	await expect(tag({ message_key: key(1, '<c@x>') })).rejects.toThrow(/Nothing to change/)
	await expect(tag({ message_key: key(1, '<c@x>'), add: ['spam'] }, 'bob')).rejects.toMatchObject({ code: 'not_found' })
})

test('what the agent set, the agent can find again: the tag filter', async () => {
	const subjects = async (t: string | string[]) => (await listMessages(db, 'ann', { tag: t })).messages.map((m) => m.subject)
	// Fixture: <a@x> Hello is personal/today/needs_reply 0.9 -> important + urgent.
	expect(await subjects('important')).toEqual(['Hello'])
	expect(await subjects('urgent')).toEqual(['Hello'])
	expect(await subjects(['important', 'urgent'])).toEqual(['Hello'])
	expect(await subjects('promo')).toEqual(['Invoice'])
	expect(await subjects('etudes')).toEqual([])
	await tag({ message_key: key(1, '<c@x>'), add: ['etudes'] })
	expect(await subjects('etudes')).toEqual(['Invoice'])
	expect(await subjects('promo')).toEqual([])
	await expect(listMessages(db, 'ann', { tag: 'nope' })).rejects.toThrow(AgentError)
})

test('every row carries its tags, so a list says what each mail is', async () => {
	const res = await listMessages(db, 'ann', {})
	expect(res.messages.map((m) => [m.subject, m.tags])).toEqual([
		['Invoice', ['promo']],
		['Re: Hello', []],
		['Hello', ['important', 'urgent']],
	])
})
