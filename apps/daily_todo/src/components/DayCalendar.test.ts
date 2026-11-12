// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import DayCalendar from './DayCalendar.vue'

const summary = vi.fn(async (_month: string) => ({
	'2026-10-01': { total: 4, done: 4 },
	'2026-10-02': { total: 4, done: 3 },
	'2026-10-03': { total: 20, done: 0 }, // created, nothing checked yet
}))

vi.mock('../api', () => ({ api: { summary: (month: string) => summary(month) } }))
vi.mock('@nextcloud/vue/components/NcButton', async () => {
	const { defineComponent, h } = await import('vue')
	return {
		default: defineComponent({
			emits: ['click'],
			setup: (_p, { slots, emit, attrs }) => () => h('button', { ...attrs, onClick: () => emit('click') }, slots.default?.()),
		}),
	}
})

const onPick = vi.fn()
const mountCalendar = async () => {
	onPick.mockClear()
	const wrapper = mount(DayCalendar, { props: { modelValue: new Date(2026, 9, 3), version: 0, 'onUpdate:modelValue': onPick } })
	await flushPromises()
	return wrapper
}
const dayButton = (wrapper: Awaited<ReturnType<typeof mountCalendar>>, label: RegExp) =>
	wrapper.findAll('.day-calendar__day').find(button => label.test(button.attributes('aria-label') ?? ''))!

describe('DayCalendar', () => {
	// "Today" is never grayed, so pin it away from the days under test.
	beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 20, 12)) })
	afterAll(() => { vi.useRealTimers() })

	it('keeps six full week rows by default (the sidebar), a stable size month to month', async () => {
		const wrapper = await mountCalendar()
		expect(wrapper.findAll('.day-calendar__day')).toHaveLength(42)
		expect(wrapper.find('.day-calendar--compact').exists()).toBe(false)
	})

	it('compact shows only the weeks the month needs: 5 rows for October 2026 (it starts on a Thursday)', async () => {
		const wrapper = mount(DayCalendar, { props: { modelValue: new Date(2026, 9, 3), version: 0, compact: true } })
		await flushPromises()
		expect(wrapper.findAll('.day-calendar__day')).toHaveLength(35)
		expect(wrapper.find('.day-calendar--compact').exists()).toBe(true)
		expect(wrapper.find('.day-calendar__grid').attributes('style') ?? '').not.toContain('--max-cell') // no height given: squares as wide as their column
		expect(dayButton(wrapper, /31 October 2026/)).toBeDefined()
	})

	it('compact keeps all 6 rows when the month really needs them (August 2026 starts on a Saturday)', async () => {
		const wrapper = mount(DayCalendar, { props: { modelValue: new Date(2026, 7, 3), version: 0, compact: true } })
		await flushPromises()
		expect(wrapper.findAll('.day-calendar__day')).toHaveLength(42)
		expect(dayButton(wrapper, /31 August 2026/)).toBeDefined()
	})

	it('compact with a height to fit caps the squares so every week row fits (never below 24px)', async () => {
		const fit = (date: Date, fitHeight: number) => mount(DayCalendar, { props: { modelValue: date, version: 0, compact: true, fitHeight } })
		// (288 - 44 header - 20 weekdays - 5 rows * 4 gap) / 5 rows = 40.8 -> 40
		expect(fit(new Date(2026, 9, 3), 288).find('.day-calendar__grid').attributes('style')).toContain('--max-cell: 40px')
		// the same room for the 6-week August 2026: (288 - 64 - 6 * 4) / 6 = 33.3 -> 33
		expect(fit(new Date(2026, 7, 3), 288).find('.day-calendar__grid').attributes('style')).toContain('--max-cell: 33px')
		expect(fit(new Date(2026, 7, 3), 100).find('.day-calendar__grid').attributes('style')).toContain('--max-cell: 24px')
	})

	it('the sidebar calendar (not compact) ignores fitHeight and never caps its squares', async () => {
		const wrapper = mount(DayCalendar, { props: { modelValue: new Date(2026, 9, 3), version: 0, fitHeight: 100 } })
		expect(wrapper.findAll('.day-calendar__day')).toHaveLength(42)
		expect(wrapper.find('.day-calendar__grid').attributes('style') ?? '').not.toContain('--max-cell')
	})

	it('compact never loses a day: a four-week February fits in exactly four rows', async () => {
		// February 2027 starts on a Monday and has 28 days: exactly four weeks.
		const wrapper = mount(DayCalendar, { props: { modelValue: new Date(2027, 1, 3), version: 0, compact: true } })
		await flushPromises()
		expect(wrapper.findAll('.day-calendar__day')).toHaveLength(28)
		expect(dayButton(wrapper, /28 February 2027/)).toBeDefined()
		expect(dayButton(wrapper, /1 February 2027/)).toBeDefined()
	})

	it('requests the shown month', async () => {
		await mountCalendar()
		expect(summary).toHaveBeenCalledWith('2026-10')
	})

	it('tints days by completion', async () => {
		const wrapper = await mountCalendar()
		expect(dayButton(wrapper, /1 October 2026/).attributes('style')).toContain('--fill: 100%')
		expect(dayButton(wrapper, /2 October 2026/).attributes('style')).toContain('--fill: 75%')
		expect(dayButton(wrapper, /3 October 2026/).attributes('style')).toContain('--fill: 0%')
		expect(dayButton(wrapper, /1 October 2026/).classes()).toContain('day-calendar__day--strong')
	})

	it('grays a day exactly when it has not been created', async () => {
		const wrapper = await mountCalendar()
		const gray = (label: RegExp) => dayButton(wrapper, label).classes().includes('day-calendar__day--ungenerated')
		expect(gray(/15 October 2026/)).toBe(true) // no row: not created
		expect(gray(/4 October 2026/)).toBe(true) // the next day does not exist yet
		expect(gray(/3 October 2026/)).toBe(false) // created, even though nothing is checked
		expect(gray(/2 October 2026/)).toBe(false)
		expect(gray(/1 October 2026/)).toBe(false)
	})

	it('marks today', async () => {
		const wrapper = await mountCalendar()
		expect(dayButton(wrapper, /20 October 2026/).classes()).toContain('day-calendar__day--today')
	})
	it('marks the selected day and emits the clicked date', async () => {
		const wrapper = await mountCalendar()
		expect(dayButton(wrapper, /3 October 2026/).classes()).toContain('day-calendar__day--selected')
		await dayButton(wrapper, /2 October 2026/).trigger('click')
		const picked = onPick.mock.calls[0][0] as Date
		expect([picked.getFullYear(), picked.getMonth(), picked.getDate()]).toEqual([2026, 9, 2])
	})
})
