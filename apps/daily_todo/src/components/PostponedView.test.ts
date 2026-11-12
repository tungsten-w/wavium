// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trash = vi.fn()
const restore = vi.fn(async (..._args: unknown[]) => ({ ok: true }))

vi.mock('../api', () => ({
	api: {
		trash: (...args: unknown[]) => trash(...args),
		restore: (...args: unknown[]) => restore(...args),
	},
}))

vi.mock('@nextcloud/vue', async () => {
	const { defineComponent, h } = await import('vue')
	const stub = (tag: string, slots: string[]) => defineComponent({
		inheritAttrs: false,
		props: ['name', 'description', 'disabled'],
		emits: ['click'],
		setup: (props, { slots: given, attrs, emit }) => () => h(tag, { ...attrs, disabled: props.disabled, onClick: () => emit('click') }, [
			props.name ? h('span', props.name) : null,
			props.description ? h('span', props.description) : null,
			...slots.map(name => given[name]?.()),
		]),
	})
	return {
		NcButton: stub('button', ['default']),
		NcEmptyContent: stub('div', ['icon']),
		NcLoadingIcon: stub('span', []),
		NcNoteCard: stub('div', ['default']),
	}
})

import PostponedView from './PostponedView.vue'

const entry = (id: number, kind: 'postponed' | 'deleted', title: string, extra: Record<string, unknown> = {}) => ({
	id, kind, title, count: 1, day: '2026-10-03', due: kind === 'postponed' ? '2026-10-06' : null, created_at: 1_790_000_000, ...extra,
})
const mounted: { unmount(): void }[] = []
const onChanged = vi.fn()
const show = async () => {
	const wrapper = mount(PostponedView, { props: { onChanged } })
	mounted.push(wrapper)
	await flushPromises()
	return wrapper
}

beforeEach(() => {
	trash.mockReset()
	restore.mockClear()
	onChanged.mockClear()
})
afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))

describe('Postponed', () => {
	it('says so when nothing is postponed or deleted', async () => {
		trash.mockResolvedValue([])
		const wrapper = await show()
		expect(wrapper.text()).toContain('Nothing postponed')
		expect(wrapper.findAll('li')).toHaveLength(0)
	})

	it('lists postponed items soonest first, and deleted ones separately', async () => {
		trash.mockResolvedValue([
			entry(1, 'postponed', 'Later one', { due: '2026-12-01' }),
			entry(2, 'deleted', 'Gone one'),
			entry(3, 'postponed', 'Sooner one', { count: 3 }),
		])
		const wrapper = await show()
		const rows = wrapper.findAll('li')
		expect(rows.map(row => row.find('strong').text())).toEqual(['Sooner one', 'Later one', 'Gone one'])
		expect(rows[0].text()).toContain('with 2 subtasks')
		expect(wrapper.text()).toContain('Coming back')
		expect(wrapper.text()).toContain('Recently deleted')
	})

	it('brings an item back to today, refreshes the list and tells the app', async () => {
		trash.mockResolvedValueOnce([entry(7, 'postponed', 'Buy milk')]).mockResolvedValueOnce([])
		const wrapper = await show()
		await wrapper.find('li button').trigger('click')
		await flushPromises()
		expect(restore).toHaveBeenCalledWith(7, true)
		expect(wrapper.text()).toContain('"Buy milk" is back on today')
		expect(wrapper.findAll('li')).toHaveLength(0)
		expect(onChanged).toHaveBeenCalledTimes(1)
	})

	it('shows the server message when bringing back fails, and keeps the item listed', async () => {
		trash.mockResolvedValue([entry(7, 'deleted', 'Buy milk')])
		restore.mockRejectedValueOnce(new Error('There is nothing to restore any more'))
		const wrapper = await show()
		await wrapper.find('li button').trigger('click')
		await flushPromises()
		expect(wrapper.text()).toContain('nothing to restore')
		expect(onChanged).not.toHaveBeenCalled()
	})
})
