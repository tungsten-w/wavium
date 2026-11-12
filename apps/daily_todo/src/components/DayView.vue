<script setup lang="ts">
import {
	NcActionButton,
	NcButton,
	NcCheckboxRadioSwitch,
	NcDialog,
	NcEmptyContent,
	NcListItem,
	NcLoadingIcon,
	NcNoteCard,
	NcProgressBar,
} from '@nextcloud/vue'
import ArrowDown from 'vue-material-design-icons/ArrowDown.vue'
import ArrowLeft from 'vue-material-design-icons/ArrowLeft.vue'
import ArrowRight from 'vue-material-design-icons/ArrowRight.vue'
import ArrowUp from 'vue-material-design-icons/ArrowUp.vue'
import CalendarArrowRight from 'vue-material-design-icons/CalendarArrowRight.vue'
import DeleteOutline from 'vue-material-design-icons/DeleteOutline.vue'
import PencilOutline from 'vue-material-design-icons/PencilOutline.vue'
import Plus from 'vue-material-design-icons/Plus.vue'
import SwapVertical from 'vue-material-design-icons/SwapVertical.vue'
import WeatherSunsetUp from 'vue-material-design-icons/WeatherSunsetUp.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, board, separatorKind, type Day, type Item, type OverdueTask } from '../api'
import TaskDialog from './TaskDialog.vue'
import PostponeCalendar from './PostponeCalendar.vue'

type Group = { item: Item; children: Item[] }
/** An open "new item" line: next to `target` (same level) or as a subtask of it. */
type Draft = { kind: 'sibling' | 'sub'; target: number }

// The selected day is owned by the parent (sidebar calendar); this view follows it.
const date = defineModel<Date>('date', { required: true })
defineProps<{ sharedBy?: string }>()
const emit = defineEmits<{ changed: [] }>()

const root = ref<HTMLElement>()
const day = ref<Day>()
const loading = ref(true)
const hideCompleted = ref(false)
const error = ref('')
const quickTitle = ref('')
const draft = ref<Draft | null>(null)
const draftTitle = ref('')
const renamingId = ref<number | null>(null)
const renameTitle = ref('')
// Move mode: the item being moved and where its bubble floats (viewport pixels).
const movingId = ref<number | null>(null)
const bubble = ref({ x: 0, y: 0 })
// Set while the move bubble was opened by adding a task: when the move ends, the add box gets focus back.
let refocusAfterMove = false
// The last delete / "move to tomorrow", offered for a few seconds so it can be undone.
const undo = ref<{ trash: number | null; message: string } | null>(null)
// The task being edited in the dialog (real tasks open it instead of renaming in place).
const editingTaskId = ref<number | null>(null)
const deletingTask = ref<Item | null>(null)
// Unfinished tasks of earlier days that are not on today's list.
const overdue = ref<OverdueTask[]>([])
const showOverdue = ref(false)
let undoTimer: ReturnType<typeof setTimeout> | undefined
// Postpone calendar: the item being postponed.
const postponingId = ref<number | null>(null)
const postponingItem = computed(() => day.value?.items.find(item => item.id === postponingId.value))
const movingItem = computed(() => day.value?.items.find(item => item.id === movingId.value))

const heading = computed(() => date.value.toLocaleDateString(undefined, {
	weekday: 'long',
	year: 'numeric',
	month: 'long',
	day: 'numeric',
}))
// Separators are layout, not work: they never count towards progress.
const checkable = computed(() => day.value?.items.filter(item => !separatorKind(item.title)) ?? [])
const completed = computed(() => checkable.value.filter(item => item.completed).length)
const progress = computed(() => checkable.value.length
	? completed.value / checkable.value.length * 100
	: 0)

const groups = computed<Group[]>(() => {
	const items = day.value?.items ?? []
	const byId = new Map(items.map(item => [item.id, item]))
	// Walk up to the top-level ancestor; the step cap guards against parent cycles.
	const rootOf = (item: Item): Item => {
		let current = item
		for (let step = 0; step < items.length; step++) {
			const parent = current.parent_id === null ? undefined : byId.get(current.parent_id)
			if (!parent) break
			current = parent
		}
		return current
	}
	const shown = (item: Item) => !hideCompleted.value || !item.completed
	const result = new Map<number, Group>()
	for (const item of items) {
		const top = rootOf(item)
		const group = result.get(top.id) ?? { item: top, children: [] }
		if (item !== top && shown(item)) group.children.push(item)
		result.set(top.id, group)
	}
	return [...result.values()]
		.filter(group => separatorKind(group.item.title) || shown(group.item) || group.children.length)
})

function depthOf(item: Item): number {
	const byId = new Map((day.value?.items ?? []).map(entry => [entry.id, entry]))
	let depth = 0
	for (let current = item; current.parent_id !== null && depth < 20; depth++) {
		const parent = byId.get(current.parent_id)
		if (!parent) break
		current = parent
	}
	return depth
}

function rowsOf(group: Group): Item[] {
	return [group.item, ...group.children]
}

function dateKey(): string {
	const offset = date.value.getTimezoneOffset() * 60_000
	return new Date(date.value.getTime() - offset).toISOString().slice(0, 10)
}

/**
 * Read the day from the server. `silent` keeps the list on screen (no spinner);
 * `background` is the periodic refresh, which also stays quiet when it fails.
 */
async function load(silent = false, background = false): Promise<void> {
	if (!silent) {
		loading.value = true
		error.value = ''
	}
	try {
		day.value = await api.day(dateKey())
		knownVersion = day.value.version
		emit('changed')
		loadOverdue()
	} catch (reason) {
		if (!background) showError(reason)
	} finally {
		loading.value = false
	}
}

// --- live sync: pick up edits made elsewhere (phone, scheduling agent) ------------------

const POLL_MS = 10_000
/** Requests of your own that are still being saved; a refresh must not overwrite them. */
const saving = ref(0)
let refreshing = false
/** The version of the day as last loaded; the cheap check below compares against it. */
let knownVersion = ''
let pollTimer: ReturnType<typeof setInterval> | undefined

async function mutate<T>(request: () => Promise<T>): Promise<T> {
	saving.value++
	try {
		return await request()
	} finally {
		saving.value--
	}
}

/**
 * Ask the server whether the open day changed (a few milliseconds) and only then load it. Never
 * touches the screen when that could disturb you: the tab is hidden, you are typing (a rename
 * or a new line is open), a change of yours is still being saved, or the previous check has
 * not finished. Failures stay silent; the next check simply tries again.
 */
async function refreshInBackground(): Promise<void> {
	if (document.visibilityState !== 'visible') return
	if (loading.value || refreshing || saving.value > 0) return
	if (renamingId.value !== null || draft.value !== null || movingId.value !== null || postponingId.value !== null || deletingTask.value !== null) return
	refreshing = true
	const key = dateKey()
	try {
		const { version } = await api.dayVersion(key)
		// Nothing new, or you moved to another day meanwhile.
		if (version === knownVersion || key !== dateKey()) return
		await load(true, true)
	} catch {
		// offline or a hiccup: try again at the next check
	} finally {
		refreshing = false
	}
}

function onVisibilityChange(): void {
	if (document.visibilityState === 'visible') refreshInBackground()
}

function move(days: number): void {
	date.value = new Date(
		date.value.getFullYear(),
		date.value.getMonth(),
		date.value.getDate() + days,
	)
}

function goToday(): void {
	date.value = new Date()
}

const focusTimers: ReturnType<typeof setTimeout>[] = []

async function focusSoon(selector: string): Promise<void> {
	await nextTick()
	const focus = () => {
		const input = root.value?.querySelector<HTMLInputElement>(selector)
		if (input && input.ownerDocument.activeElement !== input) input.focus()
	}
	focus()
	// The row menu hands focus back to its button while it closes; take it again.
	focusTimers.push(setTimeout(focus, 80), setTimeout(focus, 300))
}

async function toggle(item: Item): Promise<void> {
	const previous = item.completed
	item.completed = !previous
	try {
		await mutate(() => api.complete(item.id, item.completed))
		// With the board's "complete subtasks" setting on, the server also ticked the subtasks:
		// read the day again to show them. Otherwise subtasks are independent and nothing else changed.
		if (item.completed && day.value?.completeSubtasks) await load(true)
		else emit('changed')
	} catch (reason) {
		item.completed = previous
		showError(reason)
	}
}

/** The box at the top: Enter adds an item and the box stays focused for the next one. */
async function addQuick(): Promise<void> {
	const title = quickTitle.value.trim()
	if (!title) return
	try {
		const { id } = await mutate(() => api.createQuick(dateKey(), title))
		quickTitle.value = ''
		await load(true)
		// The new item goes straight into move mode. Arrow keys are ignored while typing in a
		// field, so leave the box; Enter or Esc ends the move.
		const added = day.value?.items.find(item => item.id === id)
		if (added) {
			await nextTick()
			root.value?.querySelector<HTMLInputElement>('.daily-todo__add input')?.blur()
			startMove(added)
			refocusAfterMove = true
			scrollToItem(added.id)
		} else {
			await focusSoon('.daily-todo__add input')
		}
	} catch (reason) {
		showError(reason)
	}
}

function isQuick(item: Item): boolean {
	return item.source_type === 'quick' && !!day.value?.editable
}

/** Your own items, routine items (that day only) and tasks (also renamed in Tasks) can be renamed. */
function canRename(item: Item): boolean {
	return !!day.value?.editable && item.source_type !== 'event' && !separatorKind(item.title)
}

function hasActions(item: Item): boolean {
	return !!day.value?.editable && !separatorKind(item.title)
}

// --- a new line below an item, or a subtask of it ---------------------------------------

function openDraft(kind: Draft['kind'], target: number): void {
	draft.value = { kind, target }
	draftTitle.value = ''
	focusSoon('.daily-todo__draft')
}

/** Where the open draft line is drawn within `group`, and whether it is indented. */
function draftSlot(group: Group): { afterRowId: number; indented: boolean } | null {
	if (!draft.value) return null
	const rows = rowsOf(group)
	const target = rows.find(row => row.id === draft.value?.target)
	if (!target) return null
	const isTop = target === group.item
	return {
		afterRowId: isTop ? rows[rows.length - 1].id : target.id,
		indented: draft.value.kind === 'sub' || !isTop,
	}
}

async function commitDraft(): Promise<void> {
	const current = draft.value
	const title = draftTitle.value.trim()
	if (!current || !title) {
		draft.value = null
		return
	}
	try {
		const created = current.kind === 'sub'
			? await mutate(() => api.createQuick(dateKey(), title, current.target))
			: await mutate(() => api.createQuick(dateKey(), title, undefined, current.target))
		draftTitle.value = ''
		await load(true)
		// Keep going: the next line opens right below the one just added.
		openDraft('sibling', created.id)
	} catch (reason) {
		showError(reason)
	}
}

// --- rename in place (your own items only) --------------------------------------------------

let renameOpenedAt = 0

function startRename(item: Item): void {
	if (!canRename(item)) return
	if (item.source_type === 'task') {
		// A real task: edit it in a dialog (title, notes, dates, priority), saved in Tasks.
		draft.value = null
		renamingId.value = null
		editingTaskId.value = item.id
		return
	}
	renameOpenedAt = Date.now()
	renamingId.value = item.id
	renameTitle.value = item.title
	focusSoon('.daily-todo__rename')
}

async function commitRename(item: Item): Promise<void> {
	if (renamingId.value !== item.id) return
	renamingId.value = null
	const title = renameTitle.value.trim()
	if (!title || title === item.title) return
	try {
		await mutate(() => api.renameQuick(item.id, title))
		item.title = title
	} catch (reason) {
		showError(reason)
	}
}

/** Leaving the field saves it, unless focus was only taken away by the row menu closing. */
function onRenameBlur(item: Item): void {
	if (Date.now() - renameOpenedAt < 400) {
		focusSoon('.daily-todo__rename')
		return
	}
	commitRename(item)
}

/** Enter saves the title and opens a new line right below, like a checklist. */
async function renameAndContinue(item: Item): Promise<void> {
	await commitRename(item)
	openDraft('sibling', item.id)
}

/** The visible items an item can swap places with: the top-level rows, or the subtasks of its parent. */
function siblingsOf(item: Item): number[] {
	const items = day.value?.items ?? []
	if (item.parent_id === null || !items.some(entry => entry.id === item.parent_id)) {
		return groups.value.map(group => group.item.id)
	}
	const group = groups.value.find(entry => entry.children.some(child => child.id === item.id))
	return group ? group.children.filter(child => child.parent_id === item.parent_id).map(child => child.id) : []
}

function neighbourOf(item: Item, direction: -1 | 1): number | undefined {
	const ids = siblingsOf(item)
	return ids[ids.indexOf(item.id) + direction]
}

/** Swap an item with the one above or below it (a parent keeps its subtasks). */
let reorderChain: Promise<unknown> = Promise.resolve()

/** Save an order in the background. Requests go out one after another so fast clicks stay in order. */
function saveOrder(order: number[]): void {
	saving.value++
	const key = dateKey()
	reorderChain = reorderChain
		.then(() => api.reorder(key, order))
		.catch(async (reason) => {
			showError(reason)
			await load(true) // the server is the truth: show what it really has
		})
		.finally(() => { saving.value-- })
}

function scrollToItem(id: number): void {
	nextTick(() => {
		root.value?.querySelector(`[data-item-id="${id}"]`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
	})
}

function moveItem(item: Item, direction: -1 | 1): void {
	const neighbour = neighbourOf(item, direction)
	if (neighbour === undefined || !day.value) return
	const items = day.value.items
	const known = new Set(items.map(entry => entry.id))
	const parentKey = (entry: Item) => entry.parent_id !== null && known.has(entry.parent_id) ? entry.parent_id : null
	const childrenOf = new Map<number | null, number[]>()
	for (const entry of items) {
		childrenOf.set(parentKey(entry), [...childrenOf.get(parentKey(entry)) ?? [], entry.id])
	}
	const siblings = childrenOf.get(parentKey(item)) ?? []
	const from = siblings.indexOf(item.id)
	const to = siblings.indexOf(neighbour)
	if (from < 0 || to < 0) return
	;[siblings[from], siblings[to]] = [siblings[to], siblings[from]]
	const order: number[] = []
	const seen = new Set<number>()
	const walk = (key: number | null): void => {
		for (const id of childrenOf.get(key) ?? []) {
			if (seen.has(id)) continue
			seen.add(id)
			order.push(id)
			walk(id)
		}
	}
	walk(null)
	for (const entry of items) {
		if (!seen.has(entry.id)) order.push(entry.id)
	}
	// Show the new order at once, then save it in the background.
	const byId = new Map(items.map(entry => [entry.id, entry]))
	day.value = { ...day.value, items: order.map(id => byId.get(id) as Item) }
	saveOrder(order)
	scrollToItem(item.id)
}

/** Finish moving (Enter, Esc or Done). After adding a task, focus returns to the add box for the next one. */
function endMove(): void {
	const was = movingId.value !== null
	movingId.value = null
	if (was && refocusAfterMove) focusSoon('.daily-todo__add input')
	refocusAfterMove = false
}

/** Open the move bubble under the cursor (or under the row when opened from the keyboard). */
function startMove(item: Item, event?: MouseEvent): void {
	refocusAfterMove = false
	draft.value = null
	renamingId.value = null
	postponingId.value = null
	placeBubble(item, event, 125, 64)
	movingId.value = item.id
}

/** Float a bubble (about 2 x `half` px wide and `height` px tall) under the cursor, or under the row for the keyboard, fully on screen. */
function placeBubble(item: Item, event: MouseEvent | undefined, half: number, height: number): void {
	half = Math.min(half, (window.innerWidth - 16) / 2)
	const rect = root.value?.querySelector(`[data-item-id="${item.id}"]`)?.getBoundingClientRect()
	const x = event && event.clientX > 0 ? event.clientX : (rect ? rect.left + rect.width / 2 : window.innerWidth / 2)
	const y = event && event.clientY > 0 ? event.clientY : (rect ? rect.bottom : window.innerHeight / 2)
	bubble.value = {
		x: Math.min(Math.max(x, half + 8), Math.max(half + 8, window.innerWidth - half - 8)),
		y: Math.max(12, Math.min(y + 14, window.innerHeight - height)),
	}
}

/**
 * While the move bubble is open, ↑ / ↓ move the item and Enter finishes. Registered in the capture
 * phase so the row menu's own key handling cannot take the arrows first, and ignored while you are
 * typing in a field.
 */
function onMoveKeys(event: KeyboardEvent): void {
	const item = movingItem.value
	if (!item) return
	const target = event.target as HTMLElement | null
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return
	if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
		event.preventDefault()
		event.stopPropagation()
		moveItem(item, event.key === 'ArrowUp' ? -1 : 1)
	} else if (event.key === 'Enter') {
		event.preventDefault()
		event.stopPropagation()
		endMove()
	}
}

function onPointerDown(event: Event): void {
	const target = event.target as Element | null
	if (postponingId.value !== null && !target?.closest?.('.daily-todo__postponer')) postponingId.value = null
	if (movingId.value === null) return
	// A click elsewhere ends the move without taking focus away from whatever was clicked.
	if (!target?.closest?.('.daily-todo__mover')) {
		movingId.value = null
		refocusAfterMove = false
	}
}

/** The tasks of earlier days still open, shown as a nudge on today's list of your own list. */
async function loadOverdue(): Promise<void> {
	const current = day.value
	if (!current || board.owner !== null || !current.editable || current.day !== current.logicalToday) {
		overdue.value = []
		return
	}
	try {
		overdue.value = await api.overdue()
	} catch {
		overdue.value = [] // a nudge, never an error
	}
}

async function moveOverdue(task: OverdueTask): Promise<void> {
	try {
		await mutate(() => api.moveOverdue(task.id))
		await load(true)
	} catch (reason) {
		showError(reason)
	}
}

/** A short message in the bar at the bottom, without Undo. */
function notice(message: string): void {
	clearTimeout(undoTimer)
	undo.value = { trash: null, message }
	undoTimer = setTimeout(() => { undo.value = null }, 6000)
}

/** The task editor saved: read the day again, and say where the task went if it left today. */
async function taskSaved(result: { title: string; moved: boolean; day: string | null }): Promise<void> {
	editingTaskId.value = null
	await load(true)
	if (result.moved) notice(result.day ? `"${result.title}" is now on ${dayLabel(result.day)}` : `"${result.title}" no longer has a date`)
}

function dayLabel(key: string): string {
	return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)))
		.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

function offerUndo(trash: number | undefined, message: string): void {
	clearTimeout(undoTimer)
	if (typeof trash !== 'number') return
	undo.value = { trash, message }
	undoTimer = setTimeout(() => { undo.value = null }, 8000)
}

async function undoLast(): Promise<void> {
	const last = undo.value
	if (!last || last.trash === null) return
	const trash = last.trash
	clearTimeout(undoTimer)
	undo.value = null
	try {
		await mutate(() => api.restore(trash))
		await load(true)
	} catch (reason) {
		showError(reason)
	}
}

async function remove(item: Item): Promise<void> {
	if (item.source_type === 'task') {
		deletingTask.value = item
		return
	}
	await deleteItem(item)
}

async function confirmTaskDelete(): Promise<void> {
	const item = deletingTask.value
	if (!item) return
	deletingTask.value = null
	await deleteItem(item)
}

const deleteButtons = [
	{ label: 'Cancel', variant: 'tertiary' as const },
	{ label: 'Delete from Tasks', variant: 'primary' as const, type: 'submit' as const, callback: () => false as const },
]

async function deleteItem(item: Item): Promise<void> {
	try {
		const result = await mutate(() => api.deleteQuick(item.id))
		await load(true)
		offerUndo(result?.trash, `Deleted "${item.title}"`)
	} catch (reason) {
		showError(reason)
	}
}

/**
 * Only today's items can be postponed: your own, and tasks (which move in Tasks too). A subtask
 * follows its parent and a finished task stays where it was done. The days ahead are not
 * created early, they receive the items when they start.
 */
function canPostpone(item: Item): boolean {
	if (!day.value?.editable || day.value.day !== day.value.logicalToday) return false
	if (isQuick(item)) return true
	return item.source_type === 'task' && item.parent_id === null && !item.completed
}

/** Open the calendar to choose the item's next planned day. */
function startPostpone(item: Item, event?: MouseEvent): void {
	refocusAfterMove = false
	movingId.value = null
	draft.value = null
	renamingId.value = null
	placeBubble(item, event, 168, 520)
	postponingId.value = item.id
}

function fitPostponeBubble(): void {
	const popup = document.querySelector('.daily-todo__postponer')
	if (popup) bubble.value.y = Math.max(12, Math.min(bubble.value.y, window.innerHeight - popup.getBoundingClientRect().height - 12))
}

function whenLabel(due: string | undefined, days: number): string {
	if (days === 1) return 'tomorrow'
	if (!due) return `in ${days} days`
	return new Date(Number(due.slice(0, 4)), Number(due.slice(5, 7)) - 1, Number(due.slice(8, 10)))
		.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

/** The item leaves today and comes back `days` days later (1 = tomorrow). */
async function postpone(item: Item, days: number): Promise<void> {
	postponingId.value = null
	if (!Number.isInteger(days) || days < 1 || days > 365) {
		showError(new Error('Choose between 1 and 365 days'))
		return
	}
	try {
		const result = await mutate(() => api.postpone(item.id, days))
		await load(true)
		offerUndo(result?.trash, `"${item.title}" comes back ${whenLabel(result?.due, days)}`)
	} catch (reason) {
		showError(reason)
	}
}

function itemTime(item: Item): string {
	if (item.all_day) return 'All day'
	if (!item.starts_at) return ''
	return new Date(item.starts_at * 1000).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
	})
}

function subname(item: Item, group: Group): string {
	const subtasks = group.item === item ? group.children : []
	const parts = [
		item.source_type.charAt(0).toUpperCase() + item.source_type.slice(1),
		itemTime(item),
		item.due_at ? `Due ${new Date(item.due_at * 1000).toLocaleString()}` : '',
		subtasks.length ? `${subtasks.filter(child => child.completed).length}/${subtasks.length} subtasks` : '',
	]
	return parts.filter(Boolean).join(' · ')
}

function showError(reason: unknown): void {
	error.value = reason instanceof Error ? reason.message : 'Something went wrong'
}

function onKeydown(event: KeyboardEvent): void {
	if (event.key !== 'Escape') return
	renamingId.value = null
	draft.value = null
	postponingId.value = null
	endMove()
}

onMounted(() => {
	load()
	window.addEventListener('keydown', onKeydown)
	document.addEventListener('visibilitychange', onVisibilityChange)
	document.addEventListener('pointerdown', onPointerDown, true)
	window.addEventListener('keydown', onMoveKeys, true)
	window.addEventListener('focus', refreshInBackground)
	window.addEventListener('resize', fitPostponeBubble)
	pollTimer = setInterval(refreshInBackground, POLL_MS)
})
onBeforeUnmount(() => {
	clearTimeout(undoTimer)
	window.removeEventListener('keydown', onKeydown)
	document.removeEventListener('visibilitychange', onVisibilityChange)
	document.removeEventListener('pointerdown', onPointerDown, true)
	window.removeEventListener('keydown', onMoveKeys, true)
	window.removeEventListener('focus', refreshInBackground)
	window.removeEventListener('resize', fitPostponeBubble)
	clearInterval(pollTimer)
	focusTimers.forEach(clearTimeout)
})
watch([() => dateKey(), () => board.owner], () => {
	draft.value = null
	renamingId.value = null
	movingId.value = null
	load()
})
</script>

<template>
	<div ref="root" class="daily-todo">
		<header class="daily-todo__header">
			<div class="daily-todo__title">
				<h2>{{ heading }}</h2>
				<span v-if="day" class="daily-todo__count">
					{{ completed }} of {{ checkable.length }} completed<template v-if="sharedBy"> · Shared by {{ sharedBy }}</template>
				</span>
			</div>
			<div class="daily-todo__nav">
				<NcButton variant="tertiary" aria-label="Previous day" @click="move(-1)">
					<template #icon><ArrowLeft :size="20" /></template>
				</NcButton>
				<NcButton variant="secondary" @click="goToday">
					Today
				</NcButton>
				<NcButton variant="tertiary" aria-label="Next day" @click="move(1)">
					<template #icon><ArrowRight :size="20" /></template>
				</NcButton>
			</div>
		</header>

		<NcNoteCard v-if="error" type="error">
			{{ error }}
		</NcNoteCard>

		<div v-if="loading" class="daily-todo__loading">
			<NcLoadingIcon :size="44" />
		</div>
		<template v-else-if="day">
			<NcProgressBar :value="progress" size="medium" />
			<NcNoteCard v-if="!day.editable" type="info">
				{{ day.future ? "This day hasn't started yet." : 'This historical day is read-only.' }}
			</NcNoteCard>

			<NcNoteCard v-if="overdue.length" type="warning" class="daily-todo__overdue">
				<button type="button" class="daily-todo__overdue-toggle" :aria-expanded="showOverdue" @click="showOverdue = !showOverdue">
					{{ overdue.length === 1 ? '1 task is overdue' : `${overdue.length} tasks are overdue` }} {{ showOverdue ? '▲' : '▼' }}
				</button>
				<ul v-if="showOverdue" class="daily-todo__overdue-list">
					<li v-for="task in overdue" :key="task.id">
						<span class="daily-todo__overdue-title">{{ task.title }}</span>
						<small>was due {{ dayLabel(task.date) }}</small>
						<NcButton variant="secondary" @click="moveOverdue(task)">
							Move to today
						</NcButton>
					</li>
				</ul>
			</NcNoteCard>

			<form v-if="day.editable" class="daily-todo__add" @submit.prevent="addQuick">
				<Plus :size="20" class="daily-todo__add-icon" aria-hidden="true" />
				<input
					v-model="quickTitle"
					class="daily-todo__add-input"
					type="text"
					placeholder="Add a task"
					aria-label="Add a task"
					autocomplete="off"
					enterkeyhint="done">
				<kbd v-if="quickTitle.trim()" class="daily-todo__add-hint">Enter</kbd>
			</form>

			<ul v-if="day.items.length" class="daily-todo__list">
				<li
					v-for="group in groups"
					:key="group.item.id"
					class="daily-todo__group">
					<div
						v-if="separatorKind(group.item.title)"
						class="daily-todo__sep"
						:class="`daily-todo__sep--${separatorKind(group.item.title)}`">
						<hr v-if="separatorKind(group.item.title) === 'rule'">
						<NcButton
							v-if="isQuick(group.item)"
							variant="tertiary"
							aria-label="Delete separator"
							@click="remove(group.item)">
							<template #icon><DeleteOutline :size="20" /></template>
						</NcButton>
					</div>
					<ul v-else class="daily-todo__sublist">
						<template v-for="item in rowsOf(group)" :key="item.id">
							<NcListItem
								:name="item.title"
								:class="{
									'daily-todo__item--done': item.completed,
									'daily-todo__item--child': item !== group.item,
									'daily-todo__item--moving': item.id === movingId,
								}"
								:style="{ '--depth': depthOf(item) }"
								:data-item-id="item.id"
								@click.prevent
								force-display-actions>
								<template #icon>
									<NcCheckboxRadioSwitch
										:model-value="item.completed"
										:disabled="!day.editable"
										:aria-label="`Mark ${item.title} as done`"
										type="checkbox"
										@click.stop
										@update:model-value="toggle(item)" />
								</template>
								<template v-if="canRename(item)" #name>
									<input
										v-if="renamingId === item.id"
										v-model="renameTitle"
										class="daily-todo__rename"
										aria-label="Title"
										@keydown.enter.prevent="renameAndContinue(item)"
										@keydown.esc="renamingId = null"
										@blur="onRenameBlur(item)"
										@click.stop>
									<span
										v-else
										class="daily-todo__title-text"
										@click.stop.prevent="startRename(item)">{{ item.title }}</span>
								</template>
								<template v-else-if="item.href" #name>
									<a :href="item.href" target="_blank" rel="noopener noreferrer" @click.stop>{{ item.title }}</a>
								</template>
								<template #subname>
									{{ subname(item, group) }}
								</template>
								<template v-if="hasActions(item)" #actions>
									<NcActionButton close-after-click v-if="canRename(item)" @click="startRename(item)">
										<template #icon><PencilOutline :size="20" /></template>
										{{ item.source_type === 'task' ? 'Edit' : 'Rename' }}
									</NcActionButton>
									<NcActionButton close-after-click v-if="item.parent_id === null" @click="openDraft('sub', item.id)">
										<template #icon><Plus :size="20" /></template>
										Add subtask
									</NcActionButton>
									<NcActionButton
										close-after-click
										v-if="neighbourOf(item, -1) !== undefined || neighbourOf(item, 1) !== undefined"
										@click="startMove(item, $event)">
										<template #icon><SwapVertical :size="20" /></template>
										Move
									</NcActionButton>
									<NcActionButton close-after-click v-if="canPostpone(item)" @click="startPostpone(item, $event)">
										<template #icon><CalendarArrowRight :size="20" /></template>
										Postpone
									</NcActionButton>
									<NcActionButton close-after-click v-if="isQuick(item) || item.source_type === 'task'" @click="remove(item)">
										<template #icon><DeleteOutline :size="20" /></template>
										Delete
									</NcActionButton>
								</template>
							</NcListItem>
							<li
								v-if="draftSlot(group)?.afterRowId === item.id"
								class="daily-todo__draft-row"
								:class="{ 'daily-todo__draft-row--sub': draftSlot(group)?.indented }">
								<input
									v-model="draftTitle"
									class="daily-todo__draft"
									placeholder="New item (Enter to add, Esc to stop)"
									aria-label="New item"
									@keydown.enter.prevent="commitDraft"
									@keydown.esc="draft = null">
							</li>
						</template>
					</ul>
				</li>
			</ul>
			<NcEmptyContent
				v-else
				name="Nothing planned yet"
				:description="day.editable ? 'Add a task above or enable sources in Settings.' : day.future ? 'A day is created when it starts.' : 'Nothing was recorded on this day.'">
				<template #icon><WeatherSunsetUp /></template>
			</NcEmptyContent>

			<NcCheckboxRadioSwitch v-if="completed" v-model="hideCompleted" type="switch">
				Hide completed items
			</NcCheckboxRadioSwitch>
		</template>

		<TaskDialog
			v-if="editingTaskId !== null"
			:item-id="editingTaskId"
			@close="editingTaskId = null"
			@saved="taskSaved" />

		<NcDialog
			v-if="deletingTask"
			:open="true"
			name="Delete task?"
			size="small"
			is-form
			:buttons="deleteButtons"
			@submit.prevent="confirmTaskDelete"
			@closing="deletingTask = null">
			<p>Delete “{{ deletingTask.title }}” and its subtasks from the Tasks app too? You can undo this deletion.</p>
		</NcDialog>

		<div v-if="undo" class="daily-todo__undo" role="status">
			<span>{{ undo.message }}</span>
			<NcButton v-if="undo.trash !== null" variant="tertiary" @click="undoLast">
				Undo
			</NcButton>
		</div>

		<Teleport to="body">
			<div
				v-if="postponingItem"
				class="daily-todo__mover daily-todo__postponer"
				role="dialog"
				:aria-label="`Postpone ${postponingItem.title}`"
				:style="{ left: `${bubble.x}px`, top: `${bubble.y}px` }">
				<PostponeCalendar
					:key="postponingItem.id"
					:item="postponingItem"
					:today="day!.logicalToday"
					@choose="postpone(postponingItem, $event)"
					@resize="fitPostponeBubble"
					@cancel="postponingId = null" />
			</div>
		</Teleport>

		<!-- Move bubble: stays where it opened, so ▲ and ▼ can be pressed again and again. -->
		<Teleport to="body">
			<div
				v-if="movingItem"
				class="daily-todo__mover"
				role="toolbar"
				:aria-label="`Move ${movingItem.title}`"
				:style="{ left: `${bubble.x}px`, top: `${bubble.y}px` }">
				<NcButton
					variant="tertiary"
					aria-label="Move up"
					:disabled="neighbourOf(movingItem, -1) === undefined"
					@click="moveItem(movingItem, -1)">
					<template #icon><ArrowUp :size="20" /></template>
				</NcButton>
				<NcButton variant="primary" @click="endMove">
					Done
				</NcButton>
				<NcButton
					variant="tertiary"
					aria-label="Move down"
					:disabled="neighbourOf(movingItem, 1) === undefined"
					@click="moveItem(movingItem, 1)">
					<template #icon><ArrowDown :size="20" /></template>
				</NcButton>
			</div>
		</Teleport>
	</div>
</template>

<style scoped>
.daily-todo { display: flex; flex-direction: column; gap: calc(var(--default-grid-baseline) * 3); padding: calc(var(--default-grid-baseline) * 4); padding-inline-start: calc(var(--default-clickable-area) + var(--default-grid-baseline) * 4); }
.daily-todo__header { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--default-grid-baseline) * 4); flex-wrap: wrap; }
.daily-todo__title h2 { margin: 0; font-size: 20px; font-weight: bold; }
.daily-todo__count { color: var(--color-text-maxcontrast); }
.daily-todo__nav { display: flex; align-items: center; gap: var(--default-grid-baseline); }
.daily-todo__loading { display: flex; justify-content: center; padding: calc(var(--default-grid-baseline) * 12); }
.daily-todo__list, .daily-todo__sublist { list-style: none; margin: 0; padding: 0; }
.daily-todo__item--done :deep(.line-one__name) { text-decoration: line-through; color: var(--color-text-maxcontrast); }
/* NcListItem sets its own padding on the <li>, so the selector has to be more specific than its rule. */
.daily-todo__sublist :deep(li.daily-todo__item--child) { box-sizing: border-box; padding-inline-start: calc(4px + var(--depth, 1) * var(--default-clickable-area)); }
.daily-todo__title-text { cursor: text; }
.daily-todo__sep { display: flex; align-items: center; gap: var(--default-grid-baseline); min-height: var(--default-clickable-area); }
.daily-todo__sep hr { flex: 1; margin: 0; border: 0; border-top: 1px solid var(--color-border-dark); }
.daily-todo__sep--space { min-height: calc(var(--default-grid-baseline) * 6); }
.daily-todo__draft-row { list-style: none; padding: 2px 4px; }
.daily-todo__draft-row--sub { padding-inline-start: calc(4px + var(--default-clickable-area)); }
.daily-todo__draft, .daily-todo__rename {
	width: 100%;
	box-sizing: border-box;
	min-height: var(--default-clickable-area);
	padding-inline: calc(var(--default-grid-baseline) * 3);
	border: 2px solid var(--color-primary-element);
	border-radius: var(--border-radius-element);
	background: var(--color-main-background);
	color: var(--color-main-text);
	font: inherit;
}
.daily-todo__rename { min-height: 0; padding-block: 2px; }
/* The item being moved is tinted with the accent colour so it is easy to follow. */
.daily-todo__sublist :deep(li.daily-todo__item--moving .list-item) { background: var(--color-primary-element-light); }
.daily-todo__overdue-toggle { all: unset; cursor: pointer; font-weight: bold; }
.daily-todo__overdue-toggle:focus-visible { outline: 2px solid var(--color-main-text); outline-offset: 2px; }
.daily-todo__overdue-list { list-style: none; margin: calc(var(--default-grid-baseline) * 2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--default-grid-baseline); }
.daily-todo__overdue-list li { display: flex; align-items: center; gap: calc(var(--default-grid-baseline) * 2); }
.daily-todo__overdue-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.daily-todo__undo {
	position: fixed;
	inset-inline: 0;
	bottom: calc(var(--default-grid-baseline) * 6);
	margin-inline: auto;
	width: max-content;
	max-width: calc(100vw - var(--default-grid-baseline) * 8);
	z-index: 2000;
	display: flex;
	align-items: center;
	gap: calc(var(--default-grid-baseline) * 2);
	padding: var(--default-grid-baseline) var(--default-grid-baseline) var(--default-grid-baseline) calc(var(--default-grid-baseline) * 4);
	background: var(--color-main-background);
	border: 1px solid var(--color-border-dark);
	border-radius: var(--border-radius-large);
	box-shadow: 0 2px 10px var(--color-box-shadow);
}
.daily-todo__mover {
	position: fixed;
	transform: translateX(-50%);
	z-index: 2000;
	display: flex;
	align-items: center;
	gap: var(--default-grid-baseline);
	padding: var(--default-grid-baseline);
	background: var(--color-main-background);
	border: 1px solid var(--color-border-dark);
	border-radius: var(--border-radius-large);
	box-shadow: 0 2px 10px var(--color-box-shadow);
}
.daily-todo__postponer { flex-direction: column; align-items: stretch; width: 336px; max-width: calc(100vw - 16px); max-height: calc(100dvh - 24px); overflow-y: auto; box-sizing: border-box; padding: calc(var(--default-grid-baseline) * 3); }
/*
 * The add field: a rounded row like the list rows around it, not a boxed form input. Plain input,
 * so Nextcloud's global input styles (border, height, margin) cannot fight the design.
 */
.daily-todo__add {
	display: flex;
	align-items: center;
	gap: calc(var(--default-grid-baseline) * 2);
	min-height: var(--default-clickable-area);
	margin-inline: 4px;
	padding-inline: calc(var(--default-grid-baseline) * 3);
	border-radius: var(--border-radius-element);
	background: var(--color-background-hover);
	color: var(--color-text-maxcontrast);
	transition: background-color var(--animation-quick) ease-in-out, box-shadow var(--animation-quick) ease-in-out;
}
.daily-todo__add:hover { background: var(--color-background-dark); }
.daily-todo__add:focus-within {
	background: var(--color-main-background);
	box-shadow: inset 0 0 0 2px var(--color-primary-element);
	color: var(--color-primary-element);
}
.daily-todo__add .daily-todo__add-input {
	flex: 1;
	min-width: 0;
	height: auto;
	min-height: var(--default-clickable-area);
	margin: 0;
	padding: 0;
	border: 0;
	border-radius: 0;
	outline: none;
	box-shadow: none;
	background: transparent;
	color: var(--color-main-text);
	font: inherit;
}
.daily-todo__add .daily-todo__add-input::placeholder { color: var(--color-text-maxcontrast); opacity: 1; }
.daily-todo__add-hint {
	padding: 0 calc(var(--default-grid-baseline) * 2);
	border: 1px solid var(--color-border-dark);
	border-radius: var(--border-radius-small, 6px);
	color: var(--color-text-maxcontrast);
	font: inherit;
	font-size: var(--font-size-small, 13px);
}
</style>
