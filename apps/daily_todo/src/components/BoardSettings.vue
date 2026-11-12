<script setup lang="ts">
import {
	NcButton,
	NcCheckboxRadioSwitch,
	NcDialog,
	NcLoadingIcon,
	NcNoteCard,
	NcSelect,
	NcSettingsSection,
	NcTextField,
} from '@nextcloud/vue'
import DeleteOutline from 'vue-material-design-icons/DeleteOutline.vue'
import { computed, onMounted, ref } from 'vue'
import { api, type Settings, type Share, type Sources } from '../api'

const rolloverOptions = [
	{ id: 'quick_only', label: 'Quick items only' },
	{ id: 'all', label: 'Quick items and tasks' },
	{ id: 'none', label: 'Do not roll forward' },
] as const

const shareTypes = [
	{ id: 'user', label: 'A person' },
	{ id: 'group', label: 'A group' },
] as const

const settings = ref<Settings>()
const shares = ref<Share[]>([])
const shareType = ref<Share['share_type']>('user')
const shareWith = ref('')
const sharing = ref(false)
const shareTypeOption = computed(() => shareTypes.find(option => option.id === shareType.value) ?? null)
const sources = ref<Sources>({ tasks: [], calendars: [] })
const logicalToday = ref('')
const loading = ref(true)
const saving = ref(false)
const saved = ref(false)
const error = ref('')
const confirmingReset = ref(false)
const resetDone = ref(false)

onMounted(async () => {
	try {
		const today = new Date()
		const offset = today.getTimezoneOffset() * 60_000
		const civilDate = new Date(today.getTime() - offset).toISOString().slice(0, 10)
		const [loadedSettings, loadedSources, loadedDay, loadedShares] = await Promise.all([
			api.settings(),
			api.sources(),
			api.day(civilDate),
			api.shares(),
		])
		settings.value = loadedSettings
		shares.value = loadedShares
		sources.value = loadedSources
		logicalToday.value = loadedDay.logicalToday
	} catch (reason) {
		showError(reason)
	} finally {
		loading.value = false
	}
})

function toggleSource(kind: 'taskLists' | 'calendars', id: string): void {
	if (!settings.value) return
	const values = settings.value[kind]
	settings.value[kind] = values.includes(id)
		? values.filter(value => value !== id)
		: [...values, id]
}

function rolloverOption() {
	return rolloverOptions.find(option => option.id === settings.value?.rolloverMode) ?? null
}

function setRollover(option: { id: Settings['rolloverMode'] } | null): void {
	if (settings.value && option) settings.value.rolloverMode = option.id
}

function setRolloverHour(value: string | number): void {
	if (settings.value) settings.value.rolloverHour = Number(value)
}

async function save(): Promise<void> {
	if (!settings.value) return
	saving.value = true
	saved.value = false
	error.value = ''
	try {
		settings.value = await api.saveSettings(settings.value)
		saved.value = true
	} catch (reason) {
		showError(reason)
	} finally {
		saving.value = false
	}
}

function setShareType(option: { id: Share['share_type'] } | null): void {
	if (option) shareType.value = option.id
}

/** Sharing is applied at once; it is not part of "Save changes". */
async function addShare(): Promise<void> {
	const name = shareWith.value.trim()
	if (!name) return
	sharing.value = true
	error.value = ''
	try {
		await api.addShare(shareType.value, name)
		shareWith.value = ''
		shares.value = await api.shares()
	} catch (reason) {
		showError(reason)
	} finally {
		sharing.value = false
	}
}

async function removeShare(share: Share): Promise<void> {
	error.value = ''
	try {
		await api.deleteShare(share.id)
		shares.value = await api.shares()
	} catch (reason) {
		showError(reason)
	}
}

async function regenerate(): Promise<void> {
	confirmingReset.value = false
	try {
		await api.reset(logicalToday.value)
		resetDone.value = true
	} catch (reason) {
		showError(reason)
	}
}

function showError(reason: unknown): void {
	error.value = reason instanceof Error ? reason.message : 'Something went wrong'
}
</script>

<template>
	<div class="daily-todo">
		<NcNoteCard v-if="error" type="error">
			{{ error }}
		</NcNoteCard>
		<NcNoteCard v-if="saved" type="success">
			Settings saved.
		</NcNoteCard>
		<NcNoteCard v-if="resetDone" type="success">
			Today was regenerated.
		</NcNoteCard>
		<div v-if="loading" class="daily-todo__loading">
			<NcLoadingIcon :size="44" />
		</div>
		<template v-else-if="settings">
			<NcSettingsSection
				name="Day boundary"
				description="Before this local hour, Today is the preceding civil date.">
				<div class="daily-todo__fields">
					<NcTextField v-model="settings.timezone" label="Time zone" />
					<NcTextField
						:model-value="String(settings.rolloverHour)"
						type="number"
						min="0"
						max="23"
						label="Rollover hour"
						@update:model-value="setRolloverHour" />
					<NcSelect
						input-label="Unfinished items"
						:options="[...rolloverOptions]"
						:model-value="rolloverOption()"
						:clearable="false"
						@update:model-value="setRollover" />
				</div>
			</NcSettingsSection>

			<NcSettingsSection
				name="Subtasks"
				description="By default every subtask is ticked on its own. Turn this on to tick a task's subtasks together with it, like the Tasks app does. Un-ticking never changes the subtasks.">
				<NcCheckboxRadioSwitch v-model="settings.completeSubtasks" type="switch">
					Ticking a task also ticks its subtasks
				</NcCheckboxRadioSwitch>
			</NcSettingsSection>

			<NcSettingsSection name="Task lists" description="New lists stay disabled until selected.">
				<NcCheckboxRadioSwitch
					v-for="source in sources.tasks"
					:key="source.id"
					:model-value="settings.taskLists.includes(source.id)"
					type="checkbox"
					@update:model-value="toggleSource('taskLists', source.id)">
					{{ source.name }}
				</NcCheckboxRadioSwitch>
			</NcSettingsSection>

			<NcSettingsSection name="Calendars" description="Only selected calendars appear.">
				<NcCheckboxRadioSwitch
					v-for="source in sources.calendars"
					:key="source.id"
					:model-value="settings.calendars.includes(source.id)"
					type="checkbox"
					@update:model-value="toggleSource('calendars', source.id)">
					{{ source.name }}
				</NcCheckboxRadioSwitch>
			</NcSettingsSection>

			<div class="daily-todo__save">
				<NcButton variant="primary" :disabled="saving" @click="save">
					Save changes
				</NcButton>
			</div>

			<NcSettingsSection
				name="Sharing"
				description="People and groups you share your list with can see it and edit it: tick, add, rename and remove items. They cannot change your template, settings or sharing. They also see the tasks and events that appear on your list, even if those calendars and lists are not shared with them in Calendar or Tasks.">
				<ul v-if="shares.length" class="daily-todo__shares">
					<li v-for="share in shares" :key="share.id" class="daily-todo__share">
						<span>
							{{ share.display_name }}
							<small class="daily-todo__muted">{{ share.share_type === 'group' ? 'Group' : share.share_with }}</small>
						</span>
						<NcButton
							variant="tertiary"
							:aria-label="`Stop sharing with ${share.display_name}`"
							@click="removeShare(share)">
							<template #icon><DeleteOutline :size="20" /></template>
						</NcButton>
					</li>
				</ul>
				<p v-else class="daily-todo__muted">
					Not shared with anyone.
				</p>
				<form class="daily-todo__fields" @submit.prevent="addShare">
					<NcSelect
						input-label="Share with"
						:options="[...shareTypes]"
						:model-value="shareTypeOption"
						:clearable="false"
						@update:model-value="setShareType" />
					<NcTextField
						v-model="shareWith"
						:label="shareType === 'group' ? 'Group name' : 'Username'" />
					<div>
						<NcButton type="submit" variant="secondary" :disabled="!shareWith.trim() || sharing">
							Share
						</NcButton>
					</div>
				</form>
			</NcSettingsSection>

			<NcSettingsSection
				name="Regenerate today"
				description="Rebuild the current logical day from the template and enabled sources.">
				<NcButton variant="error" @click="confirmingReset = true">
					Regenerate current day
				</NcButton>
			</NcSettingsSection>
		</template>

		<NcDialog
			:open="confirmingReset"
			name="Regenerate today?"
			message="Local completion, ordering, and quick items added today will be removed. Unfinished carryover will be rebuilt according to your rollover setting. Tasks and Calendar data will not change."
			@update:open="confirmingReset = false">
			<template #actions>
				<NcButton variant="tertiary" @click="confirmingReset = false">
					Cancel
				</NcButton>
				<NcButton variant="error" @click="regenerate">
					Regenerate
				</NcButton>
			</template>
		</NcDialog>
	</div>
</template>

<style scoped>
.daily-todo { padding: calc(var(--default-grid-baseline) * 4); padding-inline-start: calc(var(--default-clickable-area) + var(--default-grid-baseline) * 4); }
.daily-todo__loading { display: flex; justify-content: center; padding: calc(var(--default-grid-baseline) * 12); }
.daily-todo__fields { display: flex; flex-direction: column; gap: calc(var(--default-grid-baseline) * 3); max-width: 400px; }
.daily-todo__shares { list-style: none; margin: 0 0 calc(var(--default-grid-baseline) * 3); padding: 0; max-width: 400px; }
.daily-todo__share { display: flex; align-items: center; justify-content: space-between; gap: var(--default-grid-baseline); min-height: var(--default-clickable-area); }
.daily-todo__muted { color: var(--color-text-maxcontrast); }
.daily-todo__save { padding: 0 calc(var(--default-grid-baseline) * 6) calc(var(--default-grid-baseline) * 4); }
</style>
