<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api } from '../api'
import { goTo } from '../navigate'
import { dateKeyOf, summarise, type DayCounts } from '../stats'
import DayCalendar from './DayCalendar.vue'

declare const OC: { generateUrl(path: string): string }

const app = (hash: string) => `${OC.generateUrl('/apps/daily_todo/')}#${hash}`

// The calendar highlights today; clicking a day opens that day in the app.
const today = ref(new Date())
const counts = ref<Record<string, DayCounts>>({})
const range = computed(() => {
	const end = new Date()
	const start = new Date()
	start.setDate(end.getDate() - 6)
	return { from: dateKeyOf(start), to: dateKeyOf(end) }
})
const stats = computed(() => summarise(counts.value, range.value.from, range.value.to))
/** One narrow weekday letter per bar (the last 7 days, oldest first). */
const weekdayLetters = computed(() => {
	const letters: string[] = []
	for (let back = 6; back >= 0; back--) {
		const date = new Date()
		date.setDate(date.getDate() - back)
		letters.push(date.toLocaleDateString(undefined, { weekday: 'narrow' }))
	}
	return letters
})
const percent = computed(() => stats.value.rate === null ? '–' : `${Math.round(stats.value.rate * 100)}%`)

// --- room for the calendar -----------------------------------------------------------------------
// The Dashboard gives a widget a fixed-height box on a wide screen and an automatic height on a
// narrow one. Where the height is fixed the calendar's squares shrink to fit it; where it is not,
// they are simply as wide as their column. Never anything that can make the calendar disappear.
const STATS_HEIGHT = 120 // the stats block (CSS: 30 * the grid baseline)
const root = ref<HTMLElement>()
const fitHeight = ref<number | undefined>()
let observer: ResizeObserver | undefined

function measure(): void {
	const element = root.value
	const box = element?.parentElement
	if (!element || !box) return
	// Ask the box how tall it is *without us in it*: 0 means its height depends on its content.
	const shown = element.style.display
	element.style.display = 'none'
	const available = box.clientHeight
	element.style.display = shown
	const room = available - 8 /* padding */ - 8 /* gap */ - STATS_HEIGHT
	fitHeight.value = available >= 200 && room > 120 ? room : undefined
}

onMounted(() => {
	measure()
	const box = root.value?.parentElement
	if (box && typeof ResizeObserver !== 'undefined') {
		observer = new ResizeObserver(measure)
		observer.observe(box)
	}
})
onBeforeUnmount(() => observer?.disconnect())

onMounted(async () => {
	try {
		counts.value = await api.stats(range.value.from, range.value.to)
	} catch {
		counts.value = {} // the calendar still works without the numbers
	}
})
</script>

<template>
	<div ref="root" class="daily-todo-widget">
		<DayCalendar
			class="daily-todo-widget__calendar"
			:model-value="today"
			:version="0"
			:fit-height="fitHeight"
			compact
			@update:model-value="date => goTo(app(`day/${dateKeyOf(date)}`))" />

		<!-- Always here, always the same height, at the bottom: the layout does not jump when the numbers arrive. -->
		<a v-if="stats.total" class="daily-todo-widget__stats" :href="app('stats')" aria-label="Last 7 days, open Stats">
			<div class="daily-todo-widget__numbers">
				<span><strong>{{ percent }}</strong> done</span>
				<span><strong>{{ stats.done }}/{{ stats.total }}</strong> items</span>
				<span><strong>{{ stats.complete }}/{{ stats.recorded }}</strong> full days</span>
			</div>
			<div class="daily-todo-widget__bars" role="img" aria-label="Completion over the last 7 days">
				<div v-for="(bucket, index) in stats.buckets" :key="index" class="daily-todo-widget__bar" :title="bucket.title">
					<div class="daily-todo-widget__track">
						<div v-if="bucket.rate !== null" class="daily-todo-widget__fill" :style="{ height: `${Math.max(bucket.rate * 100, 6)}%` }" />
					</div>
					<span>{{ weekdayLetters[index] }}</span>
				</div>
			</div>
		</a>
		<div v-else class="daily-todo-widget__stats daily-todo-widget__stats--empty">
			Last 7 days: nothing recorded yet
		</div>
	</div>
</template>

<style scoped>
.daily-todo-widget__calendar { flex: 0 0 auto; }
.daily-todo-widget { height: 100%; display: flex; flex-direction: column; gap: calc(var(--default-grid-baseline) * 2); padding: var(--default-grid-baseline) 0 var(--default-grid-baseline); box-sizing: border-box; }
/* Fixed height, pinned to the bottom of the widget (margin-top: auto): the calendar takes the rest. */
.daily-todo-widget__stats { flex: 0 0 auto; margin-top: auto; box-sizing: border-box; height: calc(var(--default-grid-baseline) * 30); overflow: hidden; display: flex; flex-direction: column; gap: var(--default-grid-baseline); padding: calc(var(--default-grid-baseline) * 2); border-radius: var(--border-radius-large); background: var(--color-background-hover); color: var(--color-main-text); text-decoration: none; }
.daily-todo-widget__stats--empty { align-items: center; justify-content: center; color: var(--color-text-maxcontrast); }
.daily-todo-widget__stats--empty:hover { background: var(--color-background-hover); }
.daily-todo-widget__stats:hover, .daily-todo-widget__stats:focus-visible { background: var(--color-background-dark); }
.daily-todo-widget__numbers { display: flex; flex-wrap: wrap; flex: 0 0 auto; flex-wrap: nowrap; white-space: nowrap; overflow: hidden; gap: 0 calc(var(--default-grid-baseline) * 3); color: var(--color-text-maxcontrast); font-size: var(--font-size-small, 13px); }
.daily-todo-widget__numbers strong { color: var(--color-main-text); }
.daily-todo-widget__bars { flex: 1 1 auto; min-height: 0; display: flex; align-items: stretch; gap: calc(var(--default-grid-baseline) / 2); }
.daily-todo-widget__bar { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 11px; line-height: 1; color: var(--color-text-maxcontrast); }
.daily-todo-widget__track { flex: 1 1 auto; min-height: 0; width: 100%; display: flex; align-items: flex-end; background: var(--color-background-dark); border-radius: var(--border-radius-small, 4px); overflow: hidden; }
.daily-todo-widget__fill { width: 100%; background: var(--color-primary-element); border-radius: var(--border-radius-small, 4px); }
</style>

<style>
/*
 * The Dashboard draws the header icon of a widget that renders itself from a CSS class (the image URL
 * is only used for list widgets). Its own rule gives the span its size and position; this adds the
 * picture, and the same dark-theme inversion the Dashboard applies to its other icons.
 */
.icon-daily-todo-calendar {
	background-image: url('../../img/app-dark.svg');
	background-repeat: no-repeat;
	background-size: 28px !important;
	filter: var(--background-invert-if-dark);
}
</style>
