// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The category list lives in three places: questions.json (what the classifier
// may answer), CATEGORIES here (what the agent tools accept) and
// filterCategories in the Mail UI (what the chips offer). They drifted once --
// a `school` label survived in the UI long after the classifier had stopped
// being able to answer it, so a chip existed that could never match a mail
// (V4-27). These tests fail the moment the lists disagree again.
import { expect, test } from 'bun:test'
import { CATEGORIES } from './read'

const questions = await Bun.file(new URL('../../../apps/mail/lib/Service/Triage/questions.json', import.meta.url)).json() as {
	version: string
	questions: Array<{ name: string, type: string, choices?: Array<{ value: string, description?: string }>, levels?: Array<{ label: string }> }>
}
const category = questions.questions.find((q) => q.name === 'category')!

test('CATEGORIES is exactly what the classifier can answer', () => {
	expect(category.type).toBe('choice')
	expect(category.choices!.map((c) => c.value)).toEqual(CATEGORIES)
})

test('every choice is described, so the model knows what it means', () => {
	for (const c of category.choices!) expect(c.description?.length ?? 0).toBeGreaterThan(20)
})

test('etudes exists and admin no longer swallows school and university', () => {
	expect(CATEGORIES).toContain('etudes')
	const etudes = category.choices!.find((c) => c.value === 'etudes')!.description!.toLowerCase()
	expect(etudes).toContain('university')
	const admin = category.choices!.find((c) => c.value === 'admin')!.description!.toLowerCase()
	expect(admin).not.toContain('university')
	expect(admin).not.toContain('school')
})

test('the question set has its own version, so a stored answer says which set it came from', () => {
	// Bumping this is free: enqueue() works off a cursor and the queue table,
	// never off the version, so no mail is reclassified (and no euro spent).
	expect(questions.version).toBe('mail-v3')
})
