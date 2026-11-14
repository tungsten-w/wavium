// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Demo" answers for the mock provider (dev and demo stacks only, rule A2: no
// real model, no key). A mock provider whose model is "demo" answers Atrium's
// own requests with keyword rules instead of "mock: ...", so a person trying
// Atrium sees plausible results: triage, filing rules, dates in a mail, reply
// drafts, the digest summary. Deterministic, French and English keywords.
// Tests use the plain mock; nothing here runs unless the model is "demo".
import type { AiRequest } from './types'

export interface DemoReply { text?: string, toolCalls?: Array<{ name: string, input: unknown }> }

const lastUser = (req: AiRequest): string => {
	for (let i = req.messages.length - 1; i >= 0; i--) {
		const m = req.messages[i]
		if (m.role === 'user') return typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ')
	}
	return ''
}
const has = (text: string, ...words: string[]) => words.some((w) => text.includes(w))
const between = (s: string, a: string, b: string) => {
	const i = s.indexOf(a)
	if (i < 0) return s
	const j = s.indexOf(b, i + a.length)
	return s.slice(i + a.length, j < 0 ? undefined : j)
}

/** Triage (P2-4): category and signals from keywords of the mail. */
export function demoClassify(mail: string) {
	const t = mail.toLowerCase()
	const from = /from:[^\n]*/i.exec(mail)?.[0].toLowerCase() ?? ''
	const suspicious = has(t, 'suspendu', 'suspended', 'vérifiez votre', 'verify your', 'cliquez ici', 'click here') && !has(from, 'atrium.test')
	let category = 'personal'
	if (suspicious) category = 'spam'
	else if (has(t, 'facture', 'invoice', 'impôt', 'cotisation', 'banque', 'loyer', 'assurance')) category = 'admin'
	else if (has(t, 'commande', 'order', 'expédi', 'livraison', 'shipped')) category = 'orders'
	else if (has(t, 'newsletter', 'cette semaine', 'astuces', 'digest')) category = 'newsletter'
	else if (has(t, 'promo', '%', 'soldes', 'offre', 'réduction', 'sale')) category = 'ads'
	else if (has(t, 'issue', 'pull request', 'github', 'notification')) category = 'social'
	else if (has(t, 'réunion', 'meeting', 'projet', 'client', 'contrat')) category = 'work'
	const question = mail.includes('?')
	const personLike = category === 'personal' || category === 'work'
	const action = has(t, 'payer', 'pay ', 'signer', 'sign ', 'confirmer', 'confirm', 'avant le', 'before ', 'disponible', 'à régler')
	const deadline = has(t, 'avant', 'before', 'jusqu', 'until', 'date limite', 'deadline', 'dis-moi avant')
	const urgency = suspicious ? 'never' : deadline ? 'this_week' : question && personLike ? 'whenever' : category === 'admin' ? 'this_week' : 'never'
	return {
		category, category_confidence: 0.8,
		needs_reply: question && personLike ? 0.85 : 0.1,
		needs_action: action && !suspicious ? 0.8 : 0.1,
		has_deadline: deadline ? 0.75 : 0.1,
		written_by_person: personLike ? 0.85 : 0.1,
		suspicious: suspicious ? 0.95 : 0.05,
		urgency,
	}
}

/** Filing rule (P5-3) from the request and the folder list in the tool schema. */
export function demoRule(request: string, schema: any) {
	const t = request.toLowerCase()
	const out: Record<string, unknown> = { name: request.length > 40 ? request.slice(0, 40) + '…' : request }
	const domain = /([a-z0-9-]+\.)+[a-z]{2,}/i.exec(request)?.[0]
	if (domain && !domain.includes('@')) out.from_domain = domain.toLowerCase()
	const email = /[^\s@<]+@[^\s@>]+\.[a-z]{2,}/i.exec(request)?.[0]
	if (email) { out.from = email.toLowerCase(); delete out.from_domain }
	if (has(t, 'facture', 'invoice', 'admin', 'banque', 'impôt')) out.category = 'admin'
	else if (has(t, 'commande', 'order', 'livraison')) out.category = 'orders'
	else if (has(t, 'newsletter', 'lettre')) out.category = 'newsletter'
	else if (has(t, 'pub', 'promo', 'ads', 'publicité')) out.category = 'ads'
	else if (has(t, 'réseau', 'github', 'notification', 'social')) out.category = 'social'
	// Folder: "Folders: 5 = Archive; 7 = Admin" in the move_to description.
	const desc = String(schema?.properties?.move_to?.description ?? '')
	for (const [, id, name] of desc.matchAll(/(\d+) = ([^;]+)/g)) {
		if (t.includes(name.trim().toLowerCase())) { out.move_to = Number(id); break }
	}
	if (has(t, ' lu', 'lus', 'lues', 'read')) out.mark_read = true
	if (has(t, 'étoile', 'star', 'important')) out.star = true
	return out
}

const DAYS: Record<string, number> = { dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6, sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }
const pad = (n: number) => String(n).padStart(2, '0')

/** Dates in a mail (P5-7): "jeudi 14h", "samedi soir", "avant jeudi", "le 12/12". Relative to the Sent line. */
export function demoExtract(prompt: string) {
	const sent = /Sent: (\d{4})-(\d{2})-(\d{2})/.exec(prompt)
	const base = sent ? new Date(Number(sent[1]), Number(sent[2]) - 1, Number(sent[3])) : new Date()
	const subject = /Subject: ([^\n]*)/.exec(prompt)?.[1] ?? ''
	const body = between(prompt, '<email>', '</email>')
	const text = `${subject}\n${body}`
	const t = text.toLowerCase()
	const dayStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
	const next = (dow: number) => { const d = new Date(base); d.setDate(d.getDate() + (((dow - d.getDay()) + 7) % 7 || 7)); return d }
	const events: Array<Record<string, string>> = []
	const tasks: Array<Record<string, string>> = []
	for (const m of t.matchAll(/(?<!avant )\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:\s+(?:à\s+)?(\d{1,2})\s*h(\d{2})?|\s+(soir|midi|matin))?/g)) {
		const d = next(DAYS[m[1]])
		const hour = m[2] ? Number(m[2]) : m[4] === 'soir' ? 20 : m[4] === 'midi' ? 12 : m[4] === 'matin' ? 9 : null
		if (hour === null) continue
		events.push({ title: subject.replace(/^(re|fwd?):\s*/i, '').replace(/\s*\?$/, '') || 'Rendez-vous', start: `${dayStr(d)}T${pad(hour)}:${m[3] ?? '00'}` })
		break
	}
	const before = /avant (?:le )?(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|\d{1,2}\/\d{1,2})/.exec(t)
	if (has(t, 'facture', 'invoice', 'payer', 'régler')) tasks.push({ title: 'Payer la facture', ...(before ? { due: before[1].includes('/') ? `${base.getFullYear()}-${pad(Number(before[1].split('/')[1]))}-${pad(Number(before[1].split('/')[0]))}` : dayStr(next(DAYS[before[1]])) } : {}) })
	else if (before) tasks.push({ title: 'Répondre', due: before[1].includes('/') ? `${base.getFullYear()}-${pad(Number(before[1].split('/')[1]))}-${pad(Number(before[1].split('/')[0]))}` : dayStr(next(DAYS[before[1]])) })
	return { events, tasks }
}

/** A reply draft (P5-2): short, polite, in French unless the mail is English. */
export function demoReply(prompt: string) {
	const thread = between(prompt, '<thread>', '</thread>')
	const lastFrom = [...thread.matchAll(/From: ([^<\n]+?)\s*(?:<|\n)/g)].at(-1)?.[1]?.trim() ?? ''
	const first = lastFrom.split(/\s+/)[0] || ''
	const english = /\b(the|and|you|please|thanks)\b/i.test(thread) && !/\b(le|la|les|vous|merci|bonjour|salut)\b/i.test(thread)
	const instruction = between(prompt, '<instruction>', '</instruction>').trim()
	const extra = prompt.includes('<instruction>') ? (english ? `\n\n(${instruction})` : `\n\n${instruction.charAt(0).toUpperCase()}${instruction.slice(1)}.`) : ''
	return english
		? `Hi ${first},\n\nThanks for your message. That works for me, I'll get back to you with the details.${extra}\n\nBest regards`
		: `Bonjour ${first},\n\nMerci pour ton message. C'est d'accord pour moi, je te redis les détails rapidement.${extra}\n\nBonne journée`
}

/** Short French lines for what the assistant's tools return. */
function describeResult(raw: string): string {
	let v: any
	try { v = JSON.parse(raw) } catch { return raw.slice(0, 300) }
	if (v?.status === 'pending_approval') return "C'est en attente de ton accord : valide-le ici, dans le panneau."
	const list = (items: any[], line: (x: any) => string) => items.length ? items.slice(0, 6).map((x) => `- ${line(x)}`).join('\n') : '(rien)'
	if (Array.isArray(v?.messages)) return `Tes derniers mails :\n${list(v.messages, (m) => `${m.from?.name || m.from?.address || '?'} : ${m.subject || '(sans objet)'}`)}`
	if (Array.isArray(v?.events)) return `Ton agenda :\n${list(v.events, (e) => `${String(e.start ?? '').replace('T', ' ').slice(0, 16)} ${e.title}`)}`
	if (Array.isArray(v?.tasks)) return `Tes tâches :\n${list(v.tasks, (t) => `${t.title}${t.due ? ` (pour le ${String(t.due).slice(0, 10)})` : ''}`)}`
	if (Array.isArray(v?.items)) return `Ta liste du jour :\n${list(v.items.filter((i: any) => !/^\s*-{3,}\s*$/.test(i.title ?? '')), (i) => `${i.done ? '✓ ' : ''}${i.title}`)}`
	if (Array.isArray(v?.results)) return `Ce que j'ai trouvé :\n${list(v.results, (r) => `${r.app ?? r.type ?? ''} ${r.title ?? r.subject ?? r.name ?? ''}`.trim())}`
	if (v?.note_id !== undefined || v?.id !== undefined) return 'C\'est fait : la note est créée.'
	return 'C\'est fait.'
}

/** The built-in assistant (P5-6) with the demo model: a few French intents mapped to real tools. */
export function demoAssistant(req: AiRequest): DemoReply | null {
	const last = req.messages[req.messages.length - 1]
	if (!last || last.role !== 'user') return null
	if (Array.isArray(last.content)) {
		const results = last.content.filter((b) => b.type === 'tool_result').map((b) => (b as { content: string }).content)
		if (results.length) return { text: results.map(describeResult).join('\n\n') }
	}
	const text = (typeof last.content === 'string' ? last.content : last.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ')).trim()
	if (!text || /^mock-tool:/.test(text)) return null
	const t = text.toLowerCase()
	const offered = new Set((req.tools ?? []).map((x) => x.name))
	const call = (name: string, input: unknown) => (offered.has(name) ? { text: '', toolCalls: [{ name, input }] } : null)
	const note = /(?:note|noter)\s*:?\s*(.+)$/i.exec(text)
	const find = /(?:cherche|trouve|search)\s+(.+)$/i.exec(text)
	const answer = (find && call('search', { query: find[1].trim() }))
		?? (note && /note|noter/.test(t) && call('notes_note_create', { content: note[1].trim() }))
		?? (has(t, 'mail', 'courrier', 'message') && call('mail_message_list', { limit: 5 }))
		?? (has(t, 'agenda', 'rendez', 'événement', 'evenement', 'calendrier', 'semaine') && call('calendar_event_list', {}))
		?? (has(t, 'liste du jour', 'daily', 'todo', "aujourd'hui") && call('todo_day_get', {}))
		?? (has(t, 'tâche', 'tache', 'task') && call('task_list', {}))
	return answer || { text: "Je suis l'IA de démo de Wavium (pas une vraie IA). Essaie : « mes derniers mails », « mon agenda », « mes tâches », « ma liste du jour », « note : acheter du pain », « cherche facture »." }
}

/** The answer of the "demo" model to one of Atrium's requests, or null (use the plain mock). */
export function demoAnswer(req: AiRequest): DemoReply | null {
	const forced = req.toolChoice && typeof req.toolChoice === 'object' ? req.tools?.find((t) => t.name === (req.toolChoice as { name: string }).name) : undefined
	const prompt = lastUser(req)
	if (forced?.name === 'classify') return { toolCalls: [{ name: 'classify', input: demoClassify(prompt) }] }
	if (forced?.name === 'make_rule') return { toolCalls: [{ name: 'make_rule', input: demoRule(between(prompt, '<request>', '</request>').trim(), forced.inputSchema) }] }
	if (forced?.name === 'extract') return { toolCalls: [{ name: 'extract', input: demoExtract(prompt) }] }
	if (!forced && req.system?.includes('draft email replies')) return { text: demoReply(prompt) }
	if (!forced && req.system?.includes('assistant built into')) return demoAssistant(req)
	if (!forced && req.system?.includes('morning digest')) {
		const head = between(prompt, '<digest>\n', '\n').trim()
		return { text: head && !head.startsWith('Nothing') ? `Aujourd'hui : ${head.charAt(0).toLowerCase()}${head.slice(1)}. Commence par les mails qui attendent une réponse.` : 'Rien d\'urgent aujourd\'hui.' }
	}
	return null
}
