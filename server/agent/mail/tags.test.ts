// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The five tags (V4-24): the reading of the classification, and the write that
// makes a tag true. Pure functions, so the whole truth table is cheap to check
// -- including the edges of the one threshold, which is where a classifier
// disagreeing with the UI would show up.
import { expect, test } from 'bun:test'
import { AgentError } from '../util'
import { CUMULATIVE_TAGS, EXCLUSIVE_TAGS, patchFor, SURE, tagsOf, WAVIUM_TAGS } from './tags'

const t = (over: Record<string, unknown> = {}) => ({ category: 'personal', category_confidence: 0.9, urgency: 'whenever', needs_reply: 0, needs_action: 0, has_deadline: 0, suspicious: 0, ...over })

test('the vocabulary is the two planes, and nothing else', () => {
	expect(WAVIUM_TAGS).toEqual(['spam', 'promo', 'important', 'urgent', 'etudes'])
	expect([...EXCLUSIVE_TAGS, ...CUMULATIVE_TAGS].sort()).toEqual([...WAVIUM_TAGS].sort())
})

test('an unclassified mail has no tag at all', () => {
	expect(tagsOf(null)).toEqual([])
	expect(tagsOf(undefined)).toEqual([])
	expect(tagsOf({ category: null })).toEqual([])
	expect(tagsOf({ category: '' })).toEqual([])
	// A row with no category still answers for important and urgent: an agent
	// can tag a mail no classifier has seen (write.ts inserts such a row).
	expect(tagsOf({ category: null, needs_action: 0.9 })).toEqual(['important'])
	expect(tagsOf({ category: null, urgency: 'now' })).toEqual(['urgent'])
	// Not "ordinary mail": nothing is claimed about it.
	expect(tagsOf(t({ category: 'personal' }))).toEqual([])
})

test('each category that has a word gets it; the others get none', () => {
	expect(tagsOf(t({ category: 'spam' }))).toEqual(['spam'])
	expect(tagsOf(t({ category: 'ads' }))).toEqual(['promo'])
	expect(tagsOf(t({ category: 'etudes' }))).toEqual(['etudes'])
	for (const c of ['personal', 'work', 'admin', 'orders', 'security', 'social', 'newsletter', 'other']) {
		expect(tagsOf(t({ category: c }))).toEqual([])
	}
})

test('a mail that looks like a trick is spam whatever it was filed as', () => {
	expect(tagsOf(t({ category: 'orders', suspicious: 0.9 }))).toEqual(['spam'])
	// And not twice when it is both.
	expect(tagsOf(t({ category: 'spam', suspicious: 0.9 }))).toEqual(['spam'])
})

test('important comes from any of the three signals, urgent from the level', () => {
	expect(tagsOf(t({ needs_reply: 0.8 }))).toEqual(['important'])
	expect(tagsOf(t({ needs_action: 0.8 }))).toEqual(['important'])
	expect(tagsOf(t({ has_deadline: 0.8 }))).toEqual(['important'])
	expect(tagsOf(t({ urgency: 'today' }))).toEqual(['urgent'])
	expect(tagsOf(t({ urgency: 'now' }))).toEqual(['urgent'])
	for (const u of ['never', 'whenever', 'this_week']) expect(tagsOf(t({ urgency: u }))).toEqual([])
})

test('the planes stack, in the order of the vocabulary', () => {
	expect(tagsOf(t({ category: 'etudes', needs_action: 0.9, urgency: 'now' }))).toEqual(['important', 'urgent', 'etudes'])
	expect(tagsOf(t({ category: 'ads', suspicious: 0.9 }))).toEqual(['spam', 'promo'])
})

test('one threshold, the same the UI chips use', () => {
	expect(SURE).toBe(0.6)
	expect(tagsOf(t({ needs_action: 0.6 }))).toEqual(['important'])
	expect(tagsOf(t({ needs_action: 0.59 }))).toEqual([])
	expect(tagsOf(t({ category: 'orders', suspicious: 0.6 }))).toEqual(['spam'])
	expect(tagsOf(t({ category: 'orders', suspicious: 0.59 }))).toEqual([])
	// An unsure category claims nothing; the cumulative tags are unaffected.
	expect(tagsOf(t({ category: 'spam', category_confidence: 0.59 }))).toEqual([])
	expect(tagsOf(t({ category: 'spam', category_confidence: 0.59, needs_action: 0.9 }))).toEqual(['important'])
	// No confidence recorded at all is taken at face value, as the UI does.
	expect(tagsOf(t({ category: 'ads', category_confidence: null }))).toEqual(['promo'])
})

test('setting a category tag writes the category, sure, and settles suspicious', () => {
	expect(patchFor(['spam'], [])).toEqual({ category: 'spam', category_confidence: 1, suspicious: 1 })
	// "This is a sale" must not leave a 0.9 "this is a scam" behind it.
	expect(patchFor(['promo'], [])).toEqual({ category: 'ads', category_confidence: 1, suspicious: 0 })
	expect(patchFor(['etudes'], [])).toEqual({ category: 'etudes', category_confidence: 1, suspicious: 0 })
})

test('important and urgent write the signals they are read from', () => {
	expect(patchFor(['important'], [])).toEqual({ needs_action: 1 })
	expect(patchFor(['urgent'], [])).toEqual({ urgency: 'today' })
	expect(patchFor([], ['important'])).toEqual({ needs_reply: 0, needs_action: 0, has_deadline: 0 })
	expect(patchFor([], ['urgent'])).toEqual({ urgency: 'whenever' })
})

test('what it writes is what it then reads back', () => {
	for (const tag of WAVIUM_TAGS) {
		expect(tagsOf({ ...t({ category: null }), ...patchFor([tag], []) })).toContain(tag)
	}
})

test('refusals: unknown tag, two categories, add and remove the same, nothing at all', () => {
	expect(() => patchFor(['vacances'], [])).toThrow(AgentError)
	expect(() => patchFor(['spam', 'promo'], [])).toThrow(/not several/)
	expect(() => patchFor(['urgent'], ['urgent'])).toThrow(/same tag/)
	expect(() => patchFor([], [])).toThrow(/Nothing to change/)
})

test('removing a category tag is refused, and says what to do instead', () => {
	for (const tag of EXCLUSIVE_TAGS) {
		expect(() => patchFor([], [tag])).toThrow(/add the right tag instead/)
	}
	// The cumulative ones remove cleanly.
	for (const tag of CUMULATIVE_TAGS) expect(() => patchFor([], [tag])).not.toThrow()
})
