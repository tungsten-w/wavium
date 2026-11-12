// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const taskDetails = vi.fn()
const editTask = vi.fn()

vi.mock('../api', () => ({
	api: {
		taskDetails: (...args: unknown[]) => taskDetails(...args),
		editTask: (...args: unknown[]) => editTask(...args),
	},
}))

vi.mock('@nextcloud/vue', async () => {
	const { defineComponent, h } = await import('vue')
	return {
		NcDialog: defineComponent({
			props: ['name', 'open', 'buttons'],
			emits: ['submit', 'closing', 'update:open'],
			setup: (p, { slots, emit }) => () => p.open === false
				? null
				: h('div', { class: 'dialog' }, [
					slots.default?.(),
					...(p.buttons ?? []).map((entry: { label: string; type?: string; disabled?: boolean }) => h('button', {
						class: 'dialog-button',
						disabled: entry.disabled,
						onClick: () => (entry.type === 'submit' ? emit('submit', new Event('submit')) : emit('closing')),
					}, entry.label)),
				]),
		}),
		NcLoadingIcon: defineComponent({ setup: () => () => h('span', { class: 'loading' }) }),
		NcNoteCard: defineComponent({ setup: (_, { slots }) => () => h('div', { class: 'note' }, slots.default?.()) }),
		NcTextField: defineComponent({
			inheritAttrs: false,
			props: ['modelValue', 'label'],
			emits: ['update:modelValue'],
			setup: (p, { emit }) => () => h('input', { class: 'title', value: p.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) }),
		}),
		NcTextArea: defineComponent({
			inheritAttrs: false,
			props: ['modelValue', 'label'],
			emits: ['update:modelValue'],
			setup: (p, { emit }) => () => h('textarea', { value: p.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value) }),
		}),
	}
})

import TaskDialog from './TaskDialog.vue'

const details = (extra: Record<string, unknown> = {}) => ({ title: 'Write report', description: 'draft', start: '2026-10-01', due: '2026-10-03', priority: 5, repeating: false, ...extra })
const onSaved = vi.fn()
const onClose = vi.fn()
const mounted: { unmount(): void }[] = []
const show = async () => {
	const wrapper = mount(TaskDialog, { props: { itemId: 7, onSaved, onClose } })
	mounted.push(wrapper)
	await flushPromises()
	return wrapper
}
const save = (wrapper: Awaited<ReturnType<typeof show>>) => wrapper.findAll('.dialog-button')[1].trigger('click')

beforeEach(() => {
	taskDetails.mockReset().mockResolvedValue(details())
	editTask.mockReset().mockResolvedValue({ title: 'Write report', moved: false, day: null })
	onSaved.mockClear()
	onClose.mockClear()
})
afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))

describe('Task editor', () => {
	it('loads the task as stored in Tasks', async () => {
		const wrapper = await show()
		expect(taskDetails).toHaveBeenCalledWith(7)
		expect((wrapper.find('input.title').element as HTMLInputElement).value).toBe('Write report')
		expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('draft')
		expect((wrapper.find('input[aria-label=\"Start date\"]').element as HTMLInputElement).value).toBe('2026-10-01')
		expect((wrapper.find('input[aria-label=\"Due date\"]').element as HTMLInputElement).value).toBe('2026-10-03')
		expect((wrapper.find('select').element as HTMLSelectElement).value).toBe('5')
	})

	it('saves every field, closes, and reports the result', async () => {
		editTask.mockResolvedValue({ title: 'Report v2', moved: true, day: '2026-10-09' })
		const wrapper = await show()
		await wrapper.find('input.title').setValue('Report v2')
		await wrapper.find('textarea').setValue('final')
		await wrapper.find('input[aria-label=\"Due date\"]').setValue('2026-10-09')
		await wrapper.find('select').setValue('1')
		await save(wrapper)
		await flushPromises()
		expect(editTask).toHaveBeenCalledWith(7, { title: 'Report v2', description: 'final', start: '2026-10-01', due: '2026-10-09', priority: 1 })
		expect(onSaved).toHaveBeenCalledWith({ title: 'Report v2', moved: true, day: '2026-10-09' })
	})

	it('an emptied date is sent as no date', async () => {
		const wrapper = await show()
		await wrapper.find('input[aria-label=\"Start date\"]').setValue('')
		await save(wrapper)
		await flushPromises()
		expect(editTask).toHaveBeenCalledWith(7, expect.objectContaining({ start: null, due: '2026-10-03' }))
	})

	it('refuses an empty title and a due date before the start, without calling the server', async () => {
		const wrapper = await show()
		await wrapper.find('input.title').setValue('   ')
		await save(wrapper)
		await flushPromises()
		expect(wrapper.find('.note').text()).toContain('title is required')
		await wrapper.find('input.title').setValue('Ok')
		await wrapper.find('input[aria-label=\"Due date\"]').setValue('2026-09-01')
		await save(wrapper)
		await flushPromises()
		expect(wrapper.find('.note').text()).toContain('before the start')
		expect(editTask).not.toHaveBeenCalled()
	})

	it('stays open and shows the server message when saving fails', async () => {
		editTask.mockRejectedValue(new Error('The source task was deleted.'))
		const wrapper = await show()
		await save(wrapper)
		await flushPromises()
		expect(wrapper.find('.note').text()).toContain('source task was deleted')
		expect(wrapper.find('.dialog').exists()).toBe(true)
		expect(onSaved).not.toHaveBeenCalled()
	})

	it('a repeating task has its dates locked, with a hint', async () => {
		taskDetails.mockResolvedValue(details({ repeating: true }))
		const wrapper = await show()
		expect(wrapper.find('input[aria-label=\"Start date\"]').attributes('disabled')).toBeDefined()
		expect(wrapper.find('input[aria-label=\"Due date\"]').attributes('disabled')).toBeDefined()
		expect(wrapper.text()).toContain('only be changed in Tasks')
	})

	it('keeps an unusual priority instead of changing it', async () => {
		taskDetails.mockResolvedValue(details({ priority: 3 }))
		const wrapper = await show()
		expect((wrapper.find('select').element as HTMLSelectElement).value).toBe('3')
		await save(wrapper)
		await flushPromises()
		expect(editTask).toHaveBeenCalledWith(7, expect.objectContaining({ priority: 3 }))
	})

	it('shows the message and no form when the task cannot be read', async () => {
		taskDetails.mockRejectedValue(new Error('The source task was deleted.'))
		const wrapper = await show()
		expect(wrapper.find('.note').text()).toContain('deleted')
		expect(wrapper.find('input.title').exists()).toBe(false)
	})

	it('Cancel closes without saving', async () => {
		const wrapper = await show()
		await wrapper.findAll('.dialog-button')[0].trigger('click')
		expect(onClose).toHaveBeenCalled()
		expect(editTask).not.toHaveBeenCalled()
	})
})
