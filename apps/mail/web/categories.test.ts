// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The UI side of the same guard as server/agent/mail/categories.test.ts: the
// chips must offer exactly the categories the classifier can answer, and every
// label must belong to a real category. Before V4-27, categoryLabels still
// carried school, finance, calendar and unknown, which no mail could ever have.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { categoryLabels, filterCategories, urgencyLabels } from './api'

const questions = JSON.parse(readFileSync(new URL('../lib/Service/Triage/questions.json', import.meta.url), 'utf8')) as {
	questions: Array<{ name: string, choices?: Array<{ value: string }>, levels?: Array<{ label: string }> }>
}
const choices = questions.questions.find((q) => q.name === 'category')!.choices!.map((c) => c.value)
const levels = questions.questions.find((q) => q.name === 'urgency')!.levels!.map((l) => l.label)

describe('mail categories', () => {
	it('offers exactly the categories the classifier can answer', () => {
		expect(filterCategories).toEqual(choices)
	})

	it('has a label for every category and no label without one', () => {
		expect(Object.keys(categoryLabels).sort()).toEqual([...filterCategories].sort())
	})

	it('names Studies, so the etudes category is readable', () => {
		expect(filterCategories).toContain('etudes')
		expect(categoryLabels.etudes).toBe('Studies')
	})

	it('has a label for every urgency level and no label without one', () => {
		expect(Object.keys(urgencyLabels).sort()).toEqual([...levels].sort())
	})
})
