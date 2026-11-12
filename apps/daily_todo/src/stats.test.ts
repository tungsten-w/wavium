import { describe, expect, it } from 'vitest'
import { dateKeyOf, summarise } from './stats'

// 2026-10-05 is a Monday.
const days = {
	'2026-10-05': { total: 4, done: 4 }, // Mon, everything done
	'2026-10-06': { total: 4, done: 2 }, // Tue
	'2026-10-07': { total: 0, done: 0 }, // Wed, recorded but empty
	'2026-10-12': { total: 5, done: 5 }, // Mon
	'2026-09-01': { total: 9, done: 9 }, // outside the range
}

describe('summarise', () => {
	const stats = summarise(days, '2026-10-05', '2026-10-14')

	it('counts only the days inside the range', () => {
		expect(stats.recorded).toBe(4)
		expect(stats.done).toBe(11)
		expect(stats.total).toBe(13)
		expect(stats.rate).toBeCloseTo(11 / 13)
	})

	it('counts fully done days; an empty day is not one', () => {
		expect(stats.complete).toBe(2)
	})

	it('averages per weekday, Monday first, null where nothing was recorded', () => {
		expect(stats.weekdays[0]).toBe(1) // Mondays: 9/9
		expect(stats.weekdays[1]).toBe(0.5)
		expect(stats.weekdays[2]).toBeNull() // the empty Wednesday
		expect(stats.weekdays[6]).toBeNull()
	})

	it('has one bar per day for a short range, empty days without a rate', () => {
		expect(stats.buckets).toHaveLength(10)
		expect(stats.buckets[0].rate).toBe(1)
		expect(stats.buckets[1].rate).toBe(0.5)
		expect(stats.buckets[2].rate).toBeNull()
		expect(stats.buckets[3].rate).toBeNull() // not recorded
	})

	it('has one bar per month for a long range, weighted by items', () => {
		const year = summarise(days, '2026-01-01', '2026-10-31')
		expect(year.buckets).toHaveLength(10)
		expect(year.buckets[8].rate).toBe(1) // September
		expect(year.buckets[9].rate).toBeCloseTo(11 / 13)
		expect(year.buckets[0].rate).toBeNull()
	})

	it('has no rate and no streak-like fields when nothing was recorded', () => {
		const none = summarise({}, '2026-10-05', '2026-10-14')
		expect(none.rate).toBeNull()
		expect(none.recorded).toBe(0)
		expect(Object.keys(none)).not.toContain('streak')
	})
})

describe('dateKeyOf', () => {
	it('uses the local calendar date, zero padded', () => {
		expect(dateKeyOf(new Date(2026, 0, 5))).toBe('2026-01-05')
	})
})
