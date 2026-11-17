// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fake conversations for the public demo and dev (V4-7): no phone, no Google.
import type { SideConversation, SideMessage } from './store'

interface Seed { id: string, name: string, number: string, kind: 'sms' | 'rcs', readOnly?: boolean, lines: Array<[minutesAgo: number, fromMe: boolean, text: string]> }

const ALICE: Seed[] = [
	{ id: 'demo-bob', name: 'Bob', number: '+33 6 11 22 33 44', kind: 'rcs', lines: [
		[60 * 26, false, 'Tu as vu le mail de la mairie pour la réunion ?'],
		[60 * 25, true, 'Oui, jeudi 18h30, je t\'ajoute au calendrier'],
		[42, false, 'Top. Tu peux apporter les plans du jardin ?'],
		[41, false, 'Et on se retrouve au café avant ? 🙂'],
	] },
	{ id: 'demo-maman', name: 'Maman', number: '+33 6 98 76 54 32', kind: 'sms', lines: [
		[60 * 50, false, 'Bon anniversaire ma chérie ! 🎂'],
		[60 * 49, true, 'Merci maman ❤️'],
		[60 * 3, false, 'Tu viens dimanche ? Je fais un gratin'],
	] },
	{ id: 'demo-bank', name: 'BANQUE', number: '38015', kind: 'sms', readOnly: true, lines: [
		[95, false, 'BANQUE : votre code de vérification est 482 913. Ne le communiquez jamais.'],
	] },
	{ id: 'demo-colis', name: 'Colis Express', number: '36179', kind: 'sms', readOnly: true, lines: [
		[60 * 5, false, 'Votre colis 7Y4-221 sera livré demain entre 9h et 13h. Suivi : colis.example/7Y4'],
	] },
	{ id: 'demo-lea', name: 'Léa', number: '+33 7 55 44 33 22', kind: 'rcs', lines: [
		[60 * 72, true, 'Merci pour hier soir !'],
		[60 * 71, false, 'Avec plaisir, à refaire 😄'],
	] },
]

const BOB: Seed[] = [
	{ id: 'demo-alice', name: 'Alice', number: '+33 6 12 34 56 78', kind: 'rcs', lines: [
		[60 * 25, false, 'Oui, jeudi 18h30, je t\'ajoute au calendrier'],
		[42, true, 'Top. Tu peux apporter les plans du jardin ?'],
	] },
	{ id: 'demo-garage', name: 'Garage Martin', number: '+33 4 72 00 00 00', kind: 'sms', lines: [
		[60 * 6, false, 'Bonjour, votre voiture est prête. Vous pouvez passer à partir de 14h.'],
	] },
]

export function demoConversations(uid: string, now: number): Array<{ conversation: SideConversation, messages: SideMessage[] }> {
	const seeds = uid === 'bob' ? BOB : ALICE
	return seeds.map((s) => {
		const messages: SideMessage[] = s.lines.map(([ago, fromMe, text], i) => ({
			id: `${s.id}-${i}`, conversation_id: s.id, at: now - ago * 60_000, from_me: fromMe,
			sender_id: fromMe ? 'me' : `p-${s.id}`, sender_name: fromMe ? '' : s.name, sender_number: fromMe ? '' : s.number,
			text, status: fromMe ? 'read' : 'received', media: [],
		}))
		const last = messages[messages.length - 1]
		return {
			conversation: {
				id: s.id, name: s.name, is_group: false, unread: !last.from_me && last.at > now - 86_400_000, last_at: last.at, kind: s.kind,
				read_only: s.readOnly ?? false, outgoing_id: 'me',
				participants: [{ id: 'me', name: '', number: '', is_me: true }, { id: `p-${s.id}`, name: s.name, number: s.number, is_me: false }],
			},
			messages,
		}
	})
}
