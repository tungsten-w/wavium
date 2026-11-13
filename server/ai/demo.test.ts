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

test('digest summary uses the headline', async () => {
	const ai = createMockProvider({ defaultModel: 'demo' })
	const r = await ai.complete({ system: 'You write the opening of a person\'s morning digest', messages: [{ role: 'user', content: '<digest>\n2 mails need a reply · 1 event\n\nMail:\n- x\n</digest>' }] })
	expect(r.text).toBe('Aujourd\'hui : 2 mails need a reply · 1 event. Commence par les mails qui attendent une réponse.')
})
