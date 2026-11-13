// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hands a request to PHP-FPM over FastCGI. Used for every PHP route the web
// server proxies, and by the agent layer to call PHP directly (no HTTP hop).
import { fastcgi, type FastCgiTarget } from './fastcgi'
import { BodyTooLarge, spoolBody, type Spooled } from './spool'

export interface PhpTarget {
	fpm: FastCgiTarget
	docroot: string
	port: number
	/** Largest chunked body spooled for PHP (Bun already caps every body). */
	maxBody?: number
}

/** Headers an outside client may never send; only the agent layer sets them. */
export const INTERNAL_HEADERS = ['x-atrium-internal']

export async function servePhp(t: PhpTarget, req: Request, url: URL, script: string, pathInfo: string, remote: string, opts: { internal?: Record<string, string>, onBodySent?: () => void } = {}): Promise<Response> {
	// onBodySent: the client's body is fully in (spooled, or streamed to PHP).
	// Called once; the server then stops treating the client as idle.
	let received = false
	const bodyIn = () => {
		if (received) return
		received = true
		opts.onBodySent?.()
	}
	const host = req.headers.get('host') ?? 'localhost'
	const params: Record<string, string> = {
		GATEWAY_INTERFACE: 'CGI/1.1',
		SERVER_SOFTWARE: 'atrium-bun',
		SERVER_PROTOCOL: 'HTTP/1.1',
		SERVER_NAME: host.replace(/:\d+$/, ''),
		SERVER_PORT: String(t.port),
		SERVER_ADDR: '127.0.0.1',
		REMOTE_ADDR: remote,
		REMOTE_PORT: '0',
		REQUEST_METHOD: req.method,
		REQUEST_URI: url.pathname + url.search,
		QUERY_STRING: url.search.slice(1),
		DOCUMENT_ROOT: t.docroot,
		DOCUMENT_URI: script,
		SCRIPT_NAME: script,
		SCRIPT_FILENAME: t.docroot + script,
		PHP_SELF: script + pathInfo,
		// Nextcloud: URLs without index.php, and headers are set by the server.
		front_controller_active: 'true',
		modHeadersAvailable: 'true',
	}
	if (pathInfo) {
		params.PATH_INFO = pathInfo
		params.PATH_TRANSLATED = t.docroot + pathInfo
	}
	let body: ReadableStream<Uint8Array> | null = req.body
	let spooled: Spooled | null = null
	const length = req.headers.get('content-length')
	if (length !== null) params.CONTENT_LENGTH = length
	else if (body) {
		// Chunked request: PHP needs a length, so read it in full first (like
		// nginx does), on disk past 1 MiB (server/spool.ts).
		try {
			spooled = await spoolBody(body, { maxBytes: t.maxBody })
		} catch (e) {
			if (e instanceof BodyTooLarge) return new Response('Payload too large', { status: 413 })
			console.error(`upload spool: ${(e as Error).message}`)
			return new Response('Bad request', { status: 400 })
		}
		params.CONTENT_LENGTH = String(spooled.length)
		// The client is done; replaying a big spool to PHP takes a while.
		bodyIn()
		body = spooled.stream()
	}
	const type = req.headers.get('content-type')
	if (type !== null) params.CONTENT_TYPE = type
	// Frames get the shell CSS injected, which needs uncompressed HTML from PHP.
	const inFrame = req.headers.get('sec-fetch-dest') === 'iframe'
	req.headers.forEach((value, name) => {
		if (name === 'content-length' || name === 'content-type' || name === 'proxy') return
		if (inFrame && name === 'accept-encoding') return
		if (INTERNAL_HEADERS.includes(name)) return
		params['HTTP_' + name.toUpperCase().replace(/-/g, '_')] = value
	})
	for (const [name, value] of Object.entries(opts.internal ?? {})) {
		params['HTTP_' + name.toUpperCase().replace(/-/g, '_')] = value
	}

	// The temp file goes once PHP has it all, or once PHP answered (it may answer
	// without reading the body; the open file stays readable until closed).
	const sent = () => {
		void spooled?.cleanup()
		bodyIn()
	}
	let res
	try {
		res = await fastcgi(t.fpm, params, body, undefined, sent)
	} catch (e) {
		console.error(`fastcgi ${t.fpm.host}:${t.fpm.port}: ${(e as Error).message}`)
		return new Response('Bad gateway', { status: 502 })
	} finally {
		void spooled?.cleanup()
	}
	const noBody = req.method === 'HEAD' || res.status === 204 || res.status === 304
	if (noBody) res.body.cancel().catch(() => {})
	return new Response(noBody ? null : res.body, { status: res.status, headers: res.headers })
}
