<script setup lang="ts">
import { NcButton, NcLoadingIcon, NcNoteCard } from '@nextcloud/vue'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { api, type Item, type TaskDetails } from '../api'

const props = defineProps<{ item: Item; today: string }>()
const emit = defineEmits<{ choose: [days: number]; cancel: []; resize: [] }>()
const root = ref<HTMLFormElement>()
const parse = (day: string) => new Date(`${day}T00:00:00Z`)
const key = (date: Date) => date.toISOString().slice(0, 10)
const shift = (day: string, days: number) => {
	const date = parse(day)
	date.setUTCDate(date.getUTCDate() + days)
	return key(date)
}
const format = (day: string) => parse(day).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
const selected = ref(shift(props.today, 1))
const month = ref(selected.value.slice(0, 7))
const task = ref<TaskDetails>()
const loading = ref(props.item.source_type === 'task')
const error = ref('')
const max = shift(props.today, 365)
const days = computed(() => Math.round((parse(selected.value).getTime() - parse(props.today).getTime()) / 86400000))
const available = computed(() => !loading.value && !error.value && !task.value?.repeating && days.value >= 1 && days.value <= 365)
const monthLabel = computed(() => parse(`${month.value}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }))
const weekdays = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 0, 5 + i)).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }))
const cells = computed(() => {
	const first = parse(`${month.value}-01`)
	const offset = (first.getUTCDay() + 6) % 7
	const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0))
	const count = Math.ceil((offset + next.getUTCDate()) / 7) * 7
	return Array.from({ length: count }, (_, i) => shift(key(first), i - offset))
})
// Read the actual VTODO dates: checklist timestamps omit all-day starts.
onMounted(async () => {
	if (loading.value) {
		try {
			task.value = await api.taskDetails(props.item.id)
		} catch (reason) {
			error.value = reason instanceof Error ? reason.message : 'Could not read task dates'
		} finally {
			loading.value = false
		}
	}
	await nextTick()
	root.value?.querySelector<HTMLButtonElement>(`[data-date="${selected.value}"]`)?.focus()
})
watch([loading, month, selected], async () => {
	await nextTick()
	emit('resize')
}, { immediate: true })
const preview = computed(() => {
	const source = task.value
	const placing = source?.start ?? source?.due
	if (!source || !placing) return null
	const delta = Math.round((parse(selected.value).getTime() - parse(placing).getTime()) / 86400000)
	return { start: source.start ? shift(source.start, delta) : null, due: source.due ? shift(source.due, delta) : null }
})
function inRange(day: string, range: { start: string | null; due: string | null } | undefined | null): boolean {
	const first = range?.start ?? range?.due
	const last = range?.due ?? range?.start
	return !!first && !!last && day >= first && day <= last
}
function changeMonth(delta: number): void {
	const date = parse(`${month.value}-01`)
	date.setUTCMonth(date.getUTCMonth() + delta)
	month.value = key(date).slice(0, 7)
}
</script>

<template>
	<form ref="root" class="postpone-calendar" @submit.prevent="available && emit('choose', days)">
		<strong>Postpone {{ item.title }}</strong>
		<NcLoadingIcon v-if="loading" :size="24" />
		<NcNoteCard v-if="error" type="error">{{ error }}</NcNoteCard>
		<NcNoteCard v-if="task?.repeating" type="warning">Change this repeating task’s dates in Tasks.</NcNoteCard>
		<div class="postpone-calendar__header">
			<NcButton type="button" aria-label="Previous month" variant="tertiary" :disabled="month <= today.slice(0, 7)" @click="changeMonth(-1)">‹</NcButton>
			<span aria-live="polite">{{ monthLabel }}</span>
			<NcButton type="button" aria-label="Next month" variant="tertiary" :disabled="month >= max.slice(0, 7)" @click="changeMonth(1)">›</NcButton>
		</div>
		<div class="postpone-calendar__grid">
			<span v-for="(label, index) in weekdays" :key="index" class="postpone-calendar__weekday">{{ label }}</span>
			<button v-for="day in cells" :key="day" type="button"
				:data-date="day" :aria-label="format(day)" :aria-pressed="selected === day"
				:disabled="day <= today || day > max || loading || !!error || task?.repeating"
				:class="{
					'postpone-calendar__outside': !day.startsWith(month),
					'postpone-calendar__current': inRange(day, task),
					'postpone-calendar__preview': inRange(day, preview),
					'postpone-calendar__selected': day === selected,
				}"
				:title="[day === task?.start ? 'Current start' : '', day === task?.due ? 'Current deadline' : '', day === preview?.start ? 'New start' : '', day === preview?.due ? 'New deadline' : ''].filter(Boolean).join(' · ')"
				@click="selected = day">{{ Number(day.slice(8)) }}</button>
		</div>
		<div v-if="task" class="postpone-calendar__dates">
			<p><span class="postpone-calendar__legend postpone-calendar__legend--current" />Current: {{ task.start ? `Start ${format(task.start)}` : 'No start date' }}{{ task.due ? ` · Deadline ${format(task.due)}` : ' · No deadline' }}</p>
			<p v-if="preview"><span class="postpone-calendar__legend postpone-calendar__legend--preview" />After postponing: {{ preview.start ? `Start ${format(preview.start)}` : 'No start date' }}{{ preview.due ? ` · Deadline ${format(preview.due)}` : ' · No deadline' }}</p>
			<p>Start is the planned day; due is the deadline. Postponing shifts both dates by the same amount.</p>
		</div>
		<p v-else-if="!loading">Show again on {{ format(selected) }}</p>
		<div class="postpone-calendar__actions">
			<NcButton type="button" variant="tertiary" @click="emit('cancel')">Cancel</NcButton>
			<NcButton type="submit" variant="primary" :disabled="!available">Postpone</NcButton>
		</div>
	</form>
</template>

<style scoped>
.postpone-calendar { display: flex; flex-direction: column; gap: calc(var(--default-grid-baseline) * 2); width: 100%; }
.postpone-calendar strong { overflow-wrap: anywhere; }
.postpone-calendar p { margin: 0; }
.postpone-calendar__header { display: flex; align-items: center; justify-content: space-between; }
.postpone-calendar__header span { font-weight: bold; }
.postpone-calendar__grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; }
.postpone-calendar__weekday { text-align: center; color: var(--color-text-maxcontrast); font-size: var(--font-size-small); }
.postpone-calendar__grid button { width: 100%; aspect-ratio: 1; min-height: 0; min-width: 0; padding: 0; margin: 0; border: 0; border-radius: var(--border-radius-element); background: transparent; color: var(--color-main-text); cursor: pointer; }
.postpone-calendar__grid button:hover { background: var(--color-background-hover); }
.postpone-calendar__grid button:focus-visible { outline: 2px solid var(--color-main-text); outline-offset: -2px; }
.postpone-calendar__grid button.postpone-calendar__outside { color: var(--color-text-maxcontrast); }
.postpone-calendar__grid button:disabled { cursor: default; opacity: .5; }
.postpone-calendar__grid button.postpone-calendar__current { box-shadow: inset 0 0 0 2px var(--color-text-maxcontrast); }
.postpone-calendar__grid button.postpone-calendar__preview { background: var(--color-primary-element-light); color: var(--color-primary-element-light-text); }
.postpone-calendar__grid button.postpone-calendar__selected { background: var(--color-primary-element); color: var(--color-primary-element-text); }
.postpone-calendar__dates { display: flex; flex-direction: column; gap: var(--default-grid-baseline); font-size: var(--font-size-small); }
.postpone-calendar__legend { display: inline-block; width: 10px; height: 10px; margin-inline-end: 4px; border-radius: 50%; }
.postpone-calendar__legend--current { border: 2px solid var(--color-text-maxcontrast); }
.postpone-calendar__legend--preview { background: var(--color-primary-element-light); border: 1px solid var(--color-primary-element); }
.postpone-calendar__actions { display: flex; justify-content: flex-end; gap: var(--default-grid-baseline); }
</style>
