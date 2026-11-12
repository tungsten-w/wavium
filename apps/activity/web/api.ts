// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Activity OCS API v2 (apps/activity/appinfo/routes.php), unchanged. Every app
// publishes through OCP\Activity\IManager; the Activity app stores and renders
// the events (each app's IProvider writes the sentence), this only shows them.
import { HttpError, request } from '@atrium/sdk'

export interface Filter { id: string, name: string, icon: string, priority: number }

export interface RichParam { type: string, id: string, name: string, link?: string, path?: string, [k: string]: unknown }
export type Rich = [string, Record<string, RichParam> | []]

export interface Preview { link: string, source: string, mimeType: string, isMimeTypeIcon: boolean, fileId: number, view?: string, filePath?: string }

export interface Activity {
	activity_id: number
	app: string
	type: string
	user: string
	affecteduser: string
	subject: string
	subject_rich: Rich
	message: string
	message_rich: Rich
	object_type: string
	object_id: number
	object_name?: string
	link: string
	icon: string
	datetime: string
	previews?: Preview[]
}

const base = '/ocs/v2.php/apps/activity/api/v2/activity'
const headers = { 'OCS-APIRequest': 'true' }

export async function listFilters(): Promise<Filter[]> {
	const r = await request<{ ocs: { data: Filter[] } }>(`${base}/filters?format=json`, { headers })
	return r.ocs.data
}

/** One page, newest first. `next` is the `since` for the following page (null at the end). */
export async function feed(filter: string, since = 0, limit = 30): Promise<{ items: Activity[], next: number | null }> {
	const url = `${base}/${encodeURIComponent(filter)}?format=json&previews=true&limit=${limit}${since ? `&since=${since}` : ''}`
	let res: Response
	try {
		res = await request<Response>(url, { headers, raw: true })
	} catch (e) {
		// The API answers 304 when there is nothing (more) to show.
		if (e instanceof HttpError && e.status === 304) return { items: [], next: null }
		throw e
	}
	if (res.status === 304 || res.status === 204) return { items: [], next: null }
	const j = await res.json() as { ocs: { data: Activity[] } }
	const last = res.headers.get('X-Activity-Last-Given')
	const more = !!res.headers.get('Link')
	return { items: j.ocs.data ?? [], next: more && last ? Number(last) : null }
}
