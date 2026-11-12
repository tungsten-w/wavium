// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createQuick = vi.fn(async (..._args: unknown[]) => ({ id: 99 }))
const renameQuick = vi.fn(async (..._args: unknown[]) => ({ ok: true }))
const deleteQuick = vi.fn(async (..._args: unknown[]) => ({ trash: 7 }))
const postpone = vi.fn(async (..._args: unknown[]) => ({ trash: 8, due: '2026-10-04' }))
const restore = vi.fn(async (..._args: unknown[]) => ({ ok: true }))
const taskDetails = vi.fn(async (..._args: unknown[]) => ({ title: 'Write report', description: '', start: null as string | null, due: '2026-10-03' as string | null, priority: 0, repeating: false }))
const editTask = vi.fn(async (..._args: unknown[]) => ({ title: 'Write report', moved: false, day: null as string | null }))
const moveOverdue = vi.fn(async (..._args: unknown[]) => ({ ok: true }))
let overdueTasks: { id: string; title: string; date: string }[] = []

const reorder = vi.fn(async (..._args: unknown[]) => ({ ok: true }))
const complete = vi.fn(async (..._args: unknown[]) => ({ ok: true }))
const dayCalls = vi.fn()
const versionCalls = vi.fn()
let currentVersion = 'v1'
let dayFails = false
const dayFailure = () => { if (dayFails) throw new Error('offline') }
const setVisibility = (state: 'visible' | 'hidden') => {
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

const item = (id: number, title: string, parent_id: number | null = null, source_type = 'quick') => ({
	id, source_type, title, starts_at: null, due_at: null, all_day: false,
	completed: false, href: null as string | null, error: null, parent_id,
})

let dayOverride: Record<string, unknown> | null = null
let dayItems: ReturnType<typeof item>[] = []
const resetItems = () => { dayItems = [item(1, 'A'), item(2, 'B'), item(3, 'C'), item(4, 'C child', 3), item(5, 'Study', null, 'routine'), item(6, 'Dentist', null, 'event')] }
resetItems()

vi.mock('../api', async (importOriginal) => ({
	...(await importOriginal<typeof import('../api')>()),
	api: {
		dayVersion: vi.fn(async () => (versionCalls(), dayFailure(), { version: currentVersion })),
		day: vi.fn(async () => (dayCalls(), dayFailure(), {
			day: '2026-10-03', logicalToday: '2026-10-03', editable: true, future: false, isOwner: true,
			items: dayItems,
			version: currentVersion,
			completeSubtasks: false,
			...dayOverride,
		})),
		createQuick: (...args: unknown[]) => createQuick(...args),
		renameQuick: (...args: unknown[]) => renameQuick(...args),
		deleteQuick: (...args: unknown[]) => deleteQuick(...args),
		postpone: (...args: unknown[]) => postpone(...args),
		restore: (...args: unknown[]) => restore(...args),
		taskDetails: (...args: unknown[]) => taskDetails(...args),
		editTask: (...args: unknown[]) => editTask(...args),
		overdue: async () => overdueTasks,
		moveOverdue: (...args: unknown[]) => moveOverdue(...args),
		reorder: (...args: unknown[]) => reorder(...args),
		complete: (...args: unknown[]) => complete(...args),
	},
}))

// Plain stand-ins for the Nextcloud components: they render their slots so the markup is inspectable.
vi.mock('@nextcloud/vue', async () => {
	const { defineComponent, h } = await import('vue')
	const stub = (tag: string, names: string[]) => defineComponent({
		inheritAttrs: false,
		props: ['name', 'disabled'],
		emits: ['click'],
		setup: (props, { slots, attrs, emit }) => () => h(tag, { ...attrs, disabled: props.disabled, onClick: (event: MouseEvent) => emit('click', event) }, [
			props.name ? h('span', props.name) : null,
			...names.map(n => slots[n]?.()),
		]),
	})
	return {
		NcActionButton: defineComponent({
			// Declared as Booleans like the real component, so a bare `close-after-click` means true.
			props: { disabled: Boolean, closeAfterClick: Boolean },
			emits: ['click'],
			setup: (p, { slots, emit }) => () => h('button', { class: 'action', 'data-close': String(p.closeAfterClick), disabled: p.disabled, onClick: () => emit('click') }, slots.default?.()),
		}),
		NcButton: stub('button', ['default']),
		// A checkbox that really toggles, so ticking can be tested.
		NcCheckboxRadioSwitch: defineComponent({
			props: ['modelValue', 'disabled'],
			emits: ['update:modelValue'],
			setup: (p, { slots, emit }) => () => h('label', { class: 'check', 'data-checked': String(p.modelValue), onClick: () => emit('update:modelValue', !p.modelValue) }, slots.default?.()),
		}),
		NcEmptyContent: stub('div', []),
		// A dialog that shows its content and buttons; the submit button sends `submit` like the real form.
		NcDialog: defineComponent({
			props: ['name', 'open', 'buttons'],
			emits: ['submit', 'closing', 'update:open'],
			setup: (p, { slots, emit }) => () => h('div', { class: 'dialog', 'data-name': p.name }, [
				slots.default?.(),
				...(p.buttons ?? []).map((entry: { label: string; type?: string; disabled?: boolean }) => h('button', {
					class: 'dialog-button',
					disabled: entry.disabled,
					onClick: () => (entry.type === 'submit' ? emit('submit', new Event('submit')) : emit('closing')),
				}, entry.label)),
			]),
		}),
		NcTextArea: defineComponent({
			inheritAttrs: false,
			props: ['modelValue', 'label'],
			emits: ['update:modelValue'],
			setup: (p, { emit }) => () => h('textarea', { value: p.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value) }),
		}),
		NcListItem: stub('li', ['icon', 'name', 'subname', 'actions']),
		NcLoadingIcon: stub('span', []),
		NcNoteCard: stub('div', ['default']),
		NcProgressBar: stub('div', []),
		// A real <input> so tests can type into it.
		NcTextField: defineComponent({
			inheritAttrs: false,
			props: ['modelValue', 'label'],
			emits: ['update:modelValue', 'blur'],
			setup: (p, { emit, attrs }) => () => h('input', {
				...attrs,
				value: p.modelValue,
				onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
				onBlur: () => emit('blur'),
			}),
		}),
	}
})

import DayView from './DayView.vue'

type Wrapper = Awaited<ReturnType<typeof mountView>>
const mounted: { unmount(): void }[] = []

async function mountView() {
	const wrapper = mount(DayView, { props: { date: new Date(2026, 9, 3) } })
	mounted.push(wrapper)
	await flushPromises()
	return wrapper
}
const group = (wrapper: Wrapper, index: number) => wrapper.findAll('.daily-todo__group')[index]
const action = (wrapper: Wrapper, groupIndex: number, label: string) =>
	group(wrapper, groupIndex).findAll('button.action').find(button => button.text() === label)
const typeInto = async (input: ReturnType<Wrapper['find']>, text: string) => {
	await input.setValue(text)
	await input.trigger('keydown', { key: 'Enter' })
	await flushPromises()
}

// Shared by every describe below: unmount what a test mounted, reset the fake server and the clock.
afterEach(() => {
	mounted.splice(0).forEach(wrapper => wrapper.unmount())
	vi.useRealTimers()
	setVisibility('visible')
})

beforeEach(() => {
	dayOverride = null
	dayFails = false
	currentVersion = 'v1'
	dayCalls.mockClear()
	versionCalls.mockClear()
	complete.mockClear()
	setVisibility('visible')
	resetItems()
	createQuick.mockReset()
	createQuick.mockImplementation(async () => ({ id: 99 }))
	renameQuick.mockClear()
	deleteQuick.mockClear()
	postpone.mockClear()
	restore.mockClear()
	taskDetails.mockReset()
	taskDetails.mockImplementation(async () => ({ title: 'Write report', description: '', start: null, due: '2026-10-03', priority: 0, repeating: false }))
	editTask.mockClear()
	moveOverdue.mockClear()
	overdueTasks = []
	reorder.mockClear()
})

const postponer = () => document.body.querySelector<HTMLElement>('.daily-todo__postponer')
const postponerButton = (label: string) => Array.from(postponer()?.querySelectorAll('button') ?? []).find(button => button.textContent?.trim() === label)!

describe('Today', () => {
	it('has one add box above the list; Enter adds an item', async () => {
		const wrapper = await mountView()
		const form = wrapper.find('form.daily-todo__add')
		const list = wrapper.find('.daily-todo__list')
		expect(form.element.compareDocumentPosition(list.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(form.findAll('button')).toHaveLength(0)
		await form.find('input').setValue('Buy milk')
		await form.trigger('submit')
		await flushPromises()
		expect(createQuick).toHaveBeenCalledWith('2026-10-03', 'Buy milk')
	})

	it('has no drag handle, Edit mode or Add here lines', async () => {
		const wrapper = await mountView()
		expect(wrapper.find('.drag').exists()).toBe(false)
		expect(wrapper.find('.inline-insert').exists()).toBe(false)
		expect(wrapper.findAll('button').map(button => button.text())).not.toContain('Edit')
	})

	it('indents subtasks', async () => {
		const wrapper = await mountView()
		const rows = group(wrapper, 2).findAll('li')
		expect(rows).toHaveLength(2)
		expect(rows[0].classes()).not.toContain('daily-todo__item--child')
		expect(rows[1].classes()).toContain('daily-todo__item--child')
		expect(rows[1].attributes('style')).toContain('--depth: 1')
	})

	it('click a title to rename; Enter saves it and opens a new line right below', async () => {
		const wrapper = await mountView()
		await group(wrapper, 0).find('.daily-todo__title-text').trigger('click')
		const rename = group(wrapper, 0).find('input.daily-todo__rename')
		await rename.setValue('A renamed')
		await rename.trigger('keydown', { key: 'Enter' })
		await flushPromises()
		expect(renameQuick).toHaveBeenCalledWith(1, 'A renamed')
		// the new line is drawn under A, at the same level
		const draftRow = group(wrapper, 0).find('li.daily-todo__draft-row')
		expect(draftRow.exists()).toBe(true)
		expect(draftRow.classes()).not.toContain('daily-todo__draft-row--sub')
		await typeInto(draftRow.find('input'), 'Right below A')
		expect(createQuick).toHaveBeenCalledWith('2026-10-03', 'Right below A', undefined, 1)
	})

	it('keeps adding lines: after Enter the next line opens below the new item', async () => {
		// like the server: the new item appears right after the one it was added below
		createQuick.mockImplementation(async (...args: unknown[]) => {
			const id = 100 + dayItems.length
			dayItems.splice(dayItems.findIndex(entry => entry.id === args[3]) + 1, 0, item(id, String(args[1])))
			return { id }
		})
		const wrapper = await mountView()
		await group(wrapper, 1).find('.daily-todo__title-text').trigger('click')
		await group(wrapper, 1).find('input.daily-todo__rename').trigger('keydown', { key: 'Enter' })
		await flushPromises()
		await typeInto(group(wrapper, 1).find('.daily-todo__draft'), 'one')
		await typeInto(group(wrapper, 2).find('.daily-todo__draft'), 'two') // 'one' is now its own row, so the line opens under it
		expect(createQuick.mock.calls.map(call => call.slice(1))).toEqual([
			['one', undefined, 2],
			['two', undefined, 106], // the id the server gave 'one'
		])
	})

	it('Add subtask opens an indented line and creates a subtask', async () => {
		const wrapper = await mountView()
		await action(wrapper, 0, 'Add subtask')!.trigger('click')
		const draftRow = group(wrapper, 0).find('li.daily-todo__draft-row')
		expect(draftRow.classes()).toContain('daily-todo__draft-row--sub')
		await typeInto(draftRow.find('input'), 'Sub')
		expect(createQuick).toHaveBeenCalledWith('2026-10-03', 'Sub', 1)
	})

	it('Enter on an empty line, or Esc, closes it without creating anything', async () => {
		const wrapper = await mountView()
		await action(wrapper, 0, 'Add subtask')!.trigger('click')
		await group(wrapper, 0).find('.daily-todo__draft').trigger('keydown', { key: 'Enter' })
		await flushPromises()
		expect(group(wrapper, 0).find('.daily-todo__draft-row').exists()).toBe(false)
		await action(wrapper, 0, 'Add subtask')!.trigger('click')
		await group(wrapper, 0).find('.daily-todo__draft').trigger('keydown', { key: 'Escape' })
		expect(group(wrapper, 0).find('.daily-todo__draft-row').exists()).toBe(false)
		expect(createQuick).not.toHaveBeenCalled()
	})

	it('deletes a quick item from its menu', async () => {
		const wrapper = await mountView()
		await action(wrapper, 1, 'Delete')!.trigger('click')
		await flushPromises()
		expect(deleteQuick).toHaveBeenCalledWith(2)
	})

	it('confirms deletion from Tasks and offers Undo for a real task', async () => {
		dayItems = [item(1, 'Real task', null, 'task'), item(2, 'Routine', null, 'routine'), item(3, 'Event', null, 'event')]
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
		const wrapper = await mountView()
		expect(action(wrapper, 1, 'Delete')).toBeUndefined()
		expect(action(wrapper, 2, 'Delete')).toBeUndefined()
		await action(wrapper, 0, 'Delete')!.trigger('click')
		await flushPromises()
		expect(confirm).not.toHaveBeenCalled()
		expect(deleteQuick).not.toHaveBeenCalled()
		const dialog = wrapper.find('.dialog[data-name="Delete task?"]')
		expect(dialog.text()).toContain('from the Tasks app too')
		await dialog.findAll('button').find(button => button.text() === 'Delete from Tasks')!.trigger('click')
		await flushPromises()
		expect(deleteQuick).toHaveBeenCalledWith(1)
		expect(wrapper.find('.daily-todo__undo').text()).toContain('Deleted "Real task"')
		confirm.mockRestore()
	})

	it('does not delete a task when confirmation is cancelled', async () => {
		dayItems = [item(1, 'Real task', null, 'task')]
		const wrapper = await mountView()
		await action(wrapper, 0, 'Delete')!.trigger('click')
		await flushPromises()
		const dialog = wrapper.find('.dialog[data-name="Delete task?"]')
		await dialog.findAll('button').find(button => button.text() === 'Cancel')!.trigger('click')
		await flushPromises()
		expect(deleteQuick).not.toHaveBeenCalled()
		expect(wrapper.find('.dialog[data-name="Delete task?"]').exists()).toBe(false)
	})

	it('offers Undo after a delete, and Undo restores it', async () => {
		const wrapper = await mountView()
		expect(wrapper.find('.daily-todo__undo').exists()).toBe(false)
		await action(wrapper, 1, 'Delete')!.trigger('click')
		await flushPromises()
		const bar = wrapper.find('.daily-todo__undo')
		expect(bar.text()).toContain('Deleted "B"')
		await bar.find('button').trigger('click')
		await flushPromises()
		expect(restore).toHaveBeenCalledWith(7)
		expect(wrapper.find('.daily-todo__undo').exists()).toBe(false)
	})

	it('the Undo offer goes away by itself', async () => {
		vi.useFakeTimers()
		const wrapper = await mountView()
		await action(wrapper, 1, 'Delete')!.trigger('click')
		await flushPromises()
		expect(wrapper.find('.daily-todo__undo').exists()).toBe(true)
		await vi.advanceTimersByTimeAsync(8100)
		expect(wrapper.find('.daily-todo__undo').exists()).toBe(false)
	})

	it('Postpone opens a calendar; choosing a date and confirming sends the offset and offers Undo', async () => {
		const wrapper = await mountView()
		await action(wrapper, 1, 'Postpone')!.trigger('click')
		await flushPromises()
		expect(postponer()).not.toBeNull()
		expect(postpone).not.toHaveBeenCalled() // choosing comes first
		postponer()!.querySelector<HTMLButtonElement>('[data-date="2026-10-06"]')!.click()
		await flushPromises()
		postponer()!.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
		await flushPromises()
		expect(postpone).toHaveBeenCalledWith(2, 3)
		expect(postponer()).toBeNull()
		expect(wrapper.find('.daily-todo__undo').text()).toContain('comes back')
		await wrapper.find('.daily-todo__undo button').trigger('click')
		await flushPromises()
		expect(restore).toHaveBeenCalledWith(8)
	})

	it('defaults to tomorrow and can navigate to another month', async () => {
		const wrapper = await mountView()
		await action(wrapper, 1, 'Postpone')!.trigger('click')
		await flushPromises()
		postponer()!.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
		await flushPromises()
		expect(postpone).toHaveBeenLastCalledWith(2, 1)
		expect(wrapper.find('.daily-todo__undo').text()).toContain('tomorrow')
		await action(wrapper, 1, 'Postpone')!.trigger('click')
		await flushPromises()
		postponer()!.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click()
		await flushPromises()
		postponer()!.querySelector<HTMLButtonElement>('[data-date="2026-11-02"]')!.click()
		await flushPromises()
		postponer()!.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
		await flushPromises()
		expect(postpone).toHaveBeenLastCalledWith(2, 30)
	})

	it('today and earlier dates cannot be selected', async () => {
		const wrapper = await mountView()
		await action(wrapper, 1, 'Postpone')!.trigger('click')
		await flushPromises()
		expect(postponer()!.querySelector<HTMLButtonElement>('[data-date="2026-10-03"]')!.disabled).toBe(true)
		expect(postponer()!.querySelector<HTMLButtonElement>('[data-date="2026-10-02"]')!.disabled).toBe(true)
		expect(postpone).not.toHaveBeenCalled()
	})

	it('Esc or a click elsewhere closes the Postpone bubble without postponing', async () => {
		const wrapper = await mountView()
		await action(wrapper, 1, 'Postpone')!.trigger('click')
		await flushPromises()
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
		await flushPromises()
		expect(postponer()).toBeNull()
		await action(wrapper, 1, 'Postpone')!.trigger('click')
		await flushPromises()
		postponer()!.dispatchEvent(new Event('pointerdown', { bubbles: true })) // inside: stays
		await flushPromises()
		expect(postponer()).not.toBeNull()
		document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
		await flushPromises()
		expect(postponer()).toBeNull()
		expect(postpone).not.toHaveBeenCalled()
	})

	it('only your own items on today can be postponed', async () => {
		const wrapper = await mountView()
		// a routine item (group 3) and an event (group 4)
		expect(action(wrapper, 3, 'Postpone')).toBeUndefined()
		expect(action(wrapper, 4, 'Postpone')).toBeUndefined()
	})

	it('clicking a real task opens the editor instead of renaming; its menu says Edit', async () => {
		dayItems = [item(1, 'Write report', null, 'task'), item(2, 'Buy milk')]
		const wrapper = await mountView()
		expect(action(wrapper, 0, 'Edit')).toBeDefined()
		expect(action(wrapper, 0, 'Rename')).toBeUndefined()
		expect(action(wrapper, 1, 'Rename')).toBeDefined() // your own items still rename in place
		await group(wrapper, 0).find('.daily-todo__title-text').trigger('click')
		await flushPromises()
		expect(wrapper.find('.dialog[data-name="Edit task"]').exists()).toBe(true)
		expect(taskDetails).toHaveBeenCalledWith(1)
		expect(group(wrapper, 0).find('input.daily-todo__rename').exists()).toBe(false)
		await group(wrapper, 1).find('.daily-todo__title-text').trigger('click')
		expect(group(wrapper, 1).find('input.daily-todo__rename').exists()).toBe(true)
	})

	it('Edit in the menu opens the editor too, and Cancel closes it without saving', async () => {
		dayItems = [item(1, 'Write report', null, 'task')]
		const wrapper = await mountView()
		await action(wrapper, 0, 'Edit')!.trigger('click')
		await flushPromises()
		expect(wrapper.find('.dialog').exists()).toBe(true)
		await wrapper.findAll('.dialog-button')[0].trigger('click')
		await flushPromises()
		expect(wrapper.find('.dialog').exists()).toBe(false)
		expect(editTask).not.toHaveBeenCalled()
	})

	it('saving the editor reloads the day; a task that went to another day says where', async () => {
		dayItems = [item(1, 'Write report', null, 'task')]
		editTask.mockResolvedValueOnce({ title: 'Write report', moved: true, day: '2026-10-08' })
		const wrapper = await mountView()
		await group(wrapper, 0).find('.daily-todo__title-text').trigger('click')
		await flushPromises()
		const loaded = dayCalls.mock.calls.length
		await wrapper.findAll('.dialog-button')[1].trigger('click')
		await flushPromises()
		expect(editTask).toHaveBeenCalledWith(1, { title: 'Write report', description: '', start: null, due: '2026-10-03', priority: 0 })
		expect(wrapper.find('.dialog').exists()).toBe(false)
		expect(dayCalls.mock.calls.length).toBeGreaterThan(loaded)
		const bar = wrapper.find('.daily-todo__undo')
		expect(bar.text()).toContain('is now on')
		expect(bar.find('button').exists()).toBe(false) // nothing to undo
	})

	it('shows overdue tasks as a nudge that opens into a list; Move to today moves one', async () => {
		overdueTasks = [{ id: '4:a.ics', title: 'Pay rent', date: '2026-09-28' }, { id: '4:b.ics', title: 'Call dentist', date: '2026-09-30' }]
		const wrapper = await mountView()
		const note = wrapper.find('.daily-todo__overdue')
		expect(note.text()).toContain('2 tasks are overdue')
		expect(note.find('ul').exists()).toBe(false)
		await note.find('.daily-todo__overdue-toggle').trigger('click')
		expect(note.findAll('li').map(row => row.find('.daily-todo__overdue-title').text())).toEqual(['Pay rent', 'Call dentist'])
		overdueTasks = [overdueTasks[1]]
		await note.findAll('li')[0].find('button').trigger('click')
		await flushPromises()
		expect(moveOverdue).toHaveBeenCalledWith('4:a.ics')
		expect(wrapper.find('.daily-todo__overdue').text()).toContain('1 task is overdue')
	})

	it('has no nudge when nothing is overdue, on another day, or on a shared list', async () => {
		let wrapper = await mountView()
		expect(wrapper.find('.daily-todo__overdue').exists()).toBe(false)
		overdueTasks = [{ id: '4:a.ics', title: 'Pay rent', date: '2026-09-28' }]
		dayOverride = { day: '2026-10-02' }
		wrapper = await mountView()
		expect(wrapper.find('.daily-todo__overdue').exists()).toBe(false)
	})

	it('a task can be postponed, but not a subtask or a finished task', async () => {
		dayItems = [item(1, 'Write report', null, 'task'), item(2, 'Draft', 1, 'task'), { ...item(3, 'Old task', null, 'task'), completed: true }]
		const wrapper = await mountView()
		expect(action(wrapper, 0, 'Postpone')).toBeDefined()
		expect(group(wrapper, 0).findAll('li')[1].findAll('button.action').map(button => button.text())).not.toContain('Postpone') // the subtask
		expect(action(wrapper, 1, 'Postpone')).toBeUndefined() // finished
		await action(wrapper, 0, 'Postpone')!.trigger('click')
		await flushPromises()
		postponer()!.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
		await flushPromises()
		expect(postpone).toHaveBeenCalledWith(1, 1)
	})

	it('an earlier day cannot postpone', async () => {
		dayOverride = { day: '2026-10-02' }
		const wrapper = await mountView()
		expect(action(wrapper, 1, 'Delete')).toBeDefined()
		expect(action(wrapper, 1, 'Postpone')).toBeUndefined()
	})

	it('highlights the actual all-day start through deadline and previews the shifted range', async () => {
		dayItems = [item(1, 'Write report', null, 'task')]
		taskDetails.mockResolvedValueOnce({ title: 'Write report', description: '', start: '2026-10-03', due: '2026-10-06', priority: 0, repeating: false })
		const wrapper = await mountView()
		await action(wrapper, 0, 'Postpone')!.trigger('click')
		await flushPromises()
		const dates = (selector: string) => Array.from(postponer()!.querySelectorAll<HTMLElement>(selector)).map(el => el.dataset.date)
		expect(dates('.postpone-calendar__current')).toEqual(['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'])
		expect(dates('.postpone-calendar__preview')).toEqual(['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'])
		postponer()!.querySelector<HTMLButtonElement>('[data-date="2026-10-10"]')!.click()
		await flushPromises()
		expect(dates('.postpone-calendar__preview')).toEqual(['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'])
		expect(postponer()!.textContent).toContain('Deadline')
	})

	it('blocks confirmation if task dates cannot be read or the task repeats', async () => {
		dayItems = [item(1, 'Write report', null, 'task')]
		taskDetails.mockRejectedValueOnce(new Error('Task unavailable'))
		const wrapper = await mountView()
		await action(wrapper, 0, 'Postpone')!.trigger('click')
		await flushPromises()
		expect(postponerButton('Postpone').disabled).toBe(true)
		expect(postponer()!.textContent).toContain('Task unavailable')
		postponer()!.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
		await flushPromises()
		expect(postpone).not.toHaveBeenCalled()
		postponerButton('Cancel').click()
		await flushPromises()
		taskDetails.mockResolvedValueOnce({ title: 'Write report', description: '', start: '2026-10-03', due: '2026-10-06', priority: 0, repeating: true })
		await action(wrapper, 0, 'Postpone')!.trigger('click')
		await flushPromises()
		expect(postponerButton('Postpone').disabled).toBe(true)
		expect(postponer()!.textContent).toContain('repeating task')
	})

	it('allows exactly 365 days ahead and disables dates beyond that', async () => {
		const wrapper = await mountView()
		await action(wrapper, 0, 'Postpone')!.trigger('click')
		await flushPromises()
		for (let i = 0; i < 12; i++) {
			postponer()!.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click()
			await flushPromises()
		}
		expect(postponer()!.querySelector<HTMLButtonElement>('[data-date="2027-10-03"]')!.disabled).toBe(false)
		expect(postponer()!.querySelector<HTMLButtonElement>('[data-date="2027-10-04"]')!.disabled).toBe(true)
		postponer()!.querySelector<HTMLButtonElement>('[data-date="2027-10-03"]')!.click()
		await flushPromises()
		postponer()!.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
		await flushPromises()
		expect(postpone).toHaveBeenCalledWith(1, 365)
	})
	it('Escape cancels an open new line, wherever the focus is', async () => {
		const wrapper = await mountView()
		await action(wrapper, 0, 'Add subtask')!.trigger('click')
		await group(wrapper, 0).find('.daily-todo__draft').setValue('half typed')
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
		await flushPromises()
		expect(group(wrapper, 0).find('.daily-todo__draft-row').exists()).toBe(false)
		expect(createQuick).not.toHaveBeenCalled()
	})

	it('Escape cancels a rename without saving it', async () => {
		const wrapper = await mountView()
		await group(wrapper, 0).find('.daily-todo__title-text').trigger('click')
		await group(wrapper, 0).find('input.daily-todo__rename').setValue('nope')
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
		await flushPromises()
		expect(group(wrapper, 0).find('input.daily-todo__rename').exists()).toBe(false)
		expect(renameQuick).not.toHaveBeenCalled()
	})

	it('survives focus being taken by the closing row menu', async () => {
		const wrapper = await mountView()
		await action(wrapper, 0, 'Add subtask')!.trigger('click')
		await group(wrapper, 0).find('.daily-todo__draft').trigger('blur') // empty line, focus stolen
		expect(group(wrapper, 0).find('.daily-todo__draft-row').exists()).toBe(true)
		await action(wrapper, 1, 'Rename')!.trigger('click')
		await group(wrapper, 1).find('input.daily-todo__rename').trigger('blur') // right after opening
		await flushPromises()
		expect(group(wrapper, 1).find('input.daily-todo__rename').exists()).toBe(true)
	})

	it('renames routine items and tasks, but not calendar events', async () => {
		const wrapper = await mountView()
		await group(wrapper, 3).find('.daily-todo__title-text').trigger('click') // the routine item
		const rename = group(wrapper, 3).find('input.daily-todo__rename')
		await rename.setValue('Study hard')
		await rename.trigger('keydown', { key: 'Enter' })
		await flushPromises()
		expect(renameQuick).toHaveBeenCalledWith(5, 'Study hard')
		expect(group(wrapper, 4).find('.daily-todo__title-text').exists()).toBe(false) // the event
		expect(action(wrapper, 4, 'Rename')).toBeUndefined()
	})



	it('a day that has not started is empty and read-only, with no way to add', async () => {
		dayOverride = { day: '2026-10-09', editable: false, future: true, items: [] }
		const wrapper = await mountView()
		expect(wrapper.text()).toContain("This day hasn't started yet.")
		expect(wrapper.html()).toContain('A day is created when it starts.') // the empty state's description
		expect(wrapper.find('form.daily-todo__add').exists()).toBe(false)
		expect(wrapper.find('.daily-todo__list').exists()).toBe(false)
	})
	it('says whose list it is when it was shared with you', async () => {
		const wrapper = mount(DayView, { props: { date: new Date(2026, 9, 3), sharedBy: 'the owner' } })
		mounted.push(wrapper)
		await flushPromises()
		expect(wrapper.text()).toContain('Shared by the owner')
		const own = await mountView()
		expect(own.text()).not.toContain('Shared by')
	})
})

describe('Row menu', () => {
	it('every action closes the menu after it is used, so it never stays open next to what it opened', async () => {
		const wrapper = await mountView()
		const actions = wrapper.findAll('button.action')
		expect(actions.length).toBeGreaterThan(0)
		expect(actions.map(button => button.attributes('data-close'))).toEqual(actions.map(() => 'true'))
		expect(new Set(actions.map(button => button.text()))).toEqual(new Set(['Rename', 'Add subtask', 'Move', 'Postpone', 'Delete']))
	})
})
describe('Ticking', () => {
	const checkboxOf = (wrapper: Wrapper, groupIndex: number, rowIndex: number) =>
		group(wrapper, groupIndex).findAll('li')[rowIndex].find('label.check')

	it('task and event rows do not wrap their checkboxes in source links', async () => {
		dayItems = [
			{ ...item(1, 'Task', null, 'task'), href: '/apps/tasks/' },
			{ ...item(2, 'Event', null, 'event'), href: '/apps/calendar/' },
		]
		const wrapper = await mountView()
		for (const index of [0, 1]) {
			expect(group(wrapper, index).find('li').attributes('href')).toBeUndefined()
			await checkboxOf(wrapper, index, 0).trigger('click')
			await flushPromises()
			expect(complete).toHaveBeenCalledWith(index + 1, true)
		}
		expect(group(wrapper, 1).find('a').attributes('href')).toBe('/apps/calendar/')
	})

	it('ticking a parent leaves its subtasks alone by default', async () => {
		const wrapper = await mountView()
		dayCalls.mockClear()
		await checkboxOf(wrapper, 2, 0).trigger('click') // "C", which has the subtask "C child"
		await flushPromises()
		expect(complete).toHaveBeenCalledTimes(1)
		expect(complete).toHaveBeenCalledWith(3, true)
		expect(checkboxOf(wrapper, 2, 0).attributes('data-checked')).toBe('true')
		expect(checkboxOf(wrapper, 2, 1).attributes('data-checked')).toBe('false') // independent
		expect(dayCalls).not.toHaveBeenCalled() // nothing else changed, so no reload
	})

	it('with the setting on, the day is read again so the ticked subtasks show', async () => {
		dayOverride = { completeSubtasks: true }
		const wrapper = await mountView()
		dayCalls.mockClear()
		await checkboxOf(wrapper, 2, 0).trigger('click')
		await flushPromises()
		expect(complete).toHaveBeenCalledWith(3, true)
		expect(dayCalls).toHaveBeenCalledTimes(1)
	})

	it('a subtask can be ticked on its own', async () => {
		const wrapper = await mountView()
		await checkboxOf(wrapper, 2, 1).trigger('click')
		await flushPromises()
		expect(complete).toHaveBeenCalledWith(4, true)
		expect(checkboxOf(wrapper, 2, 0).attributes('data-checked')).toBe('false') // the parent stays as it was
	})
})

describe('Move', () => {
	const names = (wrapper: Wrapper) => wrapper.findAll('.daily-todo__group').map(entry => entry.find('span').text())
	// The bubble is teleported to <body>, outside the component, so it is queried from the document.
	const bubble = () => document.body.querySelector<HTMLElement>('.daily-todo__mover')
	const bubbleButtons = () => Array.from(bubble()?.querySelectorAll('button') ?? [])
	const bubbleLabels = () => bubbleButtons().map(button => button.getAttribute('aria-label') ?? button.textContent?.trim())
	const bubbleButton = (label: string) => bubbleButtons().find(button => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === label)!
	const clickBubble = async (label: string) => {
		bubbleButton(label).click()
		await flushPromises()
	}
	const openMove = async (wrapper: Wrapper, groupIndex: number, rowIndex = 0) => {
		const row = group(wrapper, groupIndex).findAll('li')[rowIndex]
		await row.findAll('button.action').find(button => button.text() === 'Move')!.trigger('click')
		await flushPromises()
	}
	const press = async (key: string) => {
		window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
		await flushPromises()
	}

	it('a task added from the box goes straight into move mode', async () => {
		createQuick.mockImplementation(async () => {
			dayItems.splice(1, 0, item(99, 'Buy milk'))
			return { id: 99 }
		})
		const wrapper = await mountView()
		await wrapper.find('form.daily-todo__add input').setValue('Buy milk')
		await wrapper.find('form.daily-todo__add').trigger('submit')
		await flushPromises()
		expect(bubble()).not.toBeNull()
		await press('ArrowDown')
		expect(names(wrapper).slice(0, 3)).toEqual(['A', 'B', 'Buy milk'])
		await press('Enter')
		expect(bubble()).toBeNull()
	})

	it.each(['Enter', 'Escape', 'Done'] as const)('%s ends the move after adding a task and puts focus back in the add box', async (end) => {
		{
			createQuick.mockImplementation(async () => {
				dayItems.splice(1, 0, item(99, 'New'))
				return { id: 99 }
			})
			resetItems()
			const wrapper = mount(DayView, { props: { date: new Date(2026, 9, 3) }, attachTo: document.body })
			mounted.push(wrapper)
			await flushPromises()
			await wrapper.find('form.daily-todo__add input').setValue('New')
			await wrapper.find('form.daily-todo__add').trigger('submit')
			await flushPromises()
			expect(bubble()).not.toBeNull()
			expect(document.activeElement).not.toBe(wrapper.find('form.daily-todo__add input').element)
			if (end === 'Done') await clickBubble('Done')
			else await press(end)
			await new Promise(resolve => setTimeout(resolve, 20))
			expect(bubble()).toBeNull()
			expect(document.activeElement).toBe(wrapper.find('form.daily-todo__add input').element)
		}
	})

	it('clicking elsewhere ends the move without stealing focus', async () => {
		createQuick.mockImplementation(async () => {
			dayItems.splice(1, 0, item(99, 'New'))
			return { id: 99 }
		})
		const wrapper = mount(DayView, { props: { date: new Date(2026, 9, 3) }, attachTo: document.body })
		mounted.push(wrapper)
		await flushPromises()
		await wrapper.find('form.daily-todo__add input').setValue('New')
		await wrapper.find('form.daily-todo__add').trigger('submit')
		await flushPromises()
		document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
		await new Promise(resolve => setTimeout(resolve, 20))
		expect(bubble()).toBeNull()
		expect(document.activeElement).not.toBe(wrapper.find('form.daily-todo__add input').element)
	})

	it('one Move in the row menu opens a bubble with up, Done and down, and marks the row', async () => {
		const wrapper = await mountView()
		expect(bubble()).toBeNull()
		await openMove(wrapper, 0)
		expect(bubbleLabels()).toEqual(['Move up', 'Done', 'Move down'])
		expect(group(wrapper, 0).findAll('li')[0].classes()).toContain('daily-todo__item--moving')
		expect(wrapper.findAll('button.action').map(button => button.text())).not.toContain('Move up') // one entry, not two
	})

	it('moves again and again from the same bubble: instantly on screen, saved in order in the background', async () => {
		const wrapper = await mountView()
		let release: () => void = () => {}
		reorder.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ ok: true }) }))
		await openMove(wrapper, 0)
		await clickBubble('Move down')
		expect(names(wrapper).slice(0, 2)).toEqual(['B', 'A']) // before the server answered
		await clickBubble('Move down')
		expect(names(wrapper).slice(0, 3)).toEqual(['B', 'C', 'A'])
		expect(reorder).toHaveBeenCalledTimes(1) // the second save waits for the first
		release()
		await flushPromises()
		expect(reorder.mock.calls.map(call => call[1])).toEqual([[2, 1, 3, 4, 5, 6], [2, 3, 4, 1, 5, 6]])
		expect(bubble()).not.toBeNull() // still there for more
	})

	it('Done, Escape and a click elsewhere close it; a click inside does not', async () => {
		const wrapper = await mountView()
		await openMove(wrapper, 0)
		await clickBubble('Done')
		expect(bubble()).toBeNull()

		await openMove(wrapper, 0)
		await press('Escape')
		expect(bubble()).toBeNull()

		await openMove(wrapper, 0)
		bubble()!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
		await flushPromises()
		expect(bubble()).not.toBeNull()
		document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
		await flushPromises()
		expect(bubble()).toBeNull()
	})

	it('arrow keys move the item while the bubble is open, and Enter finishes', async () => {
		const wrapper = await mountView()
		await openMove(wrapper, 0)
		await press('ArrowDown')
		expect(names(wrapper).slice(0, 2)).toEqual(['B', 'A'])
		await press('ArrowUp')
		expect(names(wrapper).slice(0, 2)).toEqual(['A', 'B'])
		await press('ArrowDown')
		await press('Enter')
		expect(bubble()).toBeNull()
		const saved = reorder.mock.calls.length
		await press('ArrowDown') // nothing is being moved any more
		expect(reorder.mock.calls.length).toBe(saved)
		expect(names(wrapper).slice(0, 2)).toEqual(['B', 'A'])
	})

	it('arrow keys are left alone while you are typing in a field', async () => {
		const wrapper = mount(DayView, { props: { date: new Date(2026, 9, 3) }, attachTo: document.body })
		mounted.push(wrapper)
		await flushPromises()
		await openMove(wrapper, 0)
		wrapper.find('form.daily-todo__add input').element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
		await flushPromises()
		expect(reorder).not.toHaveBeenCalled()
	})

	it('cannot move past the top or the bottom', async () => {
		const wrapper = await mountView()
		await openMove(wrapper, 0)
		expect(bubbleButton('Move up').disabled).toBe(true)
		expect(bubbleButton('Move down').disabled).toBe(false)
		for (let step = 0; step < 4; step++) await press('ArrowDown')
		expect(names(wrapper).slice(-1)).toEqual(['A'])
		expect(bubbleButton('Move down').disabled).toBe(true)
		expect(bubbleButton('Move up').disabled).toBe(false)
	})

	it('moves a subtask only among its own siblings', async () => {
		dayItems.push(item(7, 'C child 2', 3))
		const wrapper = await mountView()
		await openMove(wrapper, 2, 1) // "C child", the first subtask of "C"
		await press('ArrowDown')
		expect(reorder).toHaveBeenLastCalledWith('2026-10-03', [1, 2, 3, 7, 4, 5, 6])
	})

	it('a parent keeps its subtasks when it moves', async () => {
		const wrapper = await mountView()
		await openMove(wrapper, 2) // "C", which has a subtask
		await press('ArrowUp')
		expect(reorder).toHaveBeenLastCalledWith('2026-10-03', [1, 3, 4, 2, 5, 6])
	})

	it('puts back what the server really has, and says why, when a save fails', async () => {
		const wrapper = await mountView()
		reorder.mockRejectedValueOnce(new Error('This day is read-only'))
		await openMove(wrapper, 0)
		await press('ArrowDown')
		await flushPromises()
		expect(wrapper.text()).toContain('This day is read-only')
		expect(names(wrapper).slice(0, 2)).toEqual(['A', 'B']) // reloaded from the server
	})
})

describe('Live sync', () => {
	const tick = async (ms = 10_000) => {
		await vi.advanceTimersByTimeAsync(ms)
		await flushPromises()
	}
	const mountWithTimers = async (props: Record<string, unknown> = {}) => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
		const wrapper = mount(DayView, { props: { date: new Date(2026, 9, 3), ...props } })
		mounted.push(wrapper)
		await flushPromises()
		dayCalls.mockClear()
		versionCalls.mockClear()
		return wrapper
	}
	/** What a phone or the scheduling agent does: change the day on the server. */
	const editElsewhere = (title: string) => {
		dayItems.push(item(100 + dayItems.length, title))
		currentVersion = `v${Number(currentVersion.slice(1)) + 1}`
	}

	it('checks for changes every 10 seconds but only loads the day when something changed', async () => {
		const wrapper = await mountWithTimers()
		const list = wrapper.find('.daily-todo__list').element
		await tick()
		await tick()
		expect(versionCalls).toHaveBeenCalledTimes(2)
		expect(dayCalls).not.toHaveBeenCalled() // nothing changed, so the list was not even fetched
		expect(wrapper.find('.daily-todo__loading').exists()).toBe(false) // no spinner, no blank page
		expect(wrapper.find('.daily-todo__list').element).toBe(list) // the same element: nothing was rebuilt
	})

	it('shows an edit made elsewhere, in place and without a reload', async () => {
		const wrapper = await mountWithTimers()
		const list = wrapper.find('.daily-todo__list').element
		expect(wrapper.text()).not.toContain('added on the phone')
		editElsewhere('added on the phone')
		await tick()
		expect(dayCalls).toHaveBeenCalledTimes(1)
		expect(wrapper.text()).toContain('added on the phone')
		expect(wrapper.find('.daily-todo__loading').exists()).toBe(false)
		expect(wrapper.find('.daily-todo__list').element).toBe(list)
		await tick() // and the next check sees nothing new
		expect(dayCalls).toHaveBeenCalledTimes(1)
	})

	it('does not check while you are typing a new line or a rename', async () => {
		const wrapper = await mountWithTimers()
		await action(wrapper, 0, 'Add subtask')!.trigger('click')
		await tick(30_000)
		expect(versionCalls).not.toHaveBeenCalled()
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
		await group(wrapper, 0).find('.daily-todo__title-text').trigger('click')
		await tick(30_000)
		expect(versionCalls).not.toHaveBeenCalled()
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
		await tick()
		expect(versionCalls).toHaveBeenCalledTimes(1) // and it carries on once you are done
	})

	it('does not check while the move bubble is open', async () => {
		const wrapper = await mountWithTimers()
		await group(wrapper, 0).findAll('li')[0].findAll('button.action').find(button => button.text() === 'Move')!.trigger('click')
		await tick(30_000)
		expect(versionCalls).not.toHaveBeenCalled()
		Array.from(document.body.querySelectorAll('.daily-todo__mover button')).find(button => button.textContent?.trim() === 'Done')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		await flushPromises()
		await tick()
		expect(versionCalls).toHaveBeenCalledTimes(1)
	})

	it('does not check while the tab is hidden, and checks the moment it is shown again', async () => {
		const wrapper = await mountWithTimers()
		setVisibility('hidden')
		await tick(30_000)
		expect(versionCalls).not.toHaveBeenCalled()
		editElsewhere('changed while away')
		setVisibility('visible')
		document.dispatchEvent(new Event('visibilitychange'))
		await flushPromises()
		expect(wrapper.text()).toContain('changed while away') // instantly, no waiting for the timer
		window.dispatchEvent(new Event('focus'))
		await flushPromises()
		expect(versionCalls).toHaveBeenCalledTimes(2)
	})

	it('waits while a change of yours is still being saved', async () => {
		await mountWithTimers().then(async (wrapper) => {
			let finish: (value: { id: number }) => void = () => {}
			createQuick.mockImplementation(() => new Promise(resolve => { finish = resolve }))
			await wrapper.find('form.daily-todo__add input').setValue('slow one')
			await wrapper.find('form.daily-todo__add').trigger('submit')
			await tick(30_000)
			expect(versionCalls).not.toHaveBeenCalled() // would otherwise overwrite the unsaved item
			finish({ id: 99 })
			await flushPromises()
			versionCalls.mockClear()
			await tick()
			expect(versionCalls).toHaveBeenCalledTimes(1)
		})
	})

	it('stays quiet when the check fails, and recovers on its own', async () => {
		const wrapper = await mountWithTimers()
		dayFails = true
		await tick()
		await tick()
		expect(wrapper.text()).not.toContain('offline') // no error banner every 10 seconds
		expect(wrapper.find('.daily-todo__list').exists()).toBe(true) // the list stays as it was
		dayFails = false
		editElsewhere('back online')
		await tick()
		expect(wrapper.text()).toContain('back online')
	})

	it('tells the app only when the day really changed, so the calendar updates then and not every time', async () => {
		const onChanged = vi.fn()
		await mountWithTimers({ onChanged })
		onChanged.mockClear()
		await tick()
		expect(onChanged).not.toHaveBeenCalled()
		editElsewhere('something new')
		await tick()
		expect(onChanged).toHaveBeenCalledTimes(1)
	})

	it('stops completely when the view is closed', async () => {
		const wrapper = await mountWithTimers()
		wrapper.unmount()
		mounted.splice(0)
		await tick(60_000)
		window.dispatchEvent(new Event('focus'))
		document.dispatchEvent(new Event('visibilitychange'))
		await flushPromises()
		expect(versionCalls).not.toHaveBeenCalled()
		expect(dayCalls).not.toHaveBeenCalled()
	})
})
