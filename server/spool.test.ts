// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Chunked uploads (P1-2). The big test (> 2 GB through the real server path)
// runs only with ATRIUM_BIG_TESTS=1; point ATRIUM_UPLOAD_TMP at a disk (not a
// tmpfs) for it:
//   ATRIUM_BIG_TESTS=1 ATRIUM_UPLOAD_TMP=/var/tmp bun test server/spool.test.ts
import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { servePhp, type PhpTarget } from './php'
import { BodyTooLarge, spoolBody } from './spool'
import { fakeFpm } from './testing/fake-fpm'

/** A body of `total` bytes in `chunk`-sized pieces, generated on demand. */
function generated(total: number, chunk = 64 * 1024): ReadableStream<Uint8Array> {
	let left = total
	const piece = new Uint8Array(chunk).fill(97)
	return new ReadableStream({
		pull(c) {
			if (left <= 0) return c.close()
			const n = Math.min(chunk, left)
			left -= n
			c.enqueue(n === chunk ? piece.slice() : piece.slice(0, n))
		},
	}, { highWaterMark: 0 })
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(process.env.ATRIUM_UPLOAD_TMP ?? tmpdir(), 'spool-test-'))
	try {
		return await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

test('small bodies stay in memory', async () => {
	await withDir(async (dir) => {
		const s = await spoolBody(new Blob(['hello ', 'world']).stream(), { dir, memLimit: 100 })
		expect(s.onDisk).toBe(false)
		expect(s.length).toBe(11)
		expect(await new Response(s.stream()).text()).toBe('hello world')
		expect(await readdir(dir)).toEqual([])
	})
})

test('big bodies go to a temp file, removed by cleanup', async () => {
	await withDir(async (dir) => {
		const s = await spoolBody(generated(300_000, 10_000), { dir, memLimit: 50_000 })
		expect(s.onDisk).toBe(true)
		expect(s.length).toBe(300_000)
		expect((await readdir(dir)).length).toBe(1)
		const back = new Uint8Array(await new Response(s.stream()).arrayBuffer())
		expect(back.length).toBe(300_000)
		expect(back.every((b) => b === 97)).toBe(true)
		await s.cleanup()
		await s.cleanup()
		expect(await readdir(dir)).toEqual([])
	})
})

test('over maxBytes: refused, nothing left on disk', async () => {
	await withDir(async (dir) => {
		await expect(spoolBody(generated(200_000, 10_000), { dir, memLimit: 50_000, maxBytes: 150_000 })).rejects.toBeInstanceOf(BodyTooLarge)
		expect(await readdir(dir)).toEqual([])
	})
})

test('a client that breaks off mid-upload leaves nothing on disk', async () => {
	await withDir(async (dir) => {
		let sent = 0
		const broken = new ReadableStream<Uint8Array>({
			pull(c) {
				if (sent++ < 10) c.enqueue(new Uint8Array(10_000))
				else c.error(new Error('client went away'))
			},
		})
		await expect(spoolBody(broken, { dir, memLimit: 50_000 })).rejects.toThrow('client went away')
		expect(await readdir(dir)).toEqual([])
	})
})

/** The real path: Bun.serve -> servePhp -> FastCGI -> (fake) PHP-FPM. */
async function uploadThroughServer(size: number, fpmOpts: { headersFirst?: boolean } = {}) {
	return withDir(async (dir) => {
		const fpm = fakeFpm(fpmOpts)
		await fpm.ready
		const before = process.env.ATRIUM_UPLOAD_TMP
		process.env.ATRIUM_UPLOAD_TMP = dir
		const php: PhpTarget = { fpm: fpm.target(), docroot: '/var/www/html', port: 0 }
		let peakRss = process.memoryUsage().rss
		const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 50)
		const srv = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			maxRequestBodySize: Number.MAX_SAFE_INTEGER,
			// As in server/index.ts: idle cut while the client sends, lifted after.
			idleTimeout: 5,
			fetch: (req, s) => servePhp(php, req, new URL(req.url), '/remote.php', '/dav/files/alice/big.bin', '127.0.0.1', { onBodySent: () => s.timeout(req, 0) }),
		})
		const startRss = process.memoryUsage().rss
		try {
			// A ReadableStream body without a length: fetch sends it chunked.
			const res = await fetch(`http://127.0.0.1:${srv.port}/remote.php/dav/files/alice/big.bin`, { method: 'PUT', body: generated(size) })
			const text = await res.text()
			// The temp file is removed in the background: give it a few seconds.
			let left = await readdir(dir)
			for (let i = 0; left.length && i < 100; i++) {
				await Bun.sleep(100)
				left = await readdir(dir)
			}
			return { status: res.status, text, seen: fpm.seen, left, growth: peakRss - startRss }
		} finally {
			clearInterval(sampler)
			srv.stop(true)
			fpm.close()
			if (before === undefined) delete process.env.ATRIUM_UPLOAD_TMP
			else process.env.ATRIUM_UPLOAD_TMP = before
		}
	})
}

test('chunked upload through the server: PHP gets the length and every byte', async () => {
	const size = 20 * 1024 * 1024
	const r = await uploadThroughServer(size)
	expect(r.status).toBe(200)
	expect(r.text).toBe(`${size} bytes`)
	expect(r.seen[0].params.CONTENT_LENGTH).toBe(String(size))
	expect(r.seen[0].params.REQUEST_METHOD).toBe('PUT')
	expect(r.left).toEqual([])
}, 60_000)

test('PHP answering before it read the body still gets all of it', async () => {
	const size = 5 * 1024 * 1024
	const r = await uploadThroughServer(size, { headersFirst: true })
	expect(r.status).toBe(200)
	expect(r.text).toBe(`${size} bytes`)
	expect(r.left).toEqual([])
}, 60_000)

test.if(process.env.ATRIUM_BIG_TESTS === '1')('a 2.5 GB chunked upload does not fill the memory', async () => {
	const size = 2.5 * 1024 ** 3
	const r = await uploadThroughServer(size)
	expect(r.status).toBe(200)
	expect(r.text).toBe(`${size} bytes`)
	expect(r.left).toEqual([])
	console.log(`2.5 GB upload: RSS grew by ${Math.round(r.growth / 1024 ** 2)} MB`)
	// Before P1-2 the whole body was buffered: the growth was > 2.5 GB.
	expect(r.growth).toBeLessThan(400 * 1024 ** 2)
}, 900_000)
