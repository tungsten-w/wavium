// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test helper: a fake PHP-FPM server.
import net from 'node:net'

/**
 * A fake PHP-FPM: reads the FastCGI records, counts the STDIN bytes and, once
 * the empty STDIN record ends the body, answers "<n> bytes" and END_REQUEST.
 * `delayMs` simulates a slow PHP script. `headersFirst` sends the response
 * headers as soon as the params are in, before reading the body (PHP may do
 * that), and the "<n> bytes" text once the body is done.
 */
export function fakeFpm(opts: { delayMs?: number, headersFirst?: boolean } = {}) {
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
				if (type === 4 && len === 0 && opts.headersFirst) sock.write(rec(6, Buffer.from('Status: 200 OK\r\nContent-Type: text/plain\r\n\r\n')))
				if (type === 5 && len > 0) stdin += len
				if (type === 5 && len === 0) {
					seen.push({ stdinBytes: stdin, params: decodeParams(paramBytes) })
					const reply = () => {
						const head = opts.headersFirst ? '' : 'Status: 200 OK\r\nContent-Type: text/plain\r\n\r\n'
						const out = Buffer.from(`${head}${stdin} bytes`)
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
