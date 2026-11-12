<script setup lang="ts">
import NcButton from '@nextcloud/vue/components/NcButton'
import ChevronLeft from 'vue-material-design-icons/ChevronLeft.vue'
import ChevronRight from 'vue-material-design-icons/ChevronRight.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../api'

declare const OC: { getFirstDay?(): number } | undefined

type Cell = {
	date: Date
	key: string
	inMonth: boolean
	created: boolean
	fill: number
	label: string
}

/**
 * `compact` is for the Dashboard widget: the last week row is left out when it would only show days
 * of the next month. `fitHeight` (px, optional) is the height the whole calendar may use: the
 * squares then shrink so every week row fits. The sidebar keeps its six rows of square cells.
 */
const props = defineProps<{ modelValue: Date; version: number; compact?: boolean; fitHeight?: number }>()
const emit = defineEmits<{ 'update:modelValue': [Date] }>()

const startOfMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1)
const keyOf = (date: Date) => {
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${date.getFullYear()}-${month}-${day}`
}

const shown = ref(startOfMonth(props.modelValue))
const summary = ref<Record<string, { total: number; done: number }>>({})
const firstDay = (typeof OC !== 'undefined' && OC?.getFirstDay?.()) || 1
const todayKey = computed(() => keyOf(new Date()))
const selectedKey = computed(() => keyOf(props.modelValue))

const title = computed(() => shown.value.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))
const weekdays = computed(() => Array.from({ length: 7 }, (_, index) => {
	// 2024-01-07 was a Sunday.
	const date = new Date(2024, 0, 7 + ((firstDay + index) % 7))
	return date.toLocaleDateString(undefined, { weekday: 'narrow' })
}))

const weeks = computed(() => {
	const first = shown.value
	const lead = (first.getDay() - firstDay + 7) % 7
	const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
	return props.compact ? Math.ceil((lead + daysInMonth) / 7) : 6
})

/** Compact only: the largest square (px) that lets every week row fit in `fitHeight`; never below 24. */
const maxCell = computed(() => {
	if (!props.compact || !props.fitHeight) return undefined
	// header (a 44px button) + weekday row (20px) + a 4px gap after each of those rows
	return Math.max(24, Math.floor((props.fitHeight - 44 - 20 - weeks.value * 4) / weeks.value))
})

const cells = computed<Cell[]>(() => {
	const first = shown.value
	const lead = (first.getDay() - firstDay + 7) % 7
	return Array.from({ length: weeks.value * 7 }, (_, index) => {
		const date = new Date(first.getFullYear(), first.getMonth(), 1 - lead + index)
		const key = keyOf(date)
		const inMonth = date.getMonth() === first.getMonth()
		const stats = inMonth ? summary.value[key] : undefined
		const fill = stats && stats.total ? stats.done / stats.total : 0
		const when = date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
		const detail = stats
			? `${stats.done} of ${stats.total} done`
			: 'not created yet'
		return { date, key, inMonth, created: !!stats, fill, label: `${when}, ${detail}` }
	})
})

async function load(): Promise<void> {
	const month = keyOf(shown.value).slice(0, 7)
	try {
		const result = await api.summary(month)
		// Ignore a slow answer for a month that is no longer shown.
		if (month === keyOf(shown.value).slice(0, 7)) summary.value = result
	} catch {
		summary.value = {}
	}
}

function choose(date: Date): void {
	emit('update:modelValue', date)
}

function shift(months: number): void {
	shown.value = new Date(shown.value.getFullYear(), shown.value.getMonth() + months, 1)
}

watch(shown, load)
watch(() => props.version, load)
watch(() => props.modelValue, (value) => {
	if (value.getFullYear() !== shown.value.getFullYear() || value.getMonth() !== shown.value.getMonth()) {
		shown.value = startOfMonth(value)
	}
})
onMounted(load)
</script>

<template>
	<div class="day-calendar" :class="{ 'day-calendar--compact': compact }">
		<div class="day-calendar__header">
			<NcButton variant="tertiary" aria-label="Previous month" @click="shift(-1)">
				<template #icon><ChevronLeft :size="20" /></template>
			</NcButton>
			<strong>{{ title }}</strong>
			<NcButton variant="tertiary" aria-label="Next month" @click="shift(1)">
				<template #icon><ChevronRight :size="20" /></template>
			</NcButton>
		</div>
		<div class="day-calendar__grid" role="grid" :style="{ '--max-cell': maxCell ? `${maxCell}px` : undefined }">
			<span v-for="(name, index) in weekdays" :key="`w${index}`" class="day-calendar__weekday">{{ name }}</span>
			<button
				v-for="cell in cells"
				:key="cell.key"
				type="button"
				class="day-calendar__day"
				:class="{
					'day-calendar__day--outside': !cell.inMonth,
					// Grayed exactly when the day has not been created; a created day never is.
					'day-calendar__day--ungenerated': cell.inMonth && !cell.created,
					'day-calendar__day--tinted': cell.fill > 0,
					'day-calendar__day--strong': cell.fill >= 0.55,
					'day-calendar__day--today': cell.key === todayKey,
					'day-calendar__day--selected': cell.key === selectedKey,
				}"
				:style="{ '--fill': `${Math.round(cell.fill * 100)}%` }"
				:aria-label="cell.label"
				:aria-pressed="cell.key === selectedKey"
				@click="choose(cell.date)">
				{{ cell.date.getDate() }}
			</button>
		</div>
	</div>
</template>

<style scoped>
/*
 * Only theme tokens, so the calendar follows the user's accent colour and corner rounding
 * (--border-radius-element is a pill by default and square-ish when the admin chooses so).
 */
.day-calendar__header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--default-grid-baseline); }
.day-calendar__header strong { color: var(--color-main-text); }
.day-calendar__grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: var(--default-grid-baseline); }
.day-calendar__weekday { text-align: center; color: var(--color-text-maxcontrast); font-size: var(--font-size-small, 13px); padding-block: var(--default-grid-baseline); }
.day-calendar__day {
	aspect-ratio: 1;
	min-height: 0;
	padding: 0;
	border: 0;
	border-radius: var(--border-radius-element);
	/* More completed items = more of the accent colour; 0% is the plain background. */
	background: color-mix(in srgb, var(--color-primary-element) var(--fill, 0%), var(--color-main-background));
	color: var(--color-main-text);
	font: inherit;
	font-size: var(--default-font-size);
	cursor: pointer;
	transition: background-color var(--animation-quick) ease-in-out;
}
/* Same hover as Nextcloud's own date picker; a tinted day keeps its tint. */
.day-calendar__day { outline: none; }
.day-calendar__day:hover:not(.day-calendar__day--tinted) {
	background: var(--color-primary-element-light-hover);
	color: var(--color-primary-element-light-text);
}
/*
 * Compact (the Dashboard widget). Days stay perfect squares, as wide as their column, but never
 * larger than `--max-cell` (set from `fitHeight`), so a 6-week month gets smaller squares instead of
 * overflowing. Nothing here depends on the parent's height: without a `fitHeight` the squares are
 * simply as wide as their column, so the calendar can never collapse or disappear.
 */
.day-calendar--compact .day-calendar__header { margin-bottom: 0; }
.day-calendar--compact .day-calendar__weekday { height: 20px; padding-block: 0; display: flex; align-items: center; justify-content: center; }
.day-calendar--compact .day-calendar__grid { grid-template-columns: repeat(7, minmax(0, 1fr)); }
.day-calendar--compact .day-calendar__day { width: 100%; max-width: var(--max-cell, none); justify-self: center; }
.day-calendar__day--strong { color: var(--color-primary-element-text); }
.day-calendar__day--ungenerated { color: var(--color-text-maxcontrast); opacity: .55; }
.day-calendar__day--outside { color: var(--color-text-maxcontrast); opacity: .3; background: transparent; }
/*
 * Rings are drawn inside the cell (inset shadows), so they share the cell's rounding exactly and can
 * never poke out towards the edge of the sidebar. Today: accent ring. Selected: text-colour ring.
 */
.day-calendar__day--today { font-weight: bold; box-shadow: inset 0 0 0 2px var(--color-primary-element); }
.day-calendar__day--selected { box-shadow: inset 0 0 0 2px var(--color-main-text); }
.day-calendar__day--selected.day-calendar__day--today { box-shadow: inset 0 0 0 2px var(--color-main-text), inset 0 0 0 4px var(--color-primary-element); }
/* Keyboard focus: the same inside ring, a little thicker. */
.day-calendar__day:focus-visible { outline: none; box-shadow: inset 0 0 0 3px var(--color-main-text); }
</style>
