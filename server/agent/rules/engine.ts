// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Filing rules (PLAN P5-3): the part that runs on every new mail, without any
// AI. Pure: a rule is plain data, matching is a few string checks.
import { CATEGORIES } from '../mail/read'
import { AgentError } from '../util'

export interface RuleWhen {
	/** Sender domain, e.g. "edf.fr" (subdomains match too). */
	from_domain?: string
	/** Sender address, exact (case-insensitive). */
	from?: string
	/** Classification category (mail-v2). */
	category?: string
	/** Text the subject contains (case-insensitive). */
	subject_contains?: string
}

export interface RuleThen {
	/** Folder id of the same account. */
	move_to?: number
	mark_read?: boolean
	star?: boolean
}

export interface Rule {
	id: number
	name: string
	account: number
	when: RuleWhen
	then: RuleThen
	enabled: boolean
}

/** What a rule looks at in a mail. */
export interface MailFacts {
	account: number
	from: string | null
	subject: string
	category: string | null
}

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
export const domainOf = (address: string | null) => {
	const a = lower(address)
	const i = a.lastIndexOf('@')
	return i >= 0 ? a.slice(i + 1) : ''
}

export function matches(rule: Pick<Rule, 'account' | 'when'>, m: MailFacts): boolean {
	if (rule.account !== m.account) return false
	const w = rule.when
	if (w.from_domain) {
		const d = domainOf(m.from)
		const want = lower(w.from_domain).replace(/^@/, '')
		if (d !== want && !d.endsWith('.' + want)) return false
	}
	if (w.from && lower(m.from) !== lower(w.from)) return false
	if (w.category && lower(m.category) !== lower(w.category)) return false
	if (w.subject_contains && !lower(m.subject).includes(lower(w.subject_contains))) return false
	return true
}

/** First enabled rule that matches, in order (lowest id first). */
export function firstMatch(rules: Rule[], m: MailFacts): Rule | null {
	return [...rules].sort((a, b) => a.id - b.id).find((r) => r.enabled && matches(r, m)) ?? null
}

/** Checks a rule from a user, an agent or the AI. `folders` = the account's folder ids. */
export function validateRule(input: { when?: unknown, then?: unknown }, folders: Set<number>): { when: RuleWhen, then: RuleThen } {
	const w = (input.when ?? {}) as Record<string, unknown>
	const t = (input.then ?? {}) as Record<string, unknown>
	if (typeof w !== 'object' || typeof t !== 'object' || Array.isArray(w) || Array.isArray(t)) throw new AgentError('invalid_input', 'when and then must be objects')
	const when: RuleWhen = {}
	const str = (k: string, max = 200) => {
		const v = w[k]
		if (v === undefined || v === null || v === '') return undefined
		if (typeof v !== 'string' || v.trim().length > max) throw new AgentError('invalid_input', `when.${k} must be text`)
		return v.trim()
	}
	when.from_domain = str('from_domain')
	if (when.from_domain && !/^@?[a-z0-9.-]+\.[a-z]{2,}$/i.test(when.from_domain)) throw new AgentError('invalid_input', 'when.from_domain must look like example.com')
	when.from = str('from')
	if (when.from && !/^[^@\s]+@[^@\s]+$/.test(when.from)) throw new AgentError('invalid_input', 'when.from must be an email address')
	when.category = str('category')
	if (when.category && !CATEGORIES.includes(when.category)) throw new AgentError('invalid_input', `when.category must be one of ${CATEGORIES.join(', ')}`)
	when.subject_contains = str('subject_contains', 100)
	for (const k of Object.keys(when) as Array<keyof RuleWhen>) if (when[k] === undefined) delete when[k]
	if (!Object.keys(when).length) throw new AgentError('invalid_input', 'A rule needs at least one condition (when)')

	const then: RuleThen = {}
	if (t.move_to !== undefined && t.move_to !== null) {
		const id = Number(t.move_to)
		if (!folders.has(id)) throw new AgentError('invalid_input', 'then.move_to must be a folder of this account')
		then.move_to = id
	}
	if (t.mark_read === true) then.mark_read = true
	if (t.star === true) then.star = true
	if (!Object.keys(then).length) throw new AgentError('invalid_input', 'A rule needs an action (then): move_to, mark_read or star')
	return { when, then }
}

/** "From edf.fr, category admin → move to Admin, mark read" */
export function describe(r: Pick<Rule, 'when' | 'then'>, folderName: (id: number) => string): string {
	const c: string[] = []
	if (r.when.from_domain) c.push(`from ${r.when.from_domain}`)
	if (r.when.from) c.push(`from ${r.when.from}`)
	if (r.when.category) c.push(`category ${r.when.category}`)
	if (r.when.subject_contains) c.push(`subject contains "${r.when.subject_contains}"`)
	const a: string[] = []
	if (r.then.move_to !== undefined) a.push(`move to ${folderName(r.then.move_to)}`)
	if (r.then.mark_read) a.push('mark read')
	if (r.then.star) a.push('star')
	return `${c.join(', ')} → ${a.join(', ')}`
}
