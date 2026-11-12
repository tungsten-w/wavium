import axios from '@nextcloud/axios'
import { reactive } from 'vue'

declare const OC: { generateUrl(path: string): string }

export type Item = { id:number; source_type:'task'|'event'|'routine'|'quick'; title:string; starts_at:number|null; due_at:number|null; all_day:boolean; completed:boolean; href:string|null; error:string|null; parent_id:number|null }
export type Day = { day:string; logicalToday:string; editable:boolean; future:boolean; isOwner:boolean; items:Item[]; version:string; completeSubtasks:boolean }
export type Settings = { timezone:string; rolloverHour:number; rolloverMode:'quick_only'|'all'|'none'; completeSubtasks:boolean; taskLists:string[]; calendars:string[]; isOwner:boolean }
export type Source = { id:string; name:string }
export type Sources = { tasks:Source[]; calendars:Source[] }
export type TemplateRow = { id?:number; title:string }
export type Share = { id:number; share_type:'user'|'group'; share_with:string; display_name:string }
export type SharedBoard = { owner:string; name:string }
/** A task as stored in Tasks, for the editor. Dates are plain days (YYYY-MM-DD). */
export type TaskDetails = { title:string; description:string; start:string|null; due:string|null; priority:number; repeating:boolean }
export type TaskEdit = Omit<TaskDetails, 'repeating'>
export type OverdueTask = { id:string; title:string; date:string }
/** Something that was postponed (waiting for its day) or deleted; the Postponed page lists them. */
export type TrashEntry = { id:number; kind:'postponed'|'deleted'; title:string; count:number; day:string; due:string|null; created_at:number }

/** Whose list the Today view shows: null is your own, otherwise the owner of a list shared with you. */
export const board = reactive<{ owner:string|null }>({ owner: null })

/** Rows titled `---` are divider lines and `<br>` rows are blank gaps (mirrors EntryTree::separator). */
export function separatorKind(title:string):'rule'|'space'|null {
	switch (title.trim().toLowerCase()) {
	case '---': case '___': return 'rule'
	case '<br>': case '<br/>': case '<br />': return 'space'
	default: return null
	}
}

const url =(path:string) => OC.generateUrl(`/apps/daily_todo${path}`)
/** The server answers failures with { error: "…" }; show that instead of "status code 400". */
const withServerMessage = async <T>(request:Promise<{ data:T }>):Promise<T> => {
	try {
		return (await request).data
	} catch (reason) {
		const message = (reason as { response?: { data?: { error?: unknown } } }).response?.data?.error
		throw typeof message === 'string' && message ? new Error(message) : reason
	}
}
/** Day calls carry the owner when a shared list is open; settings, template and sharing never do. */
const scoped = (path:string) => board.owner ? `${path}${path.includes('?') ? '&' : '?'}owner=${encodeURIComponent(board.owner)}` : path
const get = async <T>(path:string):Promise<T> => withServerMessage(axios.get<T>(url(path)))
const send = async <T>(method:'post'|'put'|'delete', path:string, data?:unknown):Promise<T> => withServerMessage(axios.request<T>({ method, url:url(path), data }))

export const api = {
	day: (date:string) => get<Day>(scoped(`/api/day/${date}`)),
	/** Tiny "has the day changed?" check: compare with `Day.version` and only load the day when it differs. */
	dayVersion: (date:string) => get<{ version:string }>(scoped(`/api/day/${date}/version`)),
	summary: (month:string) => get<Record<string, { total:number; done:number }>>(scoped(`/api/summary/${month}`)),
	reorder: (date:string, ids:number[]) => send('put', scoped(`/api/day/${date}/order`), { ids }),
	complete: (id:number, completed:boolean) => send('put', `/api/items/${id}/complete`, { completed }),
	createQuick: (date:string, title:string, parentId?:number, afterId?:number) => send<{ id:number }>('post', scoped(`/api/day/${date}/quick`), { title, parentId, afterId }),
	renameQuick: (id:number, title:string) => send('put', `/api/items/${id}`, { title }),
	deleteQuick: (id:number) => send<{ trash:number }>('delete', `/api/items/${id}`),
	/** Hide one of today's own items (or a task, which moves in Tasks) for `days` days (1 = tomorrow); it is placed on that day when it starts. Both calls return a trash id for `restore` (Undo). */
	postpone: (id:number, days:number) => send<{ trash:number; due:string }>('post', `/api/items/${id}/postpone`, { days }),
	/** Undo (back where it was), or with `today` bring it to today's list. */
	restore: (trash:number, today = false) => send('post', `/api/trash/${trash}/restore`, today ? { today: true } : undefined),
	trash: () => get<TrashEntry[]>('/api/trash'),
	taskDetails: (id:number) => get<TaskDetails>(`/api/items/${id}/task`),
	/** Save the task in Tasks. `moved` is true when the new dates put it on another day (`day`). */
	editTask: (id:number, edit:TaskEdit) => send<{ title:string; moved:boolean; day:string|null }>('put', `/api/items/${id}/task`, edit),
	/** Unfinished tasks of earlier days that are not on today's list (your own list). */
	overdue: () => get<OverdueTask[]>('/api/overdue'),
	moveOverdue: (sourceId:string) => send('post', '/api/overdue/move', { sourceId }),
	/** Completion per recorded day of your own list, both dates included (at most a year). */
	stats: (from:string, to:string) => get<Record<string, { total:number; done:number }>>(`/api/stats/${from}/${to}`),
	settings: () => get<Settings>('/api/settings'),
	saveSettings: (settings:Settings) => send<Settings>('put', '/api/settings', { settings }),
	sources: () => get<Sources>('/api/sources'),
	template: () => get<TemplateRow[]>('/api/template'),
	saveTemplate: (rows:TemplateRow[]) => send<TemplateRow[]>('put', '/api/template', { rows }),
	reset: (date:string) => send('post', `/api/day/${date}/reset`),
	shares: () => get<Share[]>('/api/shares'),
	addShare: (type:Share['share_type'], withName:string) => send('post', '/api/shares', { type, with: withName }),
	deleteShare: (id:number) => send('delete', `/api/shares/${id}`),
	shared: () => get<SharedBoard[]>('/api/shared'),
}
