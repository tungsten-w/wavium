// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shares = vi.fn()
const addShare = vi.fn()
const deleteShare = vi.fn()
const saveSettings = vi.fn()

vi.mock('../api', async (importOriginal) => ({
	...(await importOriginal<typeof import('../api')>()),
	api: {
		settings: async () => ({ timezone: 'UTC', rolloverHour: 3, rolloverMode: 'all', completeSubtasks: false, taskLists: [], calendars: [], isOwner: true }),
		sources: async () => ({ tasks: [], calendars: [] }),
		day: async () => ({ day: '2026-10-03', logicalToday: '2026-10-03', editable: true, future: false, isOwner: true, items: [] }),
		shares: (...args: unknown[]) => shares(...args),
		addShare: (...args: unknown[]) => addShare(...args),
		deleteShare: (...args: unknown[]) => deleteShare(...args),
		reset: vi.fn(),
		saveSettings: (...args: unknown[]) => saveSettings(...args),
	},
}))

vi.mock('@nextcloud/vue', async () => {
	const { defineComponent, h } = await import('vue')
	const box = (tag: string) => defineComponent({
		inheritAttrs: false,
		props: ['name', 'label', 'disabled'],
		emits: ['click'],
		setup: (p, { slots, attrs, emit }) => () => h(tag, { ...attrs, disabled: p.disabled, onClick: () => emit('click') }, [
			p.name ? h('h3', p.name) : null,
			slots.default?.(),
			slots.icon?.(),
		]),
	})
	return {
		NcButton: box('button'),
		// A switch that really toggles, so v-model works in tests.
		NcCheckboxRadioSwitch: defineComponent({
			props: ['modelValue'],
			emits: ['update:modelValue'],
			setup: (p, { slots, emit }) => () => h('label', { 'data-checked': String(p.modelValue), onClick: () => emit('update:modelValue', !p.modelValue) }, slots.default?.()),
		}),
		NcDialog: box('div'),
		NcLoadingIcon: box('span'),
		NcNoteCard: box('div'),
		NcSelect: box('div'),
		NcSettingsSection: box('section'),
		NcTextField: defineComponent({
			inheritAttrs: false,
			props: ['modelValue', 'label'],
			emits: ['update:modelValue'],
			setup: (p, { emit, attrs }) => () => h('input', {
				...attrs,
				'aria-label': p.label,
				value: p.modelValue,
				onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
			}),
		}),
	}
})

import BoardSettings from './BoardSettings.vue'

const mounted: { unmount(): void }[] = []
async function mountSettings() {
	const wrapper = mount(BoardSettings)
	mounted.push(wrapper)
	await flushPromises()
	return wrapper
}
const sharingSection = (wrapper: Awaited<ReturnType<typeof mountSettings>>) =>
	wrapper.findAll('section').find(section => section.find('h3').text() === 'Sharing')!

describe('Sharing settings', () => {
	beforeEach(() => {
		shares.mockReset()
		addShare.mockReset()
		deleteShare.mockReset()
		shares.mockResolvedValue([])
		addShare.mockResolvedValue({ ok: true })
		deleteShare.mockResolvedValue({ ok: true })
	})
	afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))

	it('says so when the list is not shared', async () => {
		const wrapper = await mountSettings()
		expect(sharingSection(wrapper).text()).toContain('Not shared with anyone.')
	})

	it('shares with a person by username and shows the new share', async () => {
		const wrapper = await mountSettings()
		shares.mockResolvedValue([{ id: 7, share_type: 'user', share_with: 'nova', display_name: 'Nova' }])
		const section = sharingSection(wrapper)
		await section.find('input').setValue('nova')
		await section.find('form').trigger('submit')
		await flushPromises()
		expect(addShare).toHaveBeenCalledWith('user', 'nova')
		expect(sharingSection(wrapper).text()).toContain('Nova')
		expect((sharingSection(wrapper).find('input').element as HTMLInputElement).value).toBe('') // box cleared
	})

	it('stops sharing from the list', async () => {
		shares.mockResolvedValue([{ id: 7, share_type: 'user', share_with: 'nova', display_name: 'Nova' }])
		const wrapper = await mountSettings()
		shares.mockResolvedValue([])
		await sharingSection(wrapper).find('button[aria-label="Stop sharing with Nova"]').trigger('click')
		await flushPromises()
		expect(deleteShare).toHaveBeenCalledWith(7)
		expect(sharingSection(wrapper).text()).toContain('Not shared with anyone.')
	})

	it("shows the server's reason when a share is refused", async () => {
		addShare.mockRejectedValue(new Error('There is no user called "nobody"'))
		const wrapper = await mountSettings()
		const section = sharingSection(wrapper)
		await section.find('input').setValue('nobody')
		await section.find('form').trigger('submit')
		await flushPromises()
		expect(wrapper.text()).toContain('There is no user called "nobody"')
	})

	it('does not offer Share for an empty name', async () => {
		const wrapper = await mountSettings()
		const button = sharingSection(wrapper).findAll('button').find(b => b.text() === 'Share')!
		expect(button.attributes('disabled')).toBeDefined()
	})
})

describe('Subtasks setting', () => {
	beforeEach(() => {
		shares.mockReset()
		shares.mockResolvedValue([])
		saveSettings.mockReset()
		saveSettings.mockImplementation(async (value: unknown) => value)
	})
	afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))

	const subtaskSwitch = (wrapper: Awaited<ReturnType<typeof mountSettings>>) =>
		wrapper.findAll('section').find(section => section.find('h3').text() === 'Subtasks')!.find('label')

	it('is off by default: subtasks are independent', async () => {
		const wrapper = await mountSettings()
		expect(subtaskSwitch(wrapper).attributes('data-checked')).toBe('false')
		expect(wrapper.text()).toContain('Ticking a task also ticks its subtasks')
	})

	it('turns on and is saved with the other settings', async () => {
		const wrapper = await mountSettings()
		await subtaskSwitch(wrapper).trigger('click')
		expect(subtaskSwitch(wrapper).attributes('data-checked')).toBe('true')
		await wrapper.findAll('button').find(button => button.text() === 'Save changes')!.trigger('click')
		await flushPromises()
		expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ completeSubtasks: true, timezone: 'UTC' }))
	})
})
