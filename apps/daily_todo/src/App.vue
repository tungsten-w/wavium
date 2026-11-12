<script setup lang="ts">
import {
	NcAppContent,
	NcAppNavigation,
	NcAppNavigationCaption,
	NcAppNavigationItem,
	NcContent,
} from '@nextcloud/vue'
import AccountOutline from 'vue-material-design-icons/AccountOutline.vue'
import CalendarClock from 'vue-material-design-icons/CalendarClock.vue'
import ChartBar from 'vue-material-design-icons/ChartBar.vue'
import CalendarTodayOutline from 'vue-material-design-icons/CalendarTodayOutline.vue'
import CogOutline from 'vue-material-design-icons/CogOutline.vue'
import Refresh from 'vue-material-design-icons/Refresh.vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api, board, type SharedBoard } from './api'
import BoardSettings from './components/BoardSettings.vue'
import DayCalendar from './components/DayCalendar.vue'
import DayView from './components/DayView.vue'
import PostponedView from './components/PostponedView.vue'
import RoutineTemplate from './components/RoutineTemplate.vue'
import StatsView from './components/StatsView.vue'

type View = 'day' | 'template' | 'postponed' | 'stats' | 'settings'

const views: View[] = ['day', 'template', 'postponed', 'stats', 'settings']

/** `#postponed`, `#day`, or `#day/2026-10-03` (what a search result in Nextcloud's top bar opens). */
function fromHash(): View {
	const name = window.location.hash.slice(1).split('/')[0] as View
	return views.includes(name) ? name : 'day'
}

function dateFromHash(): Date | null {
	const match = /^#day\/(\d{4})-(\d{2})-(\d{2})$/.exec(window.location.hash)
	if (!match) return null
	const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
	return Number.isNaN(date.getTime()) ? null : date
}

const view = ref<View>(fromHash())
const selectedDate = ref(dateFromHash() ?? new Date())
// Bumped whenever the day changes, so the calendar re-reads completion.
const dayVersion = ref(0)
// Lists other people shared with you (they appear in the sidebar).
const shared = ref<SharedBoard[]>([])
const sharedBy = computed(() => shared.value.find(entry => entry.owner === board.owner)?.name)
onMounted(async () => {
	try {
		shared.value = await api.shared()
	} catch {
		shared.value = []
	}
})
const onHashChange = () => {
	view.value = fromHash()
	const date = dateFromHash()
	if (date) {
		board.owner = null
		selectedDate.value = date
	}
}
window.addEventListener('hashchange', onHashChange)
onBeforeUnmount(() => window.removeEventListener('hashchange', onHashChange))

function go(next: View): void {
	window.location.hash = next
}

/** Show your own list (null) or the list of someone who shared theirs with you. */
function openBoard(owner: string | null): void {
	board.owner = owner
	selectedDate.value = new Date()
	go('day')
}

/** Template, Postponed, Stats and Settings always belong to your own list. */
function openOwn(next: View): void {
	board.owner = null
	go(next)
}

function pickDate(date: Date): void {
	selectedDate.value = date
	go('day')
}
</script>

<template>
	<NcContent app-name="daily_todo">
		<NcAppNavigation aria-label="Daily Todo">
			<template #list>
				<NcAppNavigationItem
					name="Today"
					href="#day"
					:active="view === 'day' && board.owner === null"
					@click.prevent="openBoard(null)">
					<template #icon>
						<CalendarTodayOutline :size="20" />
					</template>
				</NcAppNavigationItem>
				<NcAppNavigationItem
					name="Template"
					href="#template"
					:active="view === 'template'"
					@click.prevent="openOwn('template')">
					<template #icon>
						<Refresh :size="20" />
					</template>
				</NcAppNavigationItem>
				<NcAppNavigationItem
					name="Postponed"
					href="#postponed"
					:active="view === 'postponed'"
					@click.prevent="openOwn('postponed')">
					<template #icon>
						<CalendarClock :size="20" />
					</template>
				</NcAppNavigationItem>
				<NcAppNavigationItem
					name="Stats"
					href="#stats"
					:active="view === 'stats'"
					@click.prevent="openOwn('stats')">
					<template #icon>
						<ChartBar :size="20" />
					</template>
				</NcAppNavigationItem>
				<NcAppNavigationCaption v-if="shared.length" name="Shared with you" />
				<NcAppNavigationItem
					v-for="entry in shared"
					:key="entry.owner"
					:name="entry.name"
					href="#day"
					:active="view === 'day' && board.owner === entry.owner"
					@click.prevent="openBoard(entry.owner)">
					<template #icon>
						<AccountOutline :size="20" />
					</template>
				</NcAppNavigationItem>
			</template>
			<template #footer>
				<div class="daily-todo-nav__calendar">
					<DayCalendar
						:model-value="selectedDate"
						:version="dayVersion"
						@update:model-value="pickDate" />
				</div>
				<ul class="daily-todo-nav__footer">
					<NcAppNavigationItem
						name="Settings"
						href="#settings"
						:active="view === 'settings'"
						@click.prevent="openOwn('settings')">
						<template #icon>
							<CogOutline :size="20" />
						</template>
					</NcAppNavigationItem>
				</ul>
			</template>
		</NcAppNavigation>

		<NcAppContent>
			<DayView
				v-if="view === 'day'"
				v-model:date="selectedDate"
				:shared-by="sharedBy"
				@changed="dayVersion++" />
			<RoutineTemplate v-else-if="view === 'template'" />
			<PostponedView v-else-if="view === 'postponed'" @changed="dayVersion++" />
			<StatsView v-else-if="view === 'stats'" />
			<BoardSettings v-else />
		</NcAppContent>
	</NcContent>
</template>

<style scoped>
/* Some room from the sidebar edge. No height limit and no scrolling: the calendar takes the room it needs. */
.daily-todo-nav__calendar {
	padding: calc(var(--default-grid-baseline) * 3);
	flex: 0 0 auto;
}
.daily-todo-nav__footer { list-style: none; margin: 0; padding: var(--app-navigation-padding, calc(var(--default-grid-baseline) * 2)); }
</style>

<style>
/* Every page (Today, Stats, Template, Settings, ...) is centred and never wider than this, however big the window is. */
.daily-todo {
	box-sizing: border-box;
	width: 100%;
	max-width: 960px;
	margin-inline: auto;
}

/*
 * Popovers (the row menus) are teleported to <body> and sit at the page's top-left until
 * floating-vue has computed their position, which it marks with data-popper-placement.
 * Keep them invisible until then so they never flash in the corner.
 */
.v-popper__popper:not([data-popper-placement]) { opacity: 0 !important; }

/*
 * A thin scrollbar in the theme's colour for the navigation list, instead of the browser
 * default (its body is overflow-y: scroll and would always show a track).
 */
/*
 * The navigation styles every direct <ul> child as a scroll area. The footer is not one, and
 * it must keep its natural height so that only the list above it gives way in a short window.
 */
nav.app-navigation__content > ul.daily-todo-nav__footer {
	overflow: visible;
	flex: 0 0 auto;
}

.app-navigation__body {
	scrollbar-width: thin;
	scrollbar-color: var(--color-scrollbar) transparent;
}
</style>
