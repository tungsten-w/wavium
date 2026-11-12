import { createApp } from 'vue'
import DashboardCalendar from './components/DashboardCalendar.vue'

declare global {
	interface Window {
		OCA?: { Dashboard?: { register(id: string, render: (element: HTMLElement) => void): void } }
	}
}

// The Dashboard calls this for every place the widget is shown.
window.OCA?.Dashboard?.register('daily_todo_calendar', (element) => {
	createApp(DashboardCalendar).mount(element)
})
