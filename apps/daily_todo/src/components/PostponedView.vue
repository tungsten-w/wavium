<script setup lang="ts">
import { NcButton, NcEmptyContent, NcLoadingIcon, NcNoteCard } from '@nextcloud/vue'
import CalendarClock from 'vue-material-design-icons/CalendarClock.vue'
import { computed, onMounted, ref } from 'vue'
import { api, type TrashEntry } from '../api'

const emit = defineEmits<{ changed: [] }>()

const entries = ref<TrashEntry[]>([])
const loading = ref(true)
const error = ref('')
const notice = ref('')
const busy = ref<number | null>(null)

const postponed = computed(() => entries.value.filter(entry => entry.kind === 'postponed').sort((a, b) => (a.due ?? '').localeCompare(b.due ?? '')))
const deleted = computed(() => entries.value.filter(entry => entry.kind === 'deleted'))

async function load(): Promise<void> {
	try {
		entries.value = await api.trash()
	} catch (reason) {
		error.value = reason instanceof Error ? reason.message : 'Something went wrong'
	} finally {
		loading.value = false
	}
}

async function bringBack(entry: TrashEntry): Promise<void> {
	busy.value = entry.id
	error.value = ''
	notice.value = ''
	try {
		await api.restore(entry.id, true)
		notice.value = `"${entry.title}" is back on today's list.`
		emit('changed')
	} catch (reason) {
		error.value = reason instanceof Error ? reason.message : 'Something went wrong'
	} finally {
		busy.value = null
		await load()
	}
}

const parse = (key: string) => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)))
const dateLabel = (key: string | null) => key
	? parse(key).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
	: ''
/** "tomorrow", "in 5 days", counted from the local calendar day. */
function inDays(key: string | null): string {
	if (!key) return ''
	const today = new Date()
	const days = Math.round((parse(key).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000)
	if (days <= 0) return 'today'
	return days === 1 ? 'tomorrow' : `in ${days} days`
}
const withSubtasks = (entry: TrashEntry) => entry.count > 1 ? ` · with ${entry.count - 1} subtask${entry.count === 2 ? '' : 's'}` : ''
const deletedLabel = (entry: TrashEntry) => `Deleted ${new Date(entry.created_at * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`

onMounted(load)
</script>

<template>
	<div class="daily-todo daily-todo--postponed">
		<header class="daily-todo__header">
			<h2>Postponed</h2>
		</header>

		<NcNoteCard v-if="error" type="error">
			{{ error }}
		</NcNoteCard>
		<NcNoteCard v-if="notice" type="success">
			{{ notice }}
		</NcNoteCard>

		<div v-if="loading" class="daily-todo__loading">
			<NcLoadingIcon :size="44" />
		</div>
		<NcEmptyContent
			v-else-if="!entries.length"
			name="Nothing postponed"
			description="Items you postpone wait here until their day, and deleted ones stay for a week.">
			<template #icon><CalendarClock /></template>
		</NcEmptyContent>
		<template v-else>
			<section v-if="postponed.length" aria-label="Postponed">
				<h3>Coming back</h3>
				<ul class="daily-todo-later__list">
					<li v-for="entry in postponed" :key="entry.id" class="daily-todo-later__row">
						<div class="daily-todo-later__text">
							<strong>{{ entry.title }}</strong>
							<span>{{ dateLabel(entry.due) }} ({{ inDays(entry.due) }}){{ withSubtasks(entry) }}</span>
						</div>
						<NcButton variant="secondary" :disabled="busy === entry.id" @click="bringBack(entry)">
							Show today
						</NcButton>
					</li>
				</ul>
			</section>
			<section v-if="deleted.length" aria-label="Recently deleted">
				<h3>Recently deleted</h3>
				<ul class="daily-todo-later__list">
					<li v-for="entry in deleted" :key="entry.id" class="daily-todo-later__row">
						<div class="daily-todo-later__text">
							<strong>{{ entry.title }}</strong>
							<span>{{ deletedLabel(entry) }}{{ withSubtasks(entry) }}</span>
						</div>
						<NcButton variant="secondary" :disabled="busy === entry.id" @click="bringBack(entry)">
							Restore to today
						</NcButton>
					</li>
				</ul>
			</section>
		</template>
	</div>
</template>

<style scoped>
.daily-todo { display: flex; flex-direction: column; gap: calc(var(--default-grid-baseline) * 4); padding: calc(var(--default-grid-baseline) * 4); padding-inline-start: calc(var(--default-clickable-area) + var(--default-grid-baseline) * 4); }
.daily-todo__header h2 { margin: 0; font-size: 20px; font-weight: bold; }
.daily-todo__loading { display: flex; justify-content: center; padding: calc(var(--default-grid-baseline) * 8); }
h3 { margin: 0 0 calc(var(--default-grid-baseline) * 2); font-size: 16px; font-weight: bold; }
.daily-todo-later__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--default-grid-baseline); }
.daily-todo-later__row { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--default-grid-baseline) * 3); padding: calc(var(--default-grid-baseline) * 2) calc(var(--default-grid-baseline) * 3); background: var(--color-background-hover); border-radius: var(--border-radius-large); }
.daily-todo-later__text { display: flex; flex-direction: column; min-width: 0; }
.daily-todo-later__text strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.daily-todo-later__text span { color: var(--color-text-maxcontrast); }
</style>
