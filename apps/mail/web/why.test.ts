// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import '../../../core/web/testing/dom'
import { expect, test } from 'vitest'
import type { Triage } from './api'
import { whyHere } from './index'

const t = (f: Partial<Triage>): Triage => ({ category: 'personal', categoryConfidence: 0.82, urgency: 'whenever', urgencyScore: null, needsReply: 0.1, needsAction: 0.1, hasDeadline: null, writtenByPerson: null, suspicious: 0, classifiedAt: null, queue: 'done', ...f })
const hides = ['ads', 'spam', 'newsletter', 'social']

test('why is this mail here, in plain words (V4-10)', () => {
	expect(whyHere(t({}), hides)).toBe('In Curated: it is Personal (82% sure).')
	expect(whyHere(t({ needsReply: 0.9, urgency: 'today' }), hides)).toBe('In Curated: it is Personal (82% sure), it waits for your reply (90%), it is urgent today.')
	expect(whyHere(t({ category: 'ads', categoryConfidence: 1 }), hides)).toBe('Hidden from Curated: it is Ads.')
	expect(whyHere(t({ category: 'admin', suspicious: 0.8 }), hides)).toBe('In Curated: it looks like a trick (suspicious 80%).')
	expect(whyHere(t({ needsAction: 0.7 }), hides)).toContain('it asks you to do something (70%)')
})
