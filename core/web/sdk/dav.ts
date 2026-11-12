// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Small WebDAV/CalDAV/CardDAV client over the session cookie (remote.php/dav).
import { HttpError, requestToken } from './index'

export const DAV_ROOT = '/remote.php/dav'
const NS: Record<string, string> = {
	d: 'DAV:', oc: 'http://owncloud.org/ns', nc: 'http://nextcloud.org/ns',
	cal: 'urn:ietf:params:xml:ns:caldav', card: 'urn:ietf:params:xml:ns:carddav',
	cs: 'http://calendarserver.org/ns/', x1: 'http://apple.com/ns/ical/',
}

export interface DavResource {
	href: string
	/** Properties as "prefix:name" -> text, or the element for complex values. */
	props: Record<string, string>
	elements: Record<string, Element>
	status: number
}

async function davFetch(method: string, url: string, init: { body?: BodyInit, headers?: Record<string, string> } = {}): Promise<Response> {
	const res = await fetch(url, {
		method,
		credentials: 'same-origin',
		headers: { requesttoken: await requestToken(), ...init.headers },
		body: init.body,
	})
	if (!res.ok && res.status !== 207) {
		let msg = res.statusText
		try {
			const doc = new DOMParser().parseFromString(await res.text(), 'application/xml')
			msg = doc.getElementsByTagNameNS('http://sabredav.org/ns', 'message')[0]?.textContent || msg
		} catch {}
		throw new HttpError(res.status, msg || `HTTP ${res.status}`)
	}
	return res
}

function propXml(props: string[]): string {
	const used = new Set(props.map((p) => p.split(':')[0]))
	used.add('d')
	const xmlns = [...used].map((p) => `xmlns:${p}="${NS[p]}"`).join(' ')
	return `<?xml version="1.0"?><d:propfind ${xmlns}><d:prop>${props.map((p) => `<${p}/>`).join('')}</d:prop></d:propfind>`
}

export function parseMultistatus(xml: string): DavResource[] {
	const doc = new DOMParser().parseFromString(xml, 'application/xml')
	const out: DavResource[] = []
	for (const r of Array.from(doc.getElementsByTagNameNS('DAV:', 'response'))) {
		const href = decodeURI(r.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '')
		const props: Record<string, string> = {}
		const elements: Record<string, Element> = {}
		let status = 200
		for (const ps of Array.from(r.getElementsByTagNameNS('DAV:', 'propstat'))) {
			const st = ps.getElementsByTagNameNS('DAV:', 'status')[0]?.textContent ?? ''
			const code = parseInt(st.split(' ')[1] ?? '200', 10)
			if (code !== 200) continue
			const prop = ps.getElementsByTagNameNS('DAV:', 'prop')[0]
			for (const el of Array.from(prop?.children ?? [])) {
				const prefix = Object.entries(NS).find(([, ns]) => ns === el.namespaceURI)?.[0] ?? 'x'
				const key = `${prefix}:${el.localName}`
				props[key] = el.textContent ?? ''
				elements[key] = el
			}
		}
		const st = r.getElementsByTagNameNS('DAV:', 'status')[0]?.parentElement === r ? r.getElementsByTagNameNS('DAV:', 'status')[0].textContent : null
		if (st) status = parseInt(st.split(' ')[1] ?? '200', 10)
		out.push({ href, props, elements, status })
	}
	return out
}

export const dav = {
	async propfind(url: string, props: string[], depth: 0 | 1 | 'infinity' = 1): Promise<DavResource[]> {
		const res = await davFetch('PROPFIND', url, { body: propXml(props), headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' } })
		return parseMultistatus(await res.text())
	},
	async report(url: string, body: string, depth: 0 | 1 = 1): Promise<DavResource[]> {
		const res = await davFetch('REPORT', url, { body, headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' } })
		return parseMultistatus(await res.text())
	},
	async get(url: string): Promise<{ text: string, etag: string | null }> {
		const res = await davFetch('GET', url)
		return { text: await res.text(), etag: res.headers.get('etag') }
	},
	async put(url: string, body: BodyInit, contentType: string, opts: { etag?: string | null, create?: boolean } = {}): Promise<string | null> {
		const headers: Record<string, string> = { 'Content-Type': contentType }
		if (opts.etag) headers['If-Match'] = opts.etag
		if (opts.create) headers['If-None-Match'] = '*'
		const res = await davFetch('PUT', url, { body, headers })
		return res.headers.get('etag')
	},
	async delete(url: string, etag?: string | null): Promise<void> {
		await davFetch('DELETE', url, { headers: etag ? { 'If-Match': etag } : {} })
	},
	/** MKCOL; pass an extended-MKCOL body to create an address book or calendar. */
	async mkcol(url: string, body?: string): Promise<void> {
		await davFetch('MKCOL', url, body ? { body, headers: { 'Content-Type': 'application/xml; charset=utf-8' } } : {})
	},
	async move(from: string, to: string, overwrite = false): Promise<void> {
		await davFetch('MOVE', from, { headers: { Destination: new URL(to, location.href).href, Overwrite: overwrite ? 'T' : 'F' } })
	},
	async copy(from: string, to: string, overwrite = false): Promise<void> {
		await davFetch('COPY', from, { headers: { Destination: new URL(to, location.href).href, Overwrite: overwrite ? 'T' : 'F' } })
	},
	async proppatch(url: string, set: Record<string, string>): Promise<void> {
		const used = new Set(['d', ...Object.keys(set).map((k) => k.split(':')[0])])
		const xmlns = [...used].map((p) => `xmlns:${p}="${NS[p]}"`).join(' ')
		const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
		const body = `<?xml version="1.0"?><d:propertyupdate ${xmlns}><d:set><d:prop>${Object.entries(set).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</d:prop></d:set></d:propertyupdate>`
		await davFetch('PROPPATCH', url, { body, headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
	},
	/** Upload with progress (XHR: fetch has no upload progress). */
	upload(url: string, file: Blob, onProgress?: (fraction: number) => void): Promise<void> {
		return requestToken().then((t) => new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest()
			xhr.open('PUT', url)
			xhr.setRequestHeader('requesttoken', t)
			if (file.type) xhr.setRequestHeader('Content-Type', file.type)
			xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
			xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new HttpError(xhr.status, xhr.statusText)))
			xhr.onerror = () => reject(new HttpError(0, 'Network error'))
			xhr.send(file)
		}))
	},
}

/** Encode each path segment, keep the slashes. */
export const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/')
