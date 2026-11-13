// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test helper for the React UIs: a fake Atrium server behind `fetch`.
//
//   const server = fakeServer()
//   server.on('GET', '/apps/mail/api/accounts', () => [account])
//   server.on('POST', /^\/apps\/mail\/api\/outbox\/(\d+)$/, (req, [id]) => ({ id: Number(id) }))
//   ... render ...
//   expect(server.calls('POST', '/apps/mail/api/outbox')).toHaveLength(1)
//   server.restore()
//
// A handler returns a value (sent as JSON, 200), a Response, or throws. A
// request no handler matches is answered 404 and recorded in `server.unhandled`,
// so a test can assert the UI made no unexpected call.
// /csrftoken is answered by default.

/** A response as fetch returns it after following a redirect to `path` (sets `res.url`). */
export function redirectedTo(path: string, init: ResponseInit = {}): Response {
	const res = new Response('', { status: 200, ...init })
	Object.defineProperty(res, 'url', { value: new URL(path, 'http://atrium.test').href })
	return res
}

export interface FakeRequest {
	method: string
	path: string
	query: URLSearchParams
	headers: Headers
	body: unknown
}

type Handler = (req: FakeRequest, params: string[]) => unknown

interface Route { method: string, path: string | RegExp, handler: Handler }

export interface FakeServer {
	on(method: string, path: string | RegExp, handler: Handler): FakeServer
	calls(method?: string, path?: string | RegExp): FakeRequest[]
	readonly log: FakeRequest[]
	readonly unhandled: FakeRequest[]
	restore(): void
}

function match(route: Route, method: string, path: string): string[] | null {
	if (route.method !== '*' && route.method !== method) return null
	if (typeof route.path === 'string') return route.path === path ? [] : null
	const m = route.path.exec(path)
	return m ? m.slice(1) : null
}

export function fakeServer(): FakeServer {
	const routes: Route[] = []
	const log: FakeRequest[] = []
	const unhandled: FakeRequest[] = []
	const original = globalThis.fetch

	globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://atrium.test')
		const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
		let body: unknown = init.body ?? null
		if (typeof body === 'string') {
			try { body = JSON.parse(body) } catch { /* plain text */ }
		}
		const req: FakeRequest = { method, path: url.pathname, query: url.searchParams, headers: new Headers(init.headers), body }
		log.push(req)
		if (url.pathname === '/csrftoken') return Response.json({ token: 'test-token' })
		// Last registered route wins, so a test can override a default.
		for (const route of [...routes].reverse()) {
			const params = match(route, method, url.pathname)
			if (!params) continue
			const out = await route.handler(req, params)
			return out instanceof Response ? out : Response.json(out ?? null)
		}
		unhandled.push(req)
		return new Response('not found in fakeServer', { status: 404 })
	}) as typeof fetch

	const server: FakeServer = {
		on(method, path, handler) {
			routes.push({ method: method.toUpperCase(), path, handler })
			return server
		},
		calls(method, path) {
			return log.filter((r) => (!method || r.method === method.toUpperCase())
				&& (!path || (typeof path === 'string' ? r.path === path : path.test(r.path))))
		},
		log,
		unhandled,
		restore() {
			globalThis.fetch = original
		},
	}
	return server
}
