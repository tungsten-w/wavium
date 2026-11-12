<script setup lang="ts">
import { NcButton, NcLoadingIcon, NcNoteCard, NcTextField } from '@nextcloud/vue'
import ArrowDown from 'vue-material-design-icons/ArrowDown.vue'
import ArrowUp from 'vue-material-design-icons/ArrowUp.vue'
import DeleteOutline from 'vue-material-design-icons/DeleteOutline.vue'
import FormatIndentDecrease from 'vue-material-design-icons/FormatIndentDecrease.vue'
import FormatIndentIncrease from 'vue-material-design-icons/FormatIndentIncrease.vue'
import Plus from 'vue-material-design-icons/Plus.vue'
import { onMounted, ref } from 'vue'
import { api, separatorKind, type TemplateRow } from '../api'

type Row = TemplateRow & { key: number }

const PLACEHOLDER = '__DAY_ITEMS__'
const SUB_PREFIX = '↳ '

const rows = ref<Row[]>([])
const loading = ref(true)
const saving = ref(false)
const saved = ref(false)
const error = ref('')
let nextKey = 0

const withKey = (row: TemplateRow): Row => ({ ...row, key: nextKey++ })

onMounted(async () => {
	try {
		rows.value = (await api.template()).map(withKey)
	} catch (reason) {
		error.value = getMessage(reason)
	} finally {
		loading.value = false
	}
})

// Sub-items are stored as rows prefixed with "↳ " (a sub-item of the row above it).
const isSub = (row: Row) => /^\s*↳/.test(row.title)
const label = (row: Row) => row.title.replace(/^\s*↳\s*/, '')

function setLabel(row: Row, value: string): void {
	row.title = (isSub(row) ? SUB_PREFIX : '') + value
}

function toggleSub(row: Row): void {
	row.title = isSub(row) ? label(row) : SUB_PREFIX + label(row)
}

function insert(title: string): void {
	const placeholder = rows.value.findIndex(row => row.title === PLACEHOLDER)
	rows.value.splice(placeholder < 0 ? rows.value.length : placeholder, 0, withKey({ title }))
}

/** A top-level row moves together with the sub-items below it; a sub-item or "Day items" moves alone. */
function block(index: number): [number, number] {
	const row = rows.value[index]
	if (isSub(row) || row.title === PLACEHOLDER) return [index, index + 1]
	let end = index + 1
	while (end < rows.value.length && isSub(rows.value[end]) && rows.value[end].title !== PLACEHOLDER) end++
	return [index, end]
}

function canMove(index: number, direction: -1 | 1): boolean {
	return direction < 0 ? index > 0 : block(index)[1] < rows.value.length
}

function move(index: number, direction: -1 | 1): void {
	if (!canMove(index, direction)) return
	const [start, end] = block(index)
	if (direction < 0) {
		let target = start - 1
		if (!isSub(rows.value[start])) {
			while (target > 0 && isSub(rows.value[target])) target--
		}
		const moved = rows.value.splice(start, end - start)
		rows.value.splice(target, 0, ...moved)
	} else {
		const nextEnd = block(end)[1]
		const moved = rows.value.splice(start, end - start)
		rows.value.splice(nextEnd - moved.length, 0, ...moved)
	}
	saved.value = false
}

async function save(): Promise<void> {
	saving.value = true
	saved.value = false
	error.value = ''
	try {
		const payload = rows.value
			.filter(row => row.title === PLACEHOLDER || label(row).trim())
			.map(({ id, title }) => ({ id, title }))
		rows.value = (await api.saveTemplate(payload)).map(withKey)
		saved.value = true
	} catch (reason) {
		error.value = getMessage(reason)
	} finally {
		saving.value = false
	}
}

function getMessage(reason: unknown): string {
	return reason instanceof Error ? reason.message : 'Could not save the template'
}
</script>

<template>
	<div class="daily-todo">
		<header class="daily-todo__header">
			<div>
				<h2>Template</h2>
				<span class="daily-todo__hint">Rows above "Day items" are morning; rows below it are evening, so move "Day items" with the arrows to change where tasks and events go. A row named <code>---</code> is a divider and <code>&lt;br&gt;</code> a blank gap.</span>
			</div>
			<NcButton variant="primary" :disabled="saving" @click="save">
				Save changes
			</NcButton>
		</header>
		<NcNoteCard v-if="error" type="error">
			{{ error }}
		</NcNoteCard>
		<NcNoteCard v-if="saved" type="success">
			Template saved. New days use this order; today keeps its current order until you use "Regenerate current day" in Settings.
		</NcNoteCard>
		<div v-if="loading" class="daily-todo__loading">
			<NcLoadingIcon :size="44" />
		</div>
		<template v-else>
			<div
				v-for="(row, index) in rows"
				:key="row.key"
				class="daily-todo__row"
				:class="{
					'daily-todo__row--placeholder': row.title === PLACEHOLDER,
					'daily-todo__row--sub': isSub(row),
				}">
				<strong v-if="row.title === PLACEHOLDER">Day items</strong>
				<div v-else-if="separatorKind(label(row))" class="daily-todo__divider">
					<hr v-if="separatorKind(label(row)) === 'rule'">
					<span v-else>(blank gap)</span>
				</div>
				<NcTextField
					v-else
					:model-value="label(row)"
					label="Routine item"
					@update:model-value="setLabel(row, String($event))" />
				<NcButton
					variant="tertiary"
					aria-label="Move up"
					title="Move up"
					:disabled="!canMove(index, -1)"
					@click="move(index, -1)">
					<template #icon><ArrowUp :size="20" /></template>
				</NcButton>
				<NcButton
					variant="tertiary"
					aria-label="Move down"
					title="Move down"
					:disabled="!canMove(index, 1)"
					@click="move(index, 1)">
					<template #icon><ArrowDown :size="20" /></template>
				</NcButton>
				<NcButton
					v-if="row.title !== PLACEHOLDER && !separatorKind(label(row))"
					variant="tertiary"
					:aria-label="isSub(row) ? 'Make top-level item' : 'Make sub-item of the row above'"
					:title="isSub(row) ? 'Make top-level item' : 'Make sub-item of the row above'"
					@click="toggleSub(row)">
					<template #icon>
						<FormatIndentDecrease v-if="isSub(row)" :size="20" />
						<FormatIndentIncrease v-else :size="20" />
					</template>
				</NcButton>
				<NcButton
					v-if="row.title !== PLACEHOLDER"
					variant="tertiary"
					aria-label="Remove routine"
					title="Remove"
					@click="rows.splice(index, 1)">
					<template #icon><DeleteOutline :size="20" /></template>
				</NcButton>
			</div>
			<div class="daily-todo__buttons">
				<NcButton variant="secondary" @click="insert('')">
					<template #icon><Plus :size="20" /></template>
					Add routine
				</NcButton>
				<NcButton variant="tertiary" @click="insert('---')">
					Add divider
				</NcButton>
			</div>
		</template>
	</div>
</template>

<style scoped>
.daily-todo { display: flex; flex-direction: column; gap: calc(var(--default-grid-baseline) * 3); padding: calc(var(--default-grid-baseline) * 4); padding-inline-start: calc(var(--default-clickable-area) + var(--default-grid-baseline) * 4); }
.daily-todo__header { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--default-grid-baseline) * 4); flex-wrap: wrap; }
.daily-todo__header h2 { margin: 0; font-size: 20px; font-weight: bold; }
.daily-todo__hint { color: var(--color-text-maxcontrast); }
.daily-todo__loading { display: flex; justify-content: center; padding: calc(var(--default-grid-baseline) * 12); }
.daily-todo__row { display: flex; align-items: center; gap: var(--default-grid-baseline); }
.daily-todo__row > :first-child { flex: 1; }
.daily-todo__row--sub { padding-inline-start: calc(var(--default-clickable-area)); }
.daily-todo__row--placeholder { padding: var(--default-grid-baseline) calc(var(--default-grid-baseline) * 3); min-height: var(--default-clickable-area); border-radius: var(--border-radius-element); background: var(--color-background-dark); }
.daily-todo__divider { color: var(--color-text-maxcontrast); }
.daily-todo__divider hr { margin: 0; border: 0; border-top: 1px solid var(--color-border-dark); }
.daily-todo__buttons { display: flex; gap: var(--default-grid-baseline); }
</style>
