// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every tag has a color the owner can see (V4-35). Two things could leave a
// chip invisible, and both had happened on the live instance:
//   - mail_tags.color defaults to '#fff', and Mail sets no color on a tag it
//     finds as an IMAP keyword, so 668 of 676 tagged mails carried a white
//     "Promotion" chip on a white background;
//   - a classification chip gets its color from a CSS class per category, and
//     two of the five words an agent can set (spam, promo -> ads) had no rule.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COLORS, colorIndex, tagColor } from './Tags'

const css = readFileSync(join(__dirname, 'style.css'), 'utf8')

describe('tagColor: white means "nobody chose one"', () => {
	it('falls back to the palette for every way of saying white or nothing', () => {
		for (const color of ['#fff', '#FFF', '#ffffff', '#FFFFFF', ' #fff ', '#ffff', '#ffffffff', 'white', '', '   ', null, undefined]) {
			const got = tagColor({ imapLabel: '$promotion', color })
			expect([color, got]).toEqual([color, '#2e7d32'])
		}
	})
	it('keeps a color somebody chose, white-ish or not', () => {
		expect(tagColor({ imapLabel: '$label1', color: '#FF7A66' })).toBe('#FF7A66')
		expect(tagColor({ imapLabel: '$label3', color: '#31CC7C' })).toBe('#31CC7C')
		// Not white, however close: only pure white reads as unset.
		expect(tagColor({ imapLabel: 'x', color: '#fffffe' })).toBe('#fffffe')
	})
	it('gives the same label the same color, and always one of the palette', () => {
		for (const label of ['$promotion', 'forwarded', 'loadremoteimages', '', '$label9', 'accentué']) {
			const got = tagColor({ imapLabel: label, color: '#fff' })
			expect([label, COLORS.includes(got)]).toEqual([label, true])
			expect(tagColor({ imapLabel: label, color: null })).toBe(got)
		}
	})
	// These three are what the live instance holds; the PHP side asserts the
	// same numbers (TagColorTest), which is what keeps the two in step.
	it('indexes the labels the way TagMapper::colorIndex does', () => {
		expect(colorIndex('$promotion')).toBe(1)
		expect(colorIndex('forwarded')).toBe(0)
		expect(colorIndex('loadremoteimages')).toBe(5)
		expect(colorIndex('FORWARDED')).toBe(colorIndex('forwarded'))
	})
})

describe('classification chips: a color per word an agent can set', () => {
	// tag -> the class TriageChips puts on the chip (index.tsx).
	const chipClass: Record<string, string> = {
		spam: 'ml-tag--spam', promo: 'ml-tag--ads', etudes: 'ml-tag--etudes',
		important: 'ml-tag--act', urgent: 'ml-tag--urgent',
	}
	it('style.css paints each of the five', () => {
		for (const [tag, cls] of Object.entries(chipClass)) {
			const rule = new RegExp(`\\.${cls}\\b[^{]*\\{[^}]*color:`)
			expect([tag, cls, rule.test(css)]).toEqual([tag, cls, true])
		}
	})
	it('and each rule sets a background, not only a text color', () => {
		for (const cls of Object.values(chipClass)) {
			const rule = new RegExp(`\\.${cls}\\b[^{]*\\{([^}]*)\\}`)
			const body = rule.exec(css)?.[1] ?? ''
			expect([cls, /background:/.test(body)]).toEqual([cls, true])
		}
	})
})
