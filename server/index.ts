// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Atrium web server: replaces Apache + .htaccess. Serves static files from the
// Nextcloud tree and hands PHP entry points to PHP-FPM over FastCGI, with the
// same URL rules as Nextcloud's Apache/.htaccess and nginx configs.
// See docs/architecture/0007-frontend-and-server.md and 0008-client-compatibility.md.
import { readdir, stat } from 'node:fs/promises'
import type { FastCgiTarget } from './fastcgi'
import { servePhp, type PhpTarget } from './php'
import { isShellPage, route } from './routes'
import { startAgentLayer, type AgentLayer } from './agent'
import { loadLimits } from './limits'
import { demoInfo, demoRefusal, loadPublicDemo, refusalResponse } from './publicdemo'

const docroot = (process.env.ATRIUM_DOCROOT ?? '/var/www/html').replace(/\/$/, '')
const [fpmHost, fpmPort] = (process.env.ATRIUM_FPM ?? '127.0.0.1:9000').split(':')
const fpm: FastCgiTarget = { host: fpmHost, port: Number(fpmPort ?? 9000) }
const port = Number(process.env.PORT ?? 8080)
const quiet = process.env.ATRIUM_ACCESS_LOG === '0'
const limits = loadLimits()
const php: PhpTarget = { fpm, docroot, port, maxBody: limits.maxBody }
const publicDemo = loadPublicDemo()

// The agent layer (MCP/REST for agents, ADR 0009). Off with ATRIUM_AGENT=0, or
// when it cannot start (it logs why); the rest of the server keeps running.
let agent: AgentLayer | null = null
if (process.env.ATRIUM_AGENT !== '0') {
	startAgentLayer({ docroot, php }).then((a) => { agent = a }).catch((e) => {
		console.error(`agent layer not started: ${(e as Error).message}`)
	})
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile()
	} catch {
		return false
	}
}

const fs = {
	isFile: (rel: string) => isFile(docroot + rel),
}

/**
 * Index of the React app UIs (route -> manifest + url), read by the shell. Built
 * from every app's web/dist/manifest.json at request time, so bind-mounted apps
 * and apps installed later (custom_apps, git) show up without a rebuild.
 * apps/ wins over custom_apps/ for the same app id.
 */
const APP_ROOTS = ['/apps', '/custom_apps']
let appsIndexCache: { at: number, body: string } | null = null
async function appsIndex(): Promise<string> {
	if (appsIndexCache && Date.now() - appsIndexCache.at < 5000) return appsIndexCache.body
	const index: Record<string, Record<string, unknown>> = {}
	const seen = new Set<string>()
	for (const root of APP_ROOTS) {
		let ids: string[] = []
		try { ids = await readdir(docroot + root) } catch { continue }
		for (const id of ids.sort()) {
			if (seen.has(id) || !/^[a-z0-9_]+$/.test(id)) continue
			try {
				const man = JSON.parse(await Bun.file(`${docroot}${root}/${id}/web/dist/manifest.json`).text()) as { route?: string }
				seen.add(id)
				index[man.route ?? id] = { ...man, url: `${root}/${id}/web/dist/` }
			} catch { /* no React UI */ }
		}
	}
	appsIndexCache = { at: Date.now(), body: JSON.stringify(index) }
	return appsIndexCache.body
}

function securityHeaders(h: Headers, pathname: string) {
	h.set('Referrer-Policy', pathname.endsWith('/login') ? 'same-origin' : 'no-referrer')
	h.set('X-Content-Type-Options', 'nosniff')
	h.set('X-Frame-Options', 'SAMEORIGIN')
	h.set('X-Permitted-Cross-Domain-Policies', 'none')
	h.set('X-Robots-Tag', 'noindex, nofollow')
	// Nothing in Wavium uses these (location: the weather widget, Wavium only); a page tricked into asking gets a no.
	h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self), payment=(), usb=(), serial=(), bluetooth=(), hid=()')
}

/**
 * The React shell: framing only by Wavium itself, no <base> or plugin tricks,
 * forms only to Wavium, and a window of its own (no opener handle for others).
 * Scripts are not restricted here: the import map is inline (see SHELL_INDEX).
 */
export const SHELL_CSP = "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'"
function shellHeaders(h: Headers) {
	h.set('Content-Security-Policy', SHELL_CSP)
	h.set('Cross-Origin-Opener-Policy', 'same-origin')
}

const longCache = /\.(css|js|mjs|svg|gif|png|jpg|jpeg|webp|ico|wasm|tflite|map)$/
const fontCache = /\.(otf|ttf|woff2?)$/
const types: Record<string, string> = {
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	svg: 'image/svg+xml',
	wasm: 'application/wasm',
	json: 'application/json',
	html: 'text/html; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	map: 'application/json',
}

async function serveStatic(req: Request, url: URL, rel: string): Promise<Response> {
	const file = Bun.file(docroot + rel)
	const headers = new Headers()
	const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
	headers.set('Content-Type', types[ext] ?? (file.type || 'application/octet-stream'))
	if (longCache.test(rel)) {
		headers.set('Cache-Control', url.searchParams.has('v') ? 'max-age=15778463, immutable' : 'max-age=15778463')
	} else if (fontCache.test(rel)) {
		headers.set('Cache-Control', 'max-age=604800')
	}
	const mtime = new Date(file.lastModified)
	mtime.setMilliseconds(0)
	headers.set('Last-Modified', mtime.toUTCString())
	const since = req.headers.get('if-modified-since')
	if (since && new Date(since) >= mtime) return new Response(null, { status: 304, headers })
	return new Response(file, { headers })
}

// The React shell (built by build/atrium/web-build.ts).
const SHELL_INDEX = '/core/web/dist/index.html'
// Classic pages shown inside the shell drop their own header.
const FRAME_STYLE = '<style id="atrium-frame">#header{display:none!important}body,#body-user{background:var(--color-main-background)!important;background-image:none!important}:root,body{--header-height:0px!important;--body-container-margin:0px!important;--body-container-radius:0px!important}#content,#content-vue{margin:0!important;height:100vh!important;width:100%!important;border-radius:0!important}</style>'
function framed(res: Response): Response {
	const headers = new Headers(res.headers)
	headers.delete('content-length')
	const rewritten = new HTMLRewriter().on('head', { element(el) { el.append(FRAME_STYLE, { html: true }) } }).transform(new Response(res.body, { headers }))
	return new Response(rewritten.body, { status: res.status, headers })
}

/**
 * Called once the request body is fully received: from then on the server (PHP,
 * the agent layer) is working, so the idle cut for slow clients no longer applies.
 */
type Received = () => void

async function handle(req: Request, remote: string, received: Received): Promise<Response> {
	const url = new URL(req.url)
	let pathname: string
	try {
		pathname = decodeURIComponent(url.pathname)
	} catch {
		return new Response('Bad request', { status: 400 })
	}
	if (pathname.includes('\0') || pathname.split('/').includes('..')) {
		return new Response('Bad request', { status: 400 })
	}
	if (pathname === '/core/web/dist/apps.json' && (req.method === 'GET' || req.method === 'HEAD')) {
		const res = new Response(req.method === 'HEAD' ? null : await appsIndex(), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } })
		securityHeaders(res.headers, url.pathname)
		return res
	}
	if (pathname === '/core/web/dist/demo.json' && (req.method === 'GET' || req.method === 'HEAD')) {
		const res = new Response(req.method === 'HEAD' ? null : JSON.stringify(demoInfo(publicDemo)), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } })
		securityHeaders(res.headers, url.pathname)
		return res
	}
	const refused = demoRefusal(publicDemo, req.method, pathname)
	if (refused) {
		const res = refusalResponse(pathname, refused)
		securityHeaders(res.headers, url.pathname)
		return res
	}
	// OAuth discovery for MCP clients (server/agent/oauth.ts) is served by the agent layer.
	if (pathname === '/agent' || pathname.startsWith('/agent/') || /^\/\.well-known\/oauth-(?:protected-resource|authorization-server)(?:\/|$)/.test(pathname)) {
		// Agent bodies are small JSON: read them first, so a slow tool call is not cut.
		if (agent && req.body) req = new Request(req, { body: await req.arrayBuffer() })
		received()
		const res = agent ? await agent.handle(req, url, pathname, remote)
			: Response.json({ error: { code: 'unavailable', message: 'Agent layer is not running' } }, { status: 503 })
		securityHeaders(res.headers, url.pathname)
		return res
	}
	const dest = req.headers.get('sec-fetch-dest')
	if (isShellPage(pathname, req.method, dest, req.headers.get('accept'))) {
		const shell = Bun.file(docroot + SHELL_INDEX)
		if (await shell.exists()) {
			const res = new Response(req.method === 'HEAD' ? null : shell, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } })
			securityHeaders(res.headers, url.pathname)
			shellHeaders(res.headers)
			return res
		}
	}
	const r = await route(pathname, req.headers.get('user-agent') ?? '', fs)
	let res: Response
	switch (r.kind) {
		case 'redirect':
			res = new Response(null, { status: r.status, headers: { Location: r.location } })
			break
		case 'deny':
			res = new Response('Not found', { status: 404 })
			break
		case 'static':
			res = await serveStatic(req, url, r.path)
			break
		case 'php':
			res = await servePhp(php, req, url, r.script, r.pathInfo, remote, { onBodySent: received })
			if (dest === 'iframe' && (res.headers.get('content-type') ?? '').startsWith('text/html') && res.body) res = framed(res)
			break
	}
	securityHeaders(res.headers, url.pathname)
	return res
}

const server = Bun.serve({
	port,
	hostname: '0.0.0.0',
	// See server/limits.ts. Bigger bodies get 413 before reaching PHP.
	maxRequestBodySize: limits.maxBody,
	idleTimeout: limits.idleTimeout,
	async fetch(req, srv) {
		const started = performance.now()
		const remote = srv.requestIP(req)?.address?.replace(/^::ffff:/, '') ?? '127.0.0.1'
		const res = await handle(req, remote, () => srv.timeout(req, limits.phpTimeout))
		if (!quiet) {
			const u = new URL(req.url)
			console.log(`${remote} ${req.method} ${u.pathname} ${res.status} ${Math.round(performance.now() - started)}ms`)
		}
		return res
	},
	error(e) {
		console.error(e)
		return new Response('Internal server error', { status: 500 })
	},
})

console.log(`atrium web: http://0.0.0.0:${server.port} docroot=${docroot} fpm=${fpm.host}:${fpm.port} max-body=${limits.maxBody} idle=${limits.idleTimeout}s php-idle=${limits.phpTimeout || 'off'}${publicDemo.enabled ? ' PUBLIC DEMO' : ''}`)
