// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Daily Todo JSON API (apps/daily_todo/appinfo/routes.php), for the React UI.
// Same calls as src/api.ts (the classic Vue UI), over the Atrium SDK.
import { request } from '@atrium/sdk'

export type Item = { id: number, source_type: 'task' | 'event' | 'routine' | 'quick', title: string, starts_at: number | null, due_at: number | null, all_day: boolean, completed: boolean, href: string | null, error: string | null, parent_id: number | null }
export type Day = { day: string, logicalToday: string, editable: boolean, future: boolean, isOwner: boolean, items: Item[], version: string, completeSubtasks: boolean }
export type Settings = { timezone: string, rolloverHour: number, rolloverMode: 'quick_only' | 'all' | 'none', completeSubtasks: boolean, taskLists: string[], calendars: string[], publicItems: string[], owner: string, isOwner: boolean }
export type Source = { id: string, name: string }
export type Sources = { tasks: Source[], calendars: Source[] }
export type TemplateRow = { id?: number, title: string }
export type Share = { id: number, share_type: 'user' | 'group', share_with: string, display_name: string }
export type SharedBoard = { owner: string, name: string }
export type TaskDetails = { title: string, description: string, start: string | null, due: string | null, priority: number, repeating: boolean }
export type TaskEdit = Omit<TaskDetails, 'repeating'>
export type OverdueTask = { id: string, title: string, date: string }
export type TrashEntry = { id: number, kind: 'postponed' | 'deleted', title: string, count: number, day: string, due: string | null, created_at: number }
export type Counts = Record<string, { total: number, done: number }>

/** Rows titled `---` are divider lines and `<br>` rows are blank gaps (mirrors EntryTree::separator). */
export function separatorKind(title: string): 'rule' | 'space' | null {
	switch (title.trim().toLowerCase()) {
	case '---': case '___': return 'rule'
	case '<br>': case '<br/>': case '<br />': return 'space'
	default: return null
	}
}

const base = '/apps/daily_todo'
/** Day calls carry the owner when a shared list is open; settings, template and sharing never do. */
const scoped = (path: string, owner: string | null) => owner ? `${path}${path.includes('?') ? '&' : '?'}owner=${encodeURIComponent(owner)}` : path
const get = <T>(path: string) => request<T>(base + path)
const send = <T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => request<T>(base + path, { method, body: body ?? (method === 'DELETE' ? undefined : {}) })

export const api = {
	day: (date: string, owner: string | null) => get<Day>(scoped(`/api/day/${date}`, owner)),
	/** Tiny "has the day changed?" check: compare with `Day.version`. */
	dayVersion: (date: string, owner: string | null) => get<{ version: string }>(scoped(`/api/day/${date}/version`, owner)),
	summary: (month: string, owner: string | null) => get<Counts>(scoped(`/api/summary/${month}`, owner)),
	reorder: (date: string, ids: number[], owner: string | null) => send('PUT', scoped(`/api/day/${date}/order`, owner), { ids }),
	complete: (id: number, completed: boolean) => send('PUT', `/api/items/${id}/complete`, { completed }),
	createQuick: (date: string, title: string, owner: string | null, parentId?: number, afterId?: number) => send<{ id: number }>('POST', scoped(`/api/day/${date}/quick`, owner), { title, parentId, afterId }),
	renameQuick: (id: number, title: string) => send('PUT', `/api/items/${id}`, { title }),
	deleteQuick: (id: number) => send<{ trash: number }>('DELETE', `/api/items/${id}`),
	postpone: (id: number, days: number) => send<{ trash: number, due: string }>('POST', `/api/items/${id}/postpone`, { days }),
	restore: (trash: number, today = false) => send('POST', `/api/trash/${trash}/restore`, today ? { today: true } : {}),
	trash: () => get<TrashEntry[]>('/api/trash'),
	taskDetails: (id: number) => get<TaskDetails>(`/api/items/${id}/task`),
	editTask: (id: number, edit: TaskEdit) => send<{ title: string, moved: boolean, day: string | null }>('PUT', `/api/items/${id}/task`, edit),
	overdue: () => get<OverdueTask[]>('/api/overdue'),
	moveOverdue: (sourceId: string) => send('POST', '/api/overdue/move', { sourceId }),
	stats: (from: string, to: string) => get<Counts>(`/api/stats/${from}/${to}`),
	settings: () => get<Settings>('/api/settings'),
	saveSettings: (settings: Settings) => send<Settings>('PUT', '/api/settings', { settings }),
	sources: () => get<Sources>('/api/sources'),
	template: () => get<TemplateRow[]>('/api/template'),
	saveTemplate: (rows: TemplateRow[]) => send<TemplateRow[]>('PUT', '/api/template', { rows }),
	reset: (date: string) => send('POST', `/api/day/${date}/reset`),
	shares: () => get<Share[]>('/api/shares'),
	addShare: (type: Share['share_type'], withName: string) => send('POST', '/api/shares', { type, with: withName }),
	deleteShare: (id: number) => send('DELETE', `/api/shares/${id}`),
	shared: () => get<SharedBoard[]>('/api/shared'),
}

export const errorText = (e: unknown) => e instanceof Error ? e.message : 'Something went wrong'

export function dateKeyOf(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
export const parseKey = (key: string) => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)))
export const shortDay = (key: string) => parseKey(key).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
