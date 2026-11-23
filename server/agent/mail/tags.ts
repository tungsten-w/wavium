// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The five words a person and an agent use for the same mail (V4-24):
// spam, promo, important, urgent, etudes.
//
// They are not a new store. The classification already holds all of it, split
// the way the questions are asked (apps/mail/lib/Service/Triage/questions.json):
// one exclusive `category`, and independent probabilities for urgency, "needs a
// reply", "needs an action", "has a deadline" and "suspicious". A tag is a
// reading of those columns, so there is one source of truth
// (`oc_mail_triage`), nothing to keep in sync, and the agent and the Mail UI
// can never disagree about what a mail is.
//
// Two planes, because the five words are not mutually exclusive -- an exam
// deadline is `etudes` AND `urgent`, a fraudulent sale is `promo` AND `spam`:
//   exclusive  spam / promo / etudes   <- the `category` column
//   cumulative important / urgent      <- the predicates and the urgency score
import { AgentError } from '../util'

/** The vocabulary. Anything else is refused, in both directions. */
export const WAVIUM_TAGS = ['spam', 'promo', 'important', 'urgent', 'etudes'] as const
export type WaviumTag = (typeof WAVIUM_TAGS)[number]

/** Tags that come from `category`: a mail has at most one of them. */
export const EXCLUSIVE_TAGS = ['spam', 'promo', 'etudes'] as const
/** Tags a mail can carry on top of its category, and the only ones `remove` accepts. */
export const CUMULATIVE_TAGS = ['important', 'urgent'] as const

/** tag -> the category that means it. `promo` is the classifier's `ads`. */
const CATEGORY_OF: Record<string, string> = { spam: 'spam', promo: 'ads', etudes: 'etudes' }
const TAG_OF_CATEGORY: Record<string, WaviumTag> = { spam: 'spam', ads: 'promo', etudes: 'etudes' }

/**
 * The same cut the Mail UI has always used for its chips
 * (apps/mail/web/index.tsx, TriageChips): one number, not two.
 */
export const SURE = 0.6

/** Urgency levels that mean "now-ish". `urgent` is set by moving to `today`. */
const URGENT_LEVELS = ['today', 'now']
export const URGENT_LEVEL = 'today'
export const NOT_URGENT_LEVEL = 'whenever'

/** What a classification row looks like once read (read.ts selects these). */
export interface TaggableTriage {
	category?: unknown
	category_confidence?: unknown
	urgency?: unknown
	needs_reply?: unknown
	needs_action?: unknown
	has_deadline?: unknown
	suspicious?: unknown
}

const unit = (v: unknown): number | null => {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
	return Number.isFinite(n) ? n : null
}
const atLeast = (v: unknown, min: number): boolean => (unit(v) ?? -1) >= min

/**
 * The tags of one mail, in the order of WAVIUM_TAGS. A mail nobody classified
 * yet has none: an empty list means "not sorted", never "ordinary mail".
 *
 * A category the classifier is unsure of (confidence under SURE) yields no
 * exclusive tag -- better no answer than a wrong one. The cumulative tags do
 * not depend on the category, so they still apply.
 */
export function tagsOf(t: TaggableTriage | null | undefined): WaviumTag[] {
	// No classification row at all: nothing is known. A row without a category
	// still answers for the cumulative plane -- an agent may have set `important`
	// on a mail no classifier has seen (write.ts inserts such a row).
	if (!t) return []
	const out: WaviumTag[] = []
	// Something that looks like a trick is spam, whatever category it was given.
	if (atLeast(t.suspicious, SURE)) out.push('spam')
	const hasCategory = t.category !== null && t.category !== undefined && t.category !== ''
	const sure = unit(t.category_confidence)
	// A category written by a person carries confidence 1; one with no
	// confidence recorded at all is taken at face value, as the UI does.
	if (hasCategory && (sure === null || sure >= SURE)) {
		const own = TAG_OF_CATEGORY[String(t.category)]
		if (own && !out.includes(own)) out.push(own)
	}
	if (atLeast(t.needs_reply, SURE) || atLeast(t.needs_action, SURE) || atLeast(t.has_deadline, SURE)) out.push('important')
	if (URGENT_LEVELS.includes(String(t.urgency))) out.push('urgent')
	return WAVIUM_TAGS.filter((x) => out.includes(x))
}

/** Columns of `oc_mail_triage` to write, as produced by patchFor(). */
export interface TagPatch {
	category?: string
	category_confidence?: number
	suspicious?: number
	urgency?: string
	needs_reply?: number
	needs_action?: number
	has_deadline?: number
}

const bad = (msg: string) => new AgentError('invalid_input', msg)

/**
 * add/remove -> the classification change that makes those tags true.
 *
 * Setting a tag means telling the truth about the mail, so it writes the
 * classification itself -- the same columns the person's own "Wrong?" button
 * writes (server/agent/mailcorrect/index.ts). Nothing here moves or deletes a
 * mail: `spam` is a word about a mail, not a folder (rule A10).
 *
 * `remove` only takes the cumulative tags. Removing `spam`, `promo` or `etudes`
 * would have to invent a category to put in their place, so the answer is to
 * add the right one instead; the error says so.
 */
export function patchFor(add: readonly string[], remove: readonly string[]): TagPatch {
	for (const t of [...add, ...remove]) {
		if (!(WAVIUM_TAGS as readonly string[]).includes(t)) throw bad(`Unknown tag ${JSON.stringify(t)}. Tags: ${WAVIUM_TAGS.join(', ')}`)
	}
	const both = add.filter((t) => remove.includes(t))
	if (both.length) throw bad(`Cannot add and remove the same tag: ${both.join(', ')}`)
	for (const t of remove) {
		if ((EXCLUSIVE_TAGS as readonly string[]).includes(t)) {
			throw bad(`A mail always has one of ${EXCLUSIVE_TAGS.join(', ')} or another category: add the right tag instead of removing ${t}`)
		}
	}
	const cats = add.filter((t) => (EXCLUSIVE_TAGS as readonly string[]).includes(t))
	if (cats.length > 1) throw bad(`A mail is one of ${EXCLUSIVE_TAGS.join(', ')}, not several: ${cats.join(' and ')}`)
	if (!add.length && !remove.length) throw bad('Nothing to change: pass add or remove')

	const patch: TagPatch = {}
	if (cats.length) {
		patch.category = CATEGORY_OF[cats[0]]
		patch.category_confidence = 1
		// Saying "this is a sale" must not leave a 0.9 "this is a scam" behind it.
		if (cats[0] !== 'spam') patch.suspicious = 0
		else patch.suspicious = 1
	}
	if (add.includes('important')) patch.needs_action = 1
	if (remove.includes('important')) {
		patch.needs_reply = 0
		patch.needs_action = 0
		patch.has_deadline = 0
	}
	if (add.includes('urgent')) patch.urgency = URGENT_LEVEL
	if (remove.includes('urgent')) patch.urgency = NOT_URGENT_LEVEL
	return patch
}

/** How a person's own correction is marked in `oc_mail_triage.model` (V4-10). */
export const CORRECTED_BY_USER = 'corrected-by-user'
/** How a tag written by an agent is marked, so the status page can tell them apart. */
export const TAGGED_BY_AGENT = 'tagged-by-agent'
