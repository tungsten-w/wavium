// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "demo" model of the mock provider: plausible answers on the demo stack, the
// plain mock otherwise. Checked against the real request builders.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { demoClassify, demoExtract, demoReply, demoRule } from './demo'
import { createMockProvider } from './index'
import { classify, parseQuestions } from './triage'

const QS = parseQuestions(JSON.parse(readFileSync(join(import.meta.dir, '../../apps/mail/lib/Service/Triage/questions.json'), 'utf8')).questions)

test('classification from keywords, valid for mail-v2', async () => {
	expect(demoClassify('From: EDF <factures@edf.fr>\nSubject: Votre facture\n\nà régler avant le 30')).toMatchObject({ category: 'admin', needs_action: 0.8, urgency: 'this_week' })
	expect(demoClassify('From: x@bnq-verif.biz\nSubject: URGENT : votre compte sera suspendu\n\ncliquez ici')).toMatchObject({ category: 'spam', suspicious: 0.95 })
	expect(demoClassify('From: Bob <bob@atrium.test>\nSubject: Dîner samedi ?\n\nTu es libre ?')).toMatchObject({ category: 'personal', needs_reply: 0.85 })
	// Through the real pipeline: the mock with model "demo" passes triage's checks.
	const ai = createMockProvider({ defaultModel: 'demo' })
	const d = await classify(ai, 'From: Shop\nSubject: Votre commande a été expédiée', QS)
	expect(d.answers[0]).toMatchObject({ choice: 'orders' })
	// Any other model: the plain mock (sample answer).
	expect((await classify(createMockProvider(), 'Subject: Votre commande', QS)).answers[0]).toMatchObject({ choice: 'personal' })
})

test('rule, dates and reply', () => {
	const schema = { properties: { move_to: { description: 'Folder to move to. Folders: 5 = Archive; 7 = Admin' } } }
	expect(demoRule('les factures de energie.example.com dans Admin, marquées lues', schema)).toMatchObject({ from_domain: 'energie.example.com', category: 'admin', move_to: 7, mark_read: true })
	expect(demoExtract('Sent: 2026-11-13 09:00 (Europe/Paris)\nSubject: Réunion projet jeudi 14h\n\n<email>\nOn se voit jeudi 14h ?\n</email>')).toEqual({ events: [{ title: 'Réunion projet jeudi 14h', start: '2026-11-19T14:00' }], tasks: [] })
	expect(demoExtract('Sent: 2026-11-13 09:00 (UTC)\nSubject: Votre facture\n\n<email>\nà régler avant le 30/11\n</email>').tasks).toEqual([{ title: 'Payer la facture', due: '2026-11-30' }])
	expect(demoReply('<thread>\nFrom: Bob Durand <bob@x>\nSubject: Dîner ?\n\nSalut, tu es libre ?\n</thread>')).toStartWith('Bonjour Bob,')
})

test('digest summary uses the headline, in the language asked (V4-1)', async () => {
	const ai = createMockProvider({ defaultModel: 'demo' })
	const digest = { messages: [{ role: 'user' as const, content: '<digest>\n2 mails need a reply · 1 event\n\nMail:\n- x\n</digest>' }] }
	const fr = await ai.complete({ system: 'You write the opening of a person\'s morning digest: one or two short sentences, plain text, in French, ...', ...digest })
	expect(fr.text).toBe('Aujourd\'hui : 2 mails need a reply · 1 event. Commence par les mails qui attendent une réponse.')
	const en = await ai.complete({ system: 'You write the opening of a person\'s morning digest: one or two short sentences, plain text, in English, ...', ...digest })
	expect(en.text).toBe('Today: 2 mails need a reply · 1 event. Start with the mail waiting for an answer.')
})

test('assistant answers in the language the person writes in (V4-1)', async () => {
	const ai = createMockProvider({ defaultModel: 'demo' })
	const tools = ['calendar_event_list'].map((name) => ({ name, description: '', inputSchema: { type: 'object' } }))
	const sys = 'You are the assistant built into Wavium, working for Alice.'
	const hello = await ai.complete({ system: sys, tools, toolChoice: 'auto', messages: [{ role: 'user', content: 'hello, what can you do?' }] })
	expect(hello.text).toContain("I'm Wavium's demo AI")
	const results = await ai.complete({ system: sys, tools, toolChoice: 'auto', messages: [
		{ role: 'user', content: 'show my calendar' },
		{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'calendar_event_list', input: {} }] },
		{ role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: JSON.stringify({ events: [{ start: '2026-11-18T09:00', title: 'Standup' }] }) }] },
	] as never })
	expect(results.text).toStartWith('Your calendar:')
	const fr = await ai.complete({ system: sys, tools, toolChoice: 'auto', messages: [{ role: 'user', content: 'bonjour' }] })
	expect(fr.text).toContain("Je suis l'IA de démo")
})

test('assistant: French intents call offered tools, results become short French lines', async () => {
	const ai = createMockProvider({ defaultModel: 'demo' })
	const tools = ['mail_message_list', 'notes_note_create', 'calendar_event_list', 'search'].map((name) => ({ name, description: '', inputSchema: { type: 'object' } }))
	const sys = 'You are the assistant built into Wavium, working for Alice.'
	const ask = (content: any) => ai.complete({ system: sys, tools, toolChoice: 'auto', messages: [{ role: 'user', content }] })
	expect((await ask('Montre mes derniers mails')).toolCalls).toMatchObject([{ name: 'mail_message_list', input: { limit: 5 } }])
	expect((await ask('note : acheter du pain')).toolCalls).toMatchObject([{ name: 'notes_note_create', input: { content: 'acheter du pain' } }])
	expect((await ask('cherche facture')).toolCalls).toMatchObject([{ name: 'search', input: { query: 'facture' } }])
	// Not offered (no grant): no call, the help text instead.
	expect((await ask('mes tâches')).text).toContain("IA de démo")
	const r = await ask([{ type: 'tool_result', toolCallId: 'c1', content: JSON.stringify({ messages: [{ from: { name: 'Bob' }, subject: 'Dîner ?' }] }) }])
	expect(r.text).toBe('Tes derniers mails :\n- Bob : Dîner ?')
	const p = await ask([{ type: 'tool_result', toolCallId: 'c2', content: JSON.stringify({ status: 'pending_approval', request_id: 'apr_1' }) }])
	expect(p.text).toContain('accord')
	// The dev convention still works.
	expect((await ask('mock-tool: notes_note_create {"content":"x"}')).toolCalls).toMatchObject([{ name: 'notes_note_create', input: { content: 'x' } }])
})
