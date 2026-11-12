<script setup lang="ts">
import { NcButton, NcEmptyContent, NcLoadingIcon, NcNoteCard } from '@nextcloud/vue'
import ChartBar from 'vue-material-design-icons/ChartBar.vue'
import { computed, onMounted, ref } from 'vue'
import { api } from '../api'
import { dateKeyOf, summarise, WEEKDAYS, type DayCounts } from '../stats'

type Range = { id: 'week' | 'month' | 'year'; label: string; days: number }
const ranges: Range[] = [
	{ id: 'week', label: '7 days', days: 7 },
	{ id: 'month', label: '30 days', days: 30 },
	{ id: 'year', label: '12 months', days: 365 },
]

const range = ref<Range>(ranges[1])
const loading = ref(true)
const error = ref('')
const counts = ref<Record<string, DayCounts>>({})
const bounds = ref({ from: '', to: '' })
// Only the latest request may show its answer, so quick clicks between ranges cannot mix up.
let requested = 0

async function load(): Promise<void> {
	const ticket = ++requested
	const end = new Date()
	const start = new Date()
	start.setDate(end.getDate() - (range.value.days - 1))
	const from = dateKeyOf(start)
	const to = dateKeyOf(end)
	loading.value = true
	error.value = ''
	try {
		const answer = await api.stats(from, to)
		if (ticket !== requested) return
		counts.value = answer
		bounds.value = { from, to }
	} catch (reason) {
		if (ticket !== requested) return
		error.value = reason instanceof Error ? reason.message : 'Something went wrong'
	} finally {
		if (ticket === requested) loading.value = false
	}
}

function pick(next: Range): void {
	range.value = next
	load()
}

onMounted(load)

const stats = computed(() => summarise(counts.value, bounds.value.from, bounds.value.to))
const percent = (rate: number | null): string => rate === null ? '–' : `${Math.round(rate * 100)}%`
const best = computed(() => {
	const rates = stats.value.weekdays
	const top = Math.max(...rates.map(rate => rate ?? -1))
	return top > 0 ? WEEKDAYS[rates.indexOf(top)] : null
})
</script>

<template>
	<div class="daily-todo daily-todo--stats">
		<header class="daily-todo__header">
			<h2>Stats</h2>
			<div class="daily-todo-stats__ranges" role="group" aria-label="Period">
				<NcButton
					v-for="entry in ranges"
					:key="entry.id"
					:variant="entry.id === range.id ? 'primary' : 'tertiary'"
					:aria-pressed="entry.id === range.id"
					@click="pick(entry)">
					{{ entry.label }}
				</NcButton>
			</div>
		</header>

		<NcNoteCard v-if="error" type="error">
			{{ error }}
		</NcNoteCard>
		<div v-if="loading" class="daily-todo__loading">
			<NcLoadingIcon :size="44" />
		</div>
		<NcEmptyContent
			v-else-if="!stats.recorded"
			name="Nothing recorded yet"
			description="Days are recorded as you use the list. Come back after a few days.">
			<template #icon><ChartBar /></template>
		</NcEmptyContent>
		<template v-else>
			<div class="daily-todo-stats__tiles">
				<div class="daily-todo-stats__tile">
					<strong>{{ percent(stats.rate) }}</strong>
					<span>done</span>
				</div>
				<div class="daily-todo-stats__tile">
					<strong>{{ stats.done }}<small>/{{ stats.total }}</small></strong>
					<span>items ticked</span>
				</div>
				<div class="daily-todo-stats__tile">
					<strong>{{ stats.complete }}<small>/{{ stats.recorded }}</small></strong>
					<span>days fully done</span>
				</div>
				<div v-if="best" class="daily-todo-stats__tile">
					<strong>{{ best }}</strong>
					<span>your best weekday</span>
				</div>
			</div>

			<section>
				<h3>{{ range.id === 'year' ? 'Per month' : 'Per day' }}</h3>
				<div class="daily-todo-stats__bars" :class="{ 'daily-todo-stats__bars--dense': stats.buckets.length > 14 }" role="img" :aria-label="`Completion over the last ${range.label}`">
					<div v-for="(bucket, index) in stats.buckets" :key="index" class="daily-todo-stats__bar" :title="bucket.title">
						<div class="daily-todo-stats__track">
							<div
								v-if="bucket.rate !== null"
								class="daily-todo-stats__fill"
								:style="{ height: `${Math.max(bucket.rate * 100, 3)}%` }" />
						</div>
						<span v-if="stats.buckets.length <= 14 || index % 5 === 0 || range.id === 'year'">{{ bucket.label }}</span>
					</div>
				</div>
			</section>

			<section>
				<h3>By weekday</h3>
				<div class="daily-todo-stats__bars" role="img" aria-label="Average completion per weekday">
					<div v-for="(rate, index) in stats.weekdays" :key="WEEKDAYS[index]" class="daily-todo-stats__bar" :title="`${WEEKDAYS[index]}: ${percent(rate)}`">
						<div class="daily-todo-stats__track">
							<div v-if="rate !== null" class="daily-todo-stats__fill" :style="{ height: `${Math.max(rate * 100, 3)}%` }" />
						</div>
						<span>{{ WEEKDAYS[index] }}</span>
					</div>
				</div>
			</section>
		</template>
	</div>
</template>

<style scoped>
.daily-todo { display: flex; flex-direction: column; gap: calc(var(--default-grid-baseline) * 4); padding: calc(var(--default-grid-baseline) * 4); padding-inline-start: calc(var(--default-clickable-area) + var(--default-grid-baseline) * 4); }
.daily-todo__header { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--default-grid-baseline) * 4); flex-wrap: wrap; }
.daily-todo__header h2 { margin: 0; font-size: 20px; font-weight: bold; }
.daily-todo__loading { display: flex; justify-content: center; padding: calc(var(--default-grid-baseline) * 8); }
h3 { margin: 0 0 calc(var(--default-grid-baseline) * 2); font-size: 16px; font-weight: bold; }
.daily-todo-stats__ranges { display: flex; gap: var(--default-grid-baseline); }
.daily-todo-stats__tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: calc(var(--default-grid-baseline) * 3); }
.daily-todo-stats__tile { display: flex; flex-direction: column; gap: var(--default-grid-baseline); padding: calc(var(--default-grid-baseline) * 4); background: var(--color-background-hover); border-radius: var(--border-radius-large); }
.daily-todo-stats__tile strong { font-size: 28px; line-height: 1.1; }
.daily-todo-stats__tile small { font-size: 16px; font-weight: normal; color: var(--color-text-maxcontrast); }
.daily-todo-stats__tile span { color: var(--color-text-maxcontrast); }
.daily-todo-stats__bars { display: flex; align-items: stretch; gap: calc(var(--default-grid-baseline) / 2); height: 160px; }
.daily-todo-stats__bars--dense { gap: 2px; }
.daily-todo-stats__bar { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: var(--default-grid-baseline); font-size: 12px; color: var(--color-text-maxcontrast); }
.daily-todo-stats__track { flex: 1 1 auto; width: 100%; display: flex; align-items: flex-end; background: var(--color-background-dark); border-radius: var(--border-radius-small, 4px); overflow: hidden; }
.daily-todo-stats__fill { width: 100%; background: var(--color-primary-element); border-radius: var(--border-radius-small, 4px); }
.daily-todo-stats__bar span { height: 1.2em; white-space: nowrap; }
</style>
