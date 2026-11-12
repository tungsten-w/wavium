// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dateKeyOf } from '../stats'

const stats = vi.fn()
const goTo = vi.fn()

vi.mock('../api', () => ({
	api: {
		stats: (...args: unknown[]) => stats(...args),
		summary: async () => ({}),
	},
}))
vi.mock('../navigate', () => ({ goTo: (...args: unknown[]) => goTo(...args) }))
vi.mock('@nextcloud/vue/components/NcButton', async () => {
	const { defineComponent, h } = await import('vue')
	return {
		default: defineComponent({
			inheritAttrs: false,
			emits: ['click'],
			setup: (_, { slots, attrs, emit }) => () => h('button', { ...attrs, onClick: () => emit('click') }, slots.default?.()),
		}),
	}
})

;(globalThis as unknown as { OC: unknown }).OC = { generateUrl: (path: string) => `/index.php${path}` }

import DashboardCalendar from './DashboardCalendar.vue'

const mounted: { unmount(): void }[] = []
const show = async () => {
	const wrapper = mount(DashboardCalendar)
	mounted.push(wrapper)
	await flushPromises()
	return wrapper
}
const daysAgo = (n: number) => {
	const date = new Date()
	date.setDate(date.getDate() - n)
	return dateKeyOf(date)
}

beforeEach(() => {
	stats.mockReset().mockResolvedValue({})
	goTo.mockClear()
})
afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))

describe('Dashboard calendar widget', () => {
	it('shows the month calendar', async () => {
		const wrapper = await show()
		expect(wrapper.find('.day-calendar').exists()).toBe(true)
		// compact: only the weeks the month needs (5 or 6 rows), never the empty last row
		const first = new Date()
		first.setDate(1)
		const lead = (first.getDay() - 1 + 7) % 7 // weeks start on Monday in the test
		const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
		expect(wrapper.findAll('.day-calendar__day')).toHaveLength(Math.ceil((lead + days) / 7) * 7)
		expect(wrapper.find('.day-calendar--compact').exists()).toBe(true)
		expect(wrapper.find('.day-calendar').classes()).toContain('daily-todo-widget__calendar') // fills the widget's height
	})

	it('clicking a day opens that day in the app', async () => {
		const wrapper = await show()
		await wrapper.find('.day-calendar__day:not(.day-calendar__day--outside)').trigger('click')
		const first = new Date()
		first.setDate(1)
		expect(goTo).toHaveBeenCalledWith(`/index.php/apps/daily_todo/#day/${dateKeyOf(first)}`)
	})

	it('asks for exactly the last 7 days and shows the numbers, with a bar per day', async () => {
		stats.mockResolvedValue({
			[daysAgo(0)]: { total: 4, done: 4 },
			[daysAgo(1)]: { total: 4, done: 2 },
			[daysAgo(2)]: { total: 2, done: 0 },
		})
		const wrapper = await show()
		expect(stats).toHaveBeenCalledWith(daysAgo(6), daysAgo(0))
		const text = wrapper.find('.daily-todo-widget__numbers').text()
		expect(text).toContain('60% done')
		expect(text).toContain('6/10 items')
		expect(text).toContain('1/3 full days')
		expect(wrapper.findAll('.daily-todo-widget__bar')).toHaveLength(7)
		expect(wrapper.findAll('.daily-todo-widget__fill')).toHaveLength(3)
	})

	it('the numbers link to the Stats page', async () => {
		stats.mockResolvedValue({ [daysAgo(0)]: { total: 1, done: 1 } })
		const wrapper = await show()
		expect(wrapper.find('a.daily-todo-widget__stats').attributes('href')).toBe('/index.php/apps/daily_todo/#stats')
	})

	it('keeps the stats block (same place, same size) with a short note until something was recorded', async () => {
		const wrapper = await show()
		const block = wrapper.find('.daily-todo-widget__stats')
		expect(block.exists()).toBe(true)
		expect(block.classes()).toContain('daily-todo-widget__stats--empty')
		expect(block.text()).toContain('nothing recorded yet')
		expect(wrapper.find('.daily-todo-widget__numbers').exists()).toBe(false)
	})

	it('keeps the calendar, and the same block, if the numbers cannot be loaded', async () => {
		stats.mockRejectedValue(new Error('offline'))
		const wrapper = await show()
		expect(wrapper.find('.day-calendar').exists()).toBe(true)
		expect(wrapper.find('.daily-todo-widget__stats--empty').exists()).toBe(true)
	})

	it('the block is the last thing in the widget, below the calendar', async () => {
		const wrapper = await show()
		const children = Array.from(wrapper.find('.daily-todo-widget').element.children)
		expect(children[0].classList.contains('day-calendar')).toBe(true)
		expect(children[children.length - 1].classList.contains('daily-todo-widget__stats')).toBe(true)
	})
})
