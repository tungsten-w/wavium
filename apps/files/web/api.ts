// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Files over WebDAV (remote.php/dav/files/<user>), trash bin, favorites, recent and shares (OCS).
import { DAV_ROOT, HttpError, dav, encodePath, ocs, requestToken, parseMultistatus, type DavResource } from '@atrium/sdk'

export interface Node {
	/** Path below the user's root, starting with "/" ("/" for the root). */
	path: string
	name: string
	url: string
	dir: boolean
	id: number
	size: number
	mtime: Date
	mime: string
	etag: string
	/** OC permission letters: R share, S shared, M mounted, G read, D delete, N rename, V move, C/K create, W write. */
	perms: string
	favorite: boolean
	hasPreview: boolean
	shareTypes: number[]
	owner: string
	mountType: string
}

export interface TrashItem { url: string, name: string, original: string, deleted: Date, dir: boolean, size: number, mime: string, id: number }

export const PROPS = [
	'd:getlastmodified', 'd:getetag', 'd:getcontenttype', 'd:resourcetype', 'd:getcontentlength',
	'oc:fileid', 'oc:permissions', 'oc:size', 'oc:favorite', 'oc:share-types', 'oc:owner-display-name',
	'nc:has-preview', 'nc:mount-type',
]

export const filesRoot = (user: string) => `${DAV_ROOT}/files/${encodeURIComponent(user)}`
export const nodeUrl = (user: string, path: string) => filesRoot(user) + encodePath(path === '/' ? '' : path)
export const join = (dir: string, name: string) => (dir === '/' ? '' : dir) + '/' + name
export const parentOf = (path: string) => path.replace(/\/[^/]*$/, '') || '/'

function toNode(user: string, r: DavResource): Node {
	const root = decodeURI(filesRoot(user))
	let path = r.href.startsWith(root) ? r.href.slice(root.length) : r.href
	path = path.replace(/\/$/, '') || '/'
	const dir = !!r.elements['d:resourcetype']?.getElementsByTagNameNS('DAV:', 'collection').length
	const st = r.elements['oc:share-types']
	return {
		path, dir,
		name: path === '/' ? '' : path.split('/').pop()!,
		url: nodeUrl(user, path),
		id: Number(r.props['oc:fileid'] ?? 0),
		size: Number(r.props['oc:size'] ?? r.props['d:getcontentlength'] ?? 0),
		mtime: new Date(r.props['d:getlastmodified'] ?? 0),
		mime: dir ? 'httpd/unix-directory' : r.props['d:getcontenttype'] ?? 'application/octet-stream',
		etag: (r.props['d:getetag'] ?? '').replace(/"/g, ''),
		perms: r.props['oc:permissions'] ?? '',
		favorite: r.props['oc:favorite'] === '1',
		hasPreview: r.props['nc:has-preview'] === 'true',
		shareTypes: st ? Array.from(st.children).map((c) => Number(c.textContent)) : [],
		owner: r.props['oc:owner-display-name'] ?? '',
		mountType: r.props['nc:mount-type'] ?? '',
	}
}

/** The folder itself and its children. */
export async function listDir(user: string, path: string): Promise<{ self: Node, children: Node[] }> {
	const rs = await dav.propfind(nodeUrl(user, path) + (path === '/' ? '/' : ''), PROPS, 1)
	const nodes = rs.map((r) => toNode(user, r))
	const self = nodes.find((n) => n.path === (path.replace(/\/$/, '') || '/')) ?? nodes[0]
	return { self, children: nodes.filter((n) => n !== self) }
}

export async function stat(user: string, path: string): Promise<Node> {
	const [r] = await dav.propfind(nodeUrl(user, path), PROPS, 0)
	return toNode(user, r)
}

export async function favorites(user: string): Promise<Node[]> {
	const props = PROPS.map((p) => `<${p}/>`).join('')
	const body = `<?xml version="1.0"?><oc:filter-files xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop>${props}</d:prop><oc:filter-rules><oc:favorite>1</oc:favorite></oc:filter-rules></oc:filter-files>`
	return (await dav.report(filesRoot(user) + '/', body, 1)).map((r) => toNode(user, r))
}

/** DASL SEARCH below the user's root. `where` is the inner XML of d:where (or empty for everything). */
async function search(user: string, where: string, orderBy: string, limit: number): Promise<Node[]> {
	const props = PROPS.map((p) => `<${p}/>`).join('')
	const body = `<?xml version="1.0"?><d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:basicsearch>`
		+ `<d:select><d:prop>${props}</d:prop></d:select><d:from><d:scope><d:href>/files/${encodeURIComponent(user)}</d:href><d:depth>infinity</d:depth></d:scope></d:from>`
		+ `<d:where>${where}</d:where><d:orderby>${orderBy}</d:orderby><d:limit><d:nresults>${limit}</d:nresults></d:limit></d:basicsearch></d:searchrequest>`
	const res = await fetch(DAV_ROOT + '/', { method: 'SEARCH', credentials: 'same-origin', headers: { requesttoken: await requestToken(), 'Content-Type': 'text/xml; charset=utf-8' }, body })
	if (!res.ok && res.status !== 207) throw new HttpError(res.status, res.statusText)
	return parseMultistatus(await res.text()).map((r) => toNode(user, r)).filter((n) => n.path !== '/')
}

export function recent(user: string): Promise<Node[]> {
	const since = Math.floor(Date.now() / 1000) - 14 * 86400
	const where = `<d:and><d:not><d:is-collection/></d:not><d:gt><d:prop><d:getlastmodified/></d:prop><d:literal>${since}</d:literal></d:gt></d:and>`
	return search(user, where, `<d:order><d:prop><d:getlastmodified/></d:prop><d:descending/></d:order>`, 100)
}

export function searchName(user: string, q: string): Promise<Node[]> {
	const esc = q.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/%/g, '\\%')
	return search(user, `<d:like><d:prop><d:displayname/></d:prop><d:literal>%${esc}%</d:literal></d:like>`, `<d:order><d:prop><d:getlastmodified/></d:prop><d:descending/></d:order>`, 200)
}

export const mkdir = (user: string, path: string) => dav.mkcol(nodeUrl(user, path))
export const move = (user: string, from: string, to: string, overwrite = false) => dav.move(nodeUrl(user, from), nodeUrl(user, to), overwrite)
export const copy = (user: string, from: string, to: string, overwrite = false) => dav.copy(nodeUrl(user, from), nodeUrl(user, to), overwrite)
export const remove = (user: string, path: string) => dav.delete(nodeUrl(user, path))
export const setFavorite = (n: Node, on: boolean) => dav.proppatch(n.url, { 'oc:favorite': on ? '1' : '0' })


/** A name that does not clash with `taken`: "a.txt" -> "a (2).txt". */
export function freeName(name: string, taken: Set<string>): string {
	if (!taken.has(name)) return name
	const m = /^(.*?)(\.[^.]+)?$/.exec(name)!
	for (let i = 2; ; i++) {
		const n = `${m[1]} (${i})${m[2] ?? ''}`
		if (!taken.has(n)) return n
	}
}

export const downloadUrl = (n: Node) => n.dir ? `${n.url}?accept=zip` : n.url
/** Zip of several entries of one folder. */
export const zipUrl = (user: string, dir: string, names: string[]) => `${nodeUrl(user, dir)}${dir === '/' ? '/' : ''}?accept=zip&files=${encodeURIComponent(JSON.stringify(names))}`
export const previewUrl = (n: Node, size = 256) => `/index.php/core/preview?fileId=${n.id}&x=${size}&y=${size}&a=1&c=${n.etag}`

// ---------------------------------------------------------------- trash bin

const trashRoot = (user: string) => `${DAV_ROOT}/trashbin/${encodeURIComponent(user)}`
export async function listTrash(user: string): Promise<TrashItem[]> {
	const rs = await dav.propfind(trashRoot(user) + '/trash/', ['nc:trashbin-filename', 'nc:trashbin-original-location', 'nc:trashbin-deletion-time', 'd:resourcetype', 'oc:size', 'd:getcontentlength', 'd:getcontenttype', 'oc:fileid'], 1)
	return rs.slice(1).map((r) => ({
		url: r.href,
		name: r.props['nc:trashbin-filename'] ?? r.href.split('/').filter(Boolean).pop()!,
		original: r.props['nc:trashbin-original-location'] ?? '',
		deleted: new Date(Number(r.props['nc:trashbin-deletion-time'] ?? 0) * 1000),
		dir: !!r.elements['d:resourcetype']?.getElementsByTagNameNS('DAV:', 'collection').length,
		size: Number(r.props['oc:size'] ?? r.props['d:getcontentlength'] ?? 0),
		mime: r.props['d:getcontenttype'] ?? '',
		id: Number(r.props['oc:fileid'] ?? 0),
	})).sort((a, b) => b.deleted.getTime() - a.deleted.getTime())
}
export const restoreTrash = (user: string, t: TrashItem) => dav.move(t.url, `${trashRoot(user)}/restore/${encodeURIComponent(t.url.split('/').filter(Boolean).pop()!)}`, true)
export const purgeTrash = (t: TrashItem) => dav.delete(t.url)
export const emptyTrash = (user: string) => dav.delete(trashRoot(user) + '/trash')

// ---------------------------------------------------------------- shares (OCS files_sharing)

export interface Share {
	id: string
	share_type: number
	share_with: string | null
	share_with_displayname: string | null
	url?: string
	token?: string
	permissions: number
	expiration: string | null
	path: string
	item_type: 'file' | 'folder'
	file_target: string
	uid_owner: string
	displayname_owner: string
	file_source: number
	mimetype: string
	stime: number
	password?: string | null
	label?: string
}
export const SHARE_USER = 0, SHARE_GROUP = 1, SHARE_LINK = 3, SHARE_EMAIL = 4
const SHARES = 'apps/files_sharing/api/v1/shares'

export const sharesOf = (path: string) => ocs<Share[]>(`${SHARES}?path=${encodeURIComponent(path)}&reshares=true`)
export const sharedWithMe = () => ocs<Share[]>(`${SHARES}?shared_with_me=true&include_tags=true`)
export const sharedByMe = () => ocs<Share[]>(`${SHARES}?include_tags=true`)
export const createShare = (body: { path: string, shareType: number, shareWith?: string, permissions?: number }) => ocs<Share>(SHARES, { method: 'POST', body })
export const updateShare = (id: string, body: Record<string, string | number>) => ocs<Share>(`${SHARES}/${id}`, { method: 'PUT', body })
export const deleteShare = (id: string) => ocs(`${SHARES}/${id}`, { method: 'DELETE' })

export interface Sharee { label: string, value: { shareType: number, shareWith: string } }
export async function findSharees(q: string, itemType: string): Promise<Sharee[]> {
	const r = await ocs<{ exact: Record<string, Sharee[]>, users: Sharee[], groups: Sharee[] }>(`apps/files_sharing/api/v1/sharees?search=${encodeURIComponent(q)}&itemType=${itemType}&perPage=10&shareType[]=0&shareType[]=1`)
	return [...(r.exact.users ?? []), ...(r.exact.groups ?? []), ...(r.users ?? []), ...(r.groups ?? [])]
}

// ---------------------------------------------------------------- quota

export async function quota(user: string): Promise<{ used: number, free: number }> {
	const [r] = await dav.propfind(filesRoot(user) + '/', ['d:quota-used-bytes', 'd:quota-available-bytes'], 0)
	return { used: Number(r.props['d:quota-used-bytes'] ?? 0), free: Number(r.props['d:quota-available-bytes'] ?? -3) }
}

// ---------------------------------------------------------------- text files

export async function readText(n: Node): Promise<{ text: string, etag: string | null }> { return dav.get(n.url) }
export const saveText = (n: Node, text: string, etag: string | null) => dav.put(n.url, text, n.mime.startsWith('text/') ? `${n.mime}; charset=utf-8` : 'text/plain; charset=utf-8', { etag })
export const isText = (n: Node) => !n.dir && (n.mime.startsWith('text/') || /\/(json|xml|javascript|x-sh|x-yaml|yaml|toml|x-php|sql)$/.test(n.mime) || /\.(md|txt|json|ya?ml|toml|ini|conf|log|csv|sh|ts|tsx|js|css|html?)$/i.test(n.name))
export const isImage = (n: Node) => !n.dir && /^image\/(png|jpe?g|gif|webp|svg\+xml|bmp|avif|heic|heif)$/.test(n.mime)
export const isMedia = (n: Node) => !n.dir && /^(video|audio)\//.test(n.mime)
export const isPdf = (n: Node) => n.mime === 'application/pdf'

// ---------------------------------------------------------------- uploads

const CHUNK = 10 * 1024 * 1024
function xhr(method: string, url: string, body: Blob | null, headers: Record<string, string>, onProgress?: (loaded: number) => void): Promise<void> {
	return requestToken().then((t) => new Promise((resolve, reject) => {
		const x = new XMLHttpRequest()
		x.open(method, url)
		x.setRequestHeader('requesttoken', t)
		for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v)
		if (onProgress) x.upload.onprogress = (e) => onProgress(e.loaded)
		x.onload = () => (x.status < 300 ? resolve() : reject(new HttpError(x.status, x.statusText || `HTTP ${x.status}`)))
		x.onerror = () => reject(new HttpError(0, 'Network error'))
		x.send(body)
	}))
}

/** Upload one file; above 10 MB it goes in chunks (Nextcloud chunking v2), so PHP size limits don't apply. */
export async function uploadFile(user: string, path: string, file: File, onProgress?: (fraction: number) => void): Promise<void> {
	const dest = new URL(nodeUrl(user, path), location.href).href
	const mtime = { 'X-OC-Mtime': String(Math.floor(file.lastModified / 1000)) }
	if (file.size <= CHUNK) {
		await xhr('PUT', nodeUrl(user, path), file, { 'Content-Type': file.type || 'application/octet-stream', ...mtime }, (l) => onProgress?.(l / Math.max(1, file.size)))
		return
	}
	const dir = `${DAV_ROOT}/uploads/${encodeURIComponent(user)}/atrium-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
	const common = { Destination: dest, 'OC-Total-Length': String(file.size) }
	await xhr('MKCOL', dir, null, common)
	try {
		let sent = 0
		for (let i = 0, n = 1; i < file.size; i += CHUNK, n++) {
			const part = file.slice(i, i + CHUNK)
			await xhr('PUT', `${dir}/${String(n).padStart(5, '0')}`, part, common, (l) => onProgress?.((sent + l) / file.size))
			sent += part.size
		}
		await xhr('MOVE', `${dir}/.file`, null, { ...common, ...mtime })
	} catch (e) {
		dav.delete(dir).catch(() => {})
		throw e
	}
}
