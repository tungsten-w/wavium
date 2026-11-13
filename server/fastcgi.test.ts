// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import net from 'node:net'
import { fastcgi } from './fastcgi'

/**
 * A fake PHP-FPM: reads the FastCGI records, counts the STDIN bytes and, once
 * the empty STDIN record ends the body, answers "<n> bytes" and END_REQUEST.
 * `delayMs` simulates a slow PHP script.
 */
export function fakeFpm(opts: { delayMs?: number } = {}) {
	const seen: { stdinBytes: number, params: Record<string, string> }[] = []
	const server = net.createServer((sock) => {
		let buf = Buffer.alloc(0)
		let stdin = 0
		let paramBytes = Buffer.alloc(0)
		sock.on('data', (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk])
			while (buf.length >= 8) {
				const len = buf.readUInt16BE(4)
				const total = 8 + len + buf[6]
				if (buf.length < total) break
				const type = buf[1]
				const content = buf.subarray(8, 8 + len)
				buf = buf.subarray(total)
				if (type === 4) paramBytes = Buffer.concat([paramBytes, content])
				if (type === 5 && len > 0) stdin += len
				if (type === 5 && len === 0) {
					seen.push({ stdinBytes: stdin, params: decodeParams(paramBytes) })
					const reply = () => {
						const out = Buffer.from(`Status: 200 OK\r\nContent-Type: text/plain\r\n\r\n${stdin} bytes`)
						sock.write(rec(6, out))
						sock.write(rec(3, Buffer.alloc(8)))
						sock.end()
					}
					opts.delayMs ? setTimeout(reply, opts.delayMs) : reply()
				}
			}
		})
		sock.on('error', () => {})
	})
	server.listen(0, '127.0.0.1')
	return {
		seen,
		target: () => ({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port }),
		ready: new Promise<void>((ok) => server.once('listening', () => ok())),
		close: () => server.close(),
	}
}

function rec(type: number, content: Buffer): Buffer {
	const head = Buffer.from([1, type, 0, 1, 0, 0, 0, 0])
	head.writeUInt16BE(content.length, 4)
	return Buffer.concat([head, content])
}

function decodeParams(b: Buffer): Record<string, string> {
	const out: Record<string, string> = {}
	let i = 0
	const len = () => {
		if (b[i] < 128) return b[i++]
		const n = b.readUInt32BE(i) & 0x7fffffff
		i += 4
		return n
	}
	while (i < b.length) {
		const k = len(), v = len()
		out[b.subarray(i, i + k).toString()] = b.subarray(i + k, i + k + v).toString()
		i += k + v
	}
	return out
}

test('streams the body and reports when it is fully sent', async () => {
	const fpm = fakeFpm({ delayMs: 200 })
	await fpm.ready
	try {
		const events: string[] = []
		const size = 300_000
		const body = new ReadableStream<Uint8Array>({
			start(c) { for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(size / 3)); c.close() },
		})
		const res = await fastcgi(fpm.target(), { CONTENT_LENGTH: String(size) }, body, () => {}, () => events.push('body sent'))
		events.push('headers')
		expect(res.status).toBe(200)
		expect(await new Response(res.body).text()).toBe(`${size} bytes`)
		// The body was done before PHP answered (PHP waits 200 ms after the body).
		expect(events).toEqual(['body sent', 'headers'])
		expect(fpm.seen[0].stdinBytes).toBe(size)
		expect(fpm.seen[0].params.CONTENT_LENGTH).toBe(String(size))
	} finally {
		fpm.close()
	}
})

test('without a body, "sent" fires right away', async () => {
	const fpm = fakeFpm()
	await fpm.ready
	try {
		let sent = 0
		const res = await fastcgi(fpm.target(), {}, null, () => {}, () => sent++)
		expect(await new Response(res.body).text()).toBe('0 bytes')
		expect(sent).toBe(1)
	} finally {
		fpm.close()
	}
})
