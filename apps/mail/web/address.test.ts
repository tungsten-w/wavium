// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'vitest'
import { formatSuggestion, splitLast } from './AddressField'

test('splitLast keeps what is done and the part being typed', () => {
	expect(splitLast('bo')).toEqual(['', 'bo'])
	expect(splitLast('a@x.test, Bo')).toEqual(['a@x.test, ', 'Bo'])
	expect(splitLast('a@x.test,b')).toEqual(['a@x.test, ', 'b'])
})

test('formatSuggestion', () => {
	expect(formatSuggestion({ label: 'Bob', email: 'bob@x.test' })).toBe('Bob <bob@x.test>')
	expect(formatSuggestion({ label: 'bob@x.test', email: 'bob@x.test' })).toBe('bob@x.test')
	expect(formatSuggestion({ label: '', email: 'bob@x.test' })).toBe('bob@x.test')
})
