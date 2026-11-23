// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The header badge names a version, and the page behind it must list that
// version. Both come from RELEASES, so the one thing that can go wrong is
// RELEASES drifting from CHANGELOG.md -- a release tagged and written in the
// changelog, with the badge still showing the one before. These tests fail then.
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { CURRENT, RELEASES, releaseOf } from './whatsnew'

const changelog = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8')
/** Version headings of CHANGELOG.md, in file order (newest first). */
const headings = [...changelog.matchAll(/^## (v[\w.]+)\s*$/gm)].map((m) => m[1])

test('the changelog has version headings to compare against', () => {
	expect(headings.length).toBeGreaterThan(1)
	expect(headings[0]).toMatch(/^v\d/)
})

test('one release per changelog version, same order', () => {
	expect(RELEASES.map((r) => r.version)).toEqual(headings)
})

test('the badge names the newest version in the changelog', () => {
	expect(CURRENT).toBe(headings[0])
	expect(releaseOf(CURRENT)).toBeDefined()
})

test('every release says something, on a real date', () => {
	for (const r of RELEASES) {
		expect(r.headline.length, r.version).toBeGreaterThan(10)
		expect(r.items.length, r.version).toBeGreaterThan(0)
		expect(r.items.every((i) => i.trim().length > 10), r.version).toBe(true)
		expect(r.date, r.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(Number.isNaN(Date.parse(r.date)), r.version).toBe(false)
	}
})

test('newest first, so the first one is the version shown', () => {
	const dates = RELEASES.map((r) => Date.parse(r.date))
	expect(dates).toEqual([...dates].sort((a, b) => b - a))
})
