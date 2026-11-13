// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import { loadLimits, parseSize } from './limits'

test('parseSize: PHP-style sizes', () => {
	expect(parseSize('1048576')).toBe(1048576)
	expect(parseSize('512K')).toBe(512 * 1024)
	expect(parseSize('512M')).toBe(512 * 1024 ** 2)
	expect(parseSize('10G')).toBe(10 * 1024 ** 3)
	expect(parseSize('10g')).toBe(10 * 1024 ** 3)
	expect(parseSize(' 2GB ')).toBe(2 * 1024 ** 3)
	expect(parseSize('1.5M')).toBe(1.5 * 1024 ** 2)
	expect(parseSize('1T')).toBe(1024 ** 4)
	expect(parseSize('0')).toBe(Infinity)
	for (const bad of ['', 'ten', '-1', '10X', '10 G B']) expect(() => parseSize(bad)).toThrow()
})

test('loadLimits: defaults follow PHP', () => {
	expect(loadLimits({})).toEqual({ maxBody: 10 * 1024 ** 3, idleTimeout: 60, phpTimeout: 0 })
	expect(loadLimits({ PHP_UPLOAD_LIMIT: '2G' }).maxBody).toBe(2 * 1024 ** 3)
	// ATRIUM_MAX_BODY wins over PHP_UPLOAD_LIMIT; empty means unset.
	expect(loadLimits({ PHP_UPLOAD_LIMIT: '2G', ATRIUM_MAX_BODY: '100M' }).maxBody).toBe(100 * 1024 ** 2)
	expect(loadLimits({ PHP_UPLOAD_LIMIT: '2G', ATRIUM_MAX_BODY: '' }).maxBody).toBe(2 * 1024 ** 3)
	expect(loadLimits({ ATRIUM_MAX_BODY: '0' }).maxBody).toBe(Number.MAX_SAFE_INTEGER)
})

test('loadLimits: timeouts', () => {
	expect(loadLimits({ ATRIUM_IDLE_TIMEOUT: '255', ATRIUM_PHP_TIMEOUT: '30' })).toMatchObject({ idleTimeout: 255, phpTimeout: 30 })
	expect(() => loadLimits({ ATRIUM_IDLE_TIMEOUT: '0' })).toThrow(/ATRIUM_IDLE_TIMEOUT/)
	expect(() => loadLimits({ ATRIUM_IDLE_TIMEOUT: '256' })).toThrow(/255/)
	expect(() => loadLimits({ ATRIUM_PHP_TIMEOUT: '1.5' })).toThrow(/ATRIUM_PHP_TIMEOUT/)
	expect(() => loadLimits({ ATRIUM_MAX_BODY: 'lots' })).toThrow(/ATRIUM_MAX_BODY/)
})

// What the limits rely on in Bun itself (checked on Bun 1.4.4): a body over
// maxRequestBodySize gets 413, an idle connection is closed, and
// server.timeout(req, 0) lifts the cut for one request.
test('Bun enforces the limits the way server/index.ts expects', async () => {
	const srv = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		idleTimeout: 1,
		maxRequestBodySize: 1000,
		async fetch(req, s) {
			const path = new URL(req.url).pathname
			if (req.body) await req.arrayBuffer()
			if (path === '/lifted') s.timeout(req, 0)
			// Bun checks idle sockets every few seconds, so wait well past the 1 s.
			if (path !== '/body') await Bun.sleep(6000)
			return new Response('ok')
		},
	})
	const base = `http://127.0.0.1:${srv.port}`
	try {
		expect((await fetch(`${base}/body`, { method: 'POST', body: 'x'.repeat(500) })).status).toBe(200)
		expect((await fetch(`${base}/body`, { method: 'POST', body: 'x'.repeat(5000) })).status).toBe(413)
		// Chunked (no Content-Length) bodies are counted too.
		const chunked = new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(1000)); c.close() } })
		const r = await fetch(`${base}/body`, { method: 'POST', body: chunked }).catch(() => null)
		expect(r === null || r.status === 413).toBe(true)
		expect(await fetch(`${base}/idle`).then(() => 'answered', () => 'closed')).toBe('closed')
		expect(await (await fetch(`${base}/lifted`)).text()).toBe('ok')
	} finally {
		srv.stop(true)
	}
}, 30000)
