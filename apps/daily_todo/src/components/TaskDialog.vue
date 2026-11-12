<script setup lang="ts">
import { NcDialog, NcLoadingIcon, NcNoteCard, NcTextArea, NcTextField } from '@nextcloud/vue'
import { computed, onMounted, ref } from 'vue'
import { api } from '../api'

const props = defineProps<{ itemId: number }>()
const emit = defineEmits<{
	close: []
	saved: [result: { title: string; moved: boolean; day: string | null }]
}>()

const open = ref(true)
const loading = ref(true)
// The task could not be read (deleted in Tasks, say): show why, and nothing to save.
const unreadable = ref(false)
const saving = ref(false)
const error = ref('')
const repeating = ref(false)
const title = ref('')
const description = ref('')
const start = ref('')
const due = ref('')
const priority = ref('0')

/** Tasks' own priorities: 1 is the highest, 9 the lowest, 0 none. */
const priorities = [
	{ value: '0', label: 'None' },
	{ value: '1', label: 'High' },
	{ value: '5', label: 'Medium' },
	{ value: '9', label: 'Low' },
]
const datesInOrder = computed(() => !start.value || !due.value || due.value >= start.value)

onMounted(async () => {
	try {
		const task = await api.taskDetails(props.itemId)
		title.value = task.title
		description.value = task.description
		start.value = task.start ?? ''
		due.value = task.due ?? ''
		// A task with an unusual priority (say 3) keeps it in the list instead of silently changing it.
		priority.value = String(task.priority)
		if (!priorities.some(entry => entry.value === priority.value)) {
			priorities.push({ value: priority.value, label: `Priority ${priority.value}` })
		}
		repeating.value = task.repeating
	} catch (reason) {
		unreadable.value = true
		error.value = reason instanceof Error ? reason.message : 'Something went wrong'
	} finally {
		loading.value = false
	}
})

async function save(): Promise<void> {
	if (saving.value || loading.value || unreadable.value) return
	if (!title.value.trim()) {
		error.value = 'A title is required'
		return
	}
	if (!datesInOrder.value) {
		error.value = 'The due date cannot be before the start date'
		return
	}
	saving.value = true
	error.value = ''
	try {
		const result = await api.editTask(props.itemId, {
			title: title.value.trim(),
			description: description.value,
			start: start.value || null,
			due: due.value || null,
			priority: Number(priority.value),
		})
		open.value = false
		emit('saved', result)
	} catch (reason) {
		error.value = reason instanceof Error ? reason.message : 'Something went wrong'
	} finally {
		saving.value = false
	}
}

const buttons = computed(() => [
	{ label: 'Cancel', variant: 'tertiary' as const },
	{ label: 'Save', variant: 'primary' as const, type: 'submit' as const, disabled: loading.value || saving.value || unreadable.value, callback: () => false as const },
])
</script>

<template>
	<NcDialog
		v-model:open="open"
		name="Edit task"
		size="normal"
		is-form
		:buttons="buttons"
		@submit.prevent="save"
		@closing="emit('close')">
		<div class="daily-todo-task">
			<div v-if="loading" class="daily-todo-task__loading">
				<NcLoadingIcon :size="32" />
			</div>
			<template v-else>
				<NcNoteCard v-if="error" type="error">
					{{ error }}
				</NcNoteCard>
				<template v-if="!unreadable">
					<NcTextField v-model="title" label="Title" />
					<NcTextArea v-model="description" label="Notes" rows="4" />
					<div class="daily-todo-task__row">
						<label>
							<span>Start (planned day)</span>
							<input v-model="start" type="date" :disabled="repeating" aria-label="Start date">
						</label>
						<label>
							<span>Due (deadline)</span>
							<input v-model="due" type="date" :min="start || undefined" :disabled="repeating" aria-label="Due date">
						</label>
						<label>
							<span>Priority</span>
							<select v-model="priority" aria-label="Priority">
								<option v-for="entry in priorities" :key="entry.value" :value="entry.value">{{ entry.label }}</option>
							</select>
						</label>
					</div>
					<p v-if="repeating" class="daily-todo-task__hint">
						This task repeats, so its dates can only be changed in Tasks.
					</p>
					<p v-else class="daily-todo-task__hint">
						Start is the day you plan to do this task. Due is its deadline. Without a start, the due date places it on your list. Both are saved in Tasks.
					</p>
				</template>
			</template>
		</div>
	</NcDialog>
</template>

<style scoped>
.daily-todo-task { display: flex; flex-direction: column; gap: calc(var(--default-grid-baseline) * 3); min-width: min(480px, 100%); padding-bottom: calc(var(--default-grid-baseline) * 2); }
.daily-todo-task__loading { display: flex; justify-content: center; padding: calc(var(--default-grid-baseline) * 6); }
.daily-todo-task__row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: calc(var(--default-grid-baseline) * 3); }
.daily-todo-task__row label { display: flex; flex-direction: column; gap: var(--default-grid-baseline); }
.daily-todo-task__row input, .daily-todo-task__row select { width: 100%; margin: 0; }
.daily-todo-task__hint { margin: 0; color: var(--color-text-maxcontrast); }
</style>
