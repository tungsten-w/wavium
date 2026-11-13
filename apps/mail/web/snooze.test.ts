// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'vitest'
import { snoozeChoices } from './Snooze'

const local = (s: number) => { const d = new Date(s * 1000); return `${d.getDay()} ${d.getDate()} ${d.getHours()}:${d.getMinutes()}` }

test('choices: later today only before 17:00, tomorrow 08:00, next Monday 08:00', () => {
	const wedMorning = new Date(2026, 10, 11, 9, 30) // Wednesday 11 Nov 2026
	expect(snoozeChoices(wedMorning).map((c) => [c.label, local(c.at)])).toEqual([
		['Later today (18:00)', '3 11 18:0'],
		['Tomorrow morning (08:00)', '4 12 8:0'],
		['Next Monday (08:00)', '1 16 8:0'],
	])
	const sundayEvening = new Date(2026, 10, 15, 20, 0)
	// Sunday evening: tomorrow is Monday, offered once.
	expect(snoozeChoices(sundayEvening).map((c) => [c.label, local(c.at)])).toEqual([['Tomorrow morning (08:00)', '1 16 8:0']])
	const mondayNoon = new Date(2026, 10, 16, 12, 0)
	expect(local(snoozeChoices(mondayNoon).at(-1)!.at)).toBe('1 23 8:0') // a full week, not today
})
