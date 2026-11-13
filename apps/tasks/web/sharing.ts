// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sharing a task list (a CalDAV calendar) with a user or a group (P4-3),
// through Nextcloud's CalDAV sharing: POST <oc:share> on the collection, and
// <oc:invite> to read who it is shared with. Same calls as the upstream apps,
// so phones and other clients see the share. The XML is read as text (the
// structure is fixed), which also works where DOMParser lacks namespaces.
import { request, requestToken } from '@atrium/sdk'

export interface Sharee { kind: 'user' | 'group', id: string, name: string, edit: boolean }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
export const principal = (s: Pick<Sharee, 'kind' | 'id'>) => `principal:principals/${s.kind === 'group' ? 'groups' : 'users'}/${encodeURIComponent(s.id)}`

export function shareBody(s: Pick<Sharee, 'kind' | 'id' | 'edit'>): string {
	return `<?xml version="1.0"?><o:share xmlns:d="DAV:" xmlns:o="http://owncloud.org/ns"><o:set><d:href>${esc(principal(s))}</d:href>${s.edit ? '<o:read-write/>' : ''}</o:set></o:share>`
}
export function unshareBody(s: Pick<Sharee, 'kind' | 'id'>): string {
	return `<?xml version="1.0"?><o:share xmlns:d="DAV:" xmlns:o="http://owncloud.org/ns"><o:remove><d:href>${esc(principal(s))}</d:href></o:remove></o:share>`
}

/** The <oc:invite> property of a PROPFIND answer → sharees (any namespace prefix). */
export function parseInvite(xml: string): Sharee[] {
	const out: Sharee[] = []
	const user = /<([\w-]+:)?user\b[^>]*>([\s\S]*?)<\/\1?user>/g
	for (const m of xml.matchAll(user)) {
		const body = m[2]
		const href = unesc(/<(?:[\w-]+:)?href[^>]*>([^<]*)<\//.exec(body)?.[1] ?? '')
		const p = /^principal:principals\/(users|groups)\/(.+)$/.exec(href)
		if (!p) continue
		const id = decodeURIComponent(p[2])
		const name = unesc(/<(?:[\w-]+:)?common-name[^>]*>([^<]*)<\//.exec(body)?.[1] ?? '') || id
		out.push({ kind: p[1] === 'groups' ? 'group' : 'user', id, name, edit: /<(?:[\w-]+:)?read-write\s*\/?>/.test(body) })
	}
	return out
}

async function davPost(url: string, body: string): Promise<void> {
	const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { requesttoken: await requestToken(), 'Content-Type': 'application/xml; charset=utf-8' }, body })
	if (!res.ok) throw new Error(res.status === 403 ? 'Not allowed to share this list' : `Sharing failed (HTTP ${res.status})`)
}

export async function listSharees(listUrl: string): Promise<Sharee[]> {
	const res = await fetch(listUrl, {
		method: 'PROPFIND', credentials: 'same-origin',
		headers: { requesttoken: await requestToken(), Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
		body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:invite/></d:prop></d:propfind>',
	})
	if (!res.ok && res.status !== 207) throw new Error(`HTTP ${res.status}`)
	return parseInvite(await res.text())
}

export const share = (listUrl: string, s: Pick<Sharee, 'kind' | 'id' | 'edit'>) => davPost(listUrl, shareBody(s))
export const unshare = (listUrl: string, s: Pick<Sharee, 'kind' | 'id'>) => davPost(listUrl, unshareBody(s))

/** People and groups to share with (Nextcloud's sharee search, as Files uses). */
export async function searchSharees(q: string): Promise<Array<Pick<Sharee, 'kind' | 'id' | 'name'>>> {
	if (q.trim().length < 2) return []
	const p = new URLSearchParams({ search: q.trim(), itemType: 'calendar', perPage: '10', lookup: 'false', format: 'json' })
	p.append('shareType[]', '0')
	p.append('shareType[]', '1')
	const r = await request<{ ocs: { data: { exact: Record<string, Array<{ label: string, value: { shareType: number, shareWith: string } }>>, users?: Array<{ label: string, value: { shareType: number, shareWith: string } }>, groups?: Array<{ label: string, value: { shareType: number, shareWith: string } }> } } }>(`/ocs/v2.php/apps/files_sharing/api/v1/sharees?${p}`, { headers: { 'OCS-APIRequest': 'true' } })
	const d = r.ocs.data
	const all = [...(d.exact?.users ?? []), ...(d.exact?.groups ?? []), ...(d.users ?? []), ...(d.groups ?? [])]
	const seen = new Set<string>()
	return all.filter((x) => { const k = `${x.value.shareType}/${x.value.shareWith}`; if (seen.has(k)) return false; seen.add(k); return true })
		.map((x) => ({ kind: x.value.shareType === 1 ? 'group' as const : 'user' as const, id: x.value.shareWith, name: x.label }))
}
