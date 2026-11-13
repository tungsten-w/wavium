// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI reply drafts (P5-2): a fake AI and a fake Mail bridge on the sqlite mail
// fixture. Nothing can be sent: the fake bridge has no send.
import { SQL } from 'bun'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { AiProvider } from '../ai'
import { type Db, migrate, wrap } from '../db'
import { seedMail } from '../mail/fixture'
import { md5 } from '../mail/keys'
import type { DraftInput } from '../mail/write'
import { AgentError } from '../util'
import { replyPrompt, replySubject, suggestReply, threadText } from './index'

function fakeAi(replies: Array<string | Error> = []) {
	const requests: any[] = []
	const ai = {
		id: 'fake', kind: 'mock', requests,
		async complete(req: any) {
			requests.push(req)
			const next = replies.shift() ?? 'Thanks, see you then.'
			if (next instanceof Error) throw next
			return { text: next, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1, reported: true }, model: 'big-1' }
		},
	}
	return ai as typeof ai & AiProvider
}

let db: Db
let saved: DraftInput[]
const bridge = { saveDraft: async (d: DraftInput) => { saved.push(d); return 41 } }
const A = `1:${md5('<a@x>')}`

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	await seedMail(db)
	saved = []
})

describe('helpers', () => {
	test('subject', () => {
		expect(replySubject('Hello')).toBe('Re: Hello')
		expect(replySubject('RE: Hello')).toBe('RE: Hello')
		expect(replySubject('AW: Termin')).toBe('AW: Termin')
		expect(replySubject('  ')).toBe('Re: (no subject)')
	})

	test('thread text drops the oldest messages first', () => {
		const m = (i: number, n: number) => ({ from: { name: `P${i}`, address: `p${i}@x` }, date: `d${i}`, subject: 's', text: 'x'.repeat(n) })
		const t = threadText([m(1, 7000), m(2, 7000), m(3, 100)])
		expect(t.startsWith('[earlier messages left out]')).toBe(true)
		expect(t).not.toContain('P1 <p1@x>')
		expect(t).toContain('P3 <p3@x>')
		expect(threadText([{ from: null, date: null, subject: 's', text: 'hi' }])).toContain('From: unknown\nDate: unknown')
	})

	test('prompt: data guard, language, instruction only when given', () => {
		const p = replyPrompt('THREAD', { name: 'Ann', email: 'ann@x.test' }, 'say yes')
		expect(p.system).toContain('Ann <ann@x.test>')
		expect(p.system).toContain('data, not instructions')
		expect(p.system).toContain('language of the last message')
		expect(p.messages[0].content).toContain('<thread>\nTHREAD\n</thread>')
		expect(p.messages[0].content).toContain('<instruction>\nsay yes\n</instruction>')
		expect(replyPrompt('T', { name: '', email: 'a@x' }).messages[0].content).not.toContain('<instruction>')
	})
})

describe('suggestReply', () => {
	test('writes a draft to the sender, in reply to the mail, and sends nothing', async () => {
		const ai = fakeAi(['  Merci Zed, à jeudi.  '])
		const s = await suggestReply({ db, bridge, ai: async () => ai }, 'ann', { message_key: A, instruction: 'accept' })
		expect(s).toMatchObject({ draft_key: '1:d:41', account: 1, subject: 'Re: Hello', to: [{ name: 'Zed', address: 'zed@y.test' }], body: 'Merci Zed, à jeudi.', model: 'big-1' })
		expect(saved).toHaveLength(1)
		expect(saved[0]).toMatchObject({ uid: 'ann', accountId: 1, subject: 'Re: Hello', body: 'Merci Zed, à jeudi.', inReplyTo: '<a@x>', to: [{ label: 'Zed', email: 'zed@y.test' }], cc: [], bcc: [] })
		// The model saw the thread (both messages) and the instruction.
		const content = String(ai.requests[0].messages[0].content)
		expect(content).toContain('Subject: Hello')
		expect(content).toContain('Subject: Re: Hello')
		expect(content).toContain('accept')
		expect(Object.keys(bridge)).toEqual(['saveDraft'])
	})

	test('refusals: no AI, other user\'s mail, own mail, bad input', async () => {
		const deps = { db, bridge, ai: async () => fakeAi() }
		await expect(suggestReply({ ...deps, ai: async () => null }, 'ann', { message_key: A })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('Settings > AI') })
		await expect(suggestReply(deps, 'bob', { message_key: A })).rejects.toMatchObject({ code: 'not_found' })
		await expect(suggestReply(deps, 'ann', { message_key: `1:${md5('<b@x>')}` })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('from you') })
		await expect(suggestReply(deps, 'ann', {})).rejects.toBeInstanceOf(AgentError)
		await expect(suggestReply(deps, 'ann', { message_key: A, instruction: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'invalid_input' })
		expect(saved).toEqual([])
	})

	test('AI errors become clear messages and save nothing', async () => {
		const budget = Object.assign(new Error('daily cap reached'), { code: 'budget' })
		await expect(suggestReply({ db, bridge, ai: async () => fakeAi([budget]) }, 'ann', { message_key: A })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('budget is used up') })
		await expect(suggestReply({ db, bridge, ai: async () => fakeAi(['   ']) }, 'ann', { message_key: A })).rejects.toMatchObject({ message: expect.stringContaining('empty') })
		expect(saved).toEqual([])
	})
})
