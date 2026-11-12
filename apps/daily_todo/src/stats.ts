export type DayCounts = { total: number; done: number }
export type Bucket = { label: string; title: string; rate: number | null }
export type Stats = {
	recorded: number
	done: number
	total: number
	rate: number | null
	/** Days where everything on the list was done. */
	complete: number
	/** Average completion per weekday, Monday first; null where nothing was recorded. */
	weekdays: (number | null)[]
	/** Completion over time: per day up to a month, per month beyond. */
	buckets: Bucket[]
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const parse = (key: string): Date => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)))

export function dateKeyOf(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const rateOf = (done: number, total: number): number | null => total ? done / total : null

/**
 * Numbers for the Stats page from the per-day counts the server returns (only days that were
 * created are in `days`). Days with nothing on the list are recorded but have no rate.
 */
export function summarise(days: Record<string, DayCounts>, from: string, to: string): Stats {
	let done = 0
	let total = 0
	let complete = 0
	const weekday = Array.from({ length: 7 }, () => ({ done: 0, total: 0 }))
	for (const [key, counts] of Object.entries(days)) {
		if (key < from || key > to) continue
		done += counts.done
		total += counts.total
		if (counts.total && counts.done === counts.total) complete++
		const slot = weekday[(parse(key).getDay() + 6) % 7]
		slot.done += counts.done
		slot.total += counts.total
	}

	const first = parse(from)
	const last = parse(to)
	const spanDays = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1
	const buckets: Bucket[] = []
	if (spanDays <= 31) {
		for (let at = new Date(first); at <= last; at.setDate(at.getDate() + 1)) {
			const key = dateKeyOf(at)
			const counts = days[key]
			buckets.push({
				label: String(at.getDate()),
				title: `${at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: ${counts ? `${counts.done}/${counts.total}` : 'not recorded'}`,
				rate: counts ? rateOf(counts.done, counts.total) : null,
			})
		}
	} else {
		for (let at = new Date(first.getFullYear(), first.getMonth(), 1); at <= last; at.setMonth(at.getMonth() + 1)) {
			const prefix = dateKeyOf(at).slice(0, 7)
			let monthDone = 0
			let monthTotal = 0
			for (const [key, counts] of Object.entries(days)) {
				if (key.startsWith(prefix) && key >= from && key <= to) {
					monthDone += counts.done
					monthTotal += counts.total
				}
			}
			buckets.push({
				label: at.toLocaleDateString(undefined, { month: 'short' }),
				title: `${at.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}: ${monthTotal ? `${monthDone}/${monthTotal}` : 'not recorded'}`,
				rate: rateOf(monthDone, monthTotal),
			})
		}
	}

	return {
		recorded: Object.keys(days).filter(key => key >= from && key <= to).length,
		done,
		total,
		rate: rateOf(done, total),
		complete,
		weekdays: weekday.map(slot => rateOf(slot.done, slot.total)),
		buckets,
	}
}
