// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal FastCGI responder client (one request per connection, like nginx
// without keepalive). Streams the request body to PHP-FPM and the response
// back, with backpressure in both directions.
import net from 'node:net'

const VERSION = 1
const BEGIN_REQUEST = 1
const END_REQUEST = 3
const PARAMS = 4
const STDIN = 5
const STDOUT = 6
const STDERR = 7
const RESPONDER = 1
const MAX_CONTENT = 0xffff
const REQUEST_ID = 1

function record(type: number, content: Uint8Array = new Uint8Array(0)): Buffer {
	const padding = (8 - (content.length % 8)) % 8
	const buf = Buffer.alloc(8 + content.length + padding)
	buf[0] = VERSION
	buf[1] = type
	buf.writeUInt16BE(REQUEST_ID, 2)
	buf.writeUInt16BE(content.length, 4)
	buf[6] = padding
	content.length && buf.set(content, 8)
	return buf
}

function* chunked(type: number, data: Uint8Array): Generator<Buffer> {
	for (let i = 0; i < data.length; i += MAX_CONTENT) {
		yield record(type, data.subarray(i, i + MAX_CONTENT))
	}
}

function lengthBytes(n: number): Buffer {
	if (n < 128) return Buffer.from([n])
	const b = Buffer.alloc(4)
	b.writeUInt32BE((n | 0x80000000) >>> 0)
	return b
}

export function encodeParams(params: Record<string, string>): Buffer {
	const parts: Buffer[] = []
	for (const [k, v] of Object.entries(params)) {
		const key = Buffer.from(k)
		const value = Buffer.from(v)
		parts.push(lengthBytes(key.length), lengthBytes(value.length), key, value)
	}
	return Buffer.concat(parts)
}

export interface FastCgiTarget {
	host: string
	port: number
}

export interface FastCgiResponse {
	status: number
	headers: Headers
	body: ReadableStream<Uint8Array>
}

/** Sends one request; resolves once PHP has sent its headers. */
export function fastcgi(
	target: FastCgiTarget,
	params: Record<string, string>,
	body: ReadableStream<Uint8Array> | null,
	onStderr: (line: string) => void = (l) => console.error(`php: ${l}`),
): Promise<FastCgiResponse> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(target)
		let pending: Buffer = Buffer.alloc(0)
		let headerBuf = Buffer.alloc(0)
		let headersDone = false
		let controller!: ReadableStreamDefaultController<Uint8Array>
		let finished = false

		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c
			},
			pull() {
				socket.resume()
			},
			cancel() {
				finished = true
				socket.destroy()
			},
		}, { highWaterMark: 4 })

		const push = (data: Uint8Array) => {
			if (finished || !data.length) return
			controller.enqueue(data)
			if ((controller.desiredSize ?? 1) <= 0) socket.pause()
		}

		const finish = (err?: Error) => {
			if (finished) return
			finished = true
			if (!headersDone) {
				// PHP ended (or died) before sending a header block.
				if (err) return reject(err)
				headersDone = true
				resolve(parseHeaders(headerBuf, stream))
			}
			try {
				err ? controller.error(err) : controller.close()
			} catch {}
		}

		const onStdout = (data: Buffer) => {
			if (headersDone) return push(data)
			headerBuf = Buffer.concat([headerBuf, data])
			let end = headerBuf.indexOf('\r\n\r\n')
			let sep = 4
			if (end < 0) {
				end = headerBuf.indexOf('\n\n')
				sep = 2
			}
			if (end < 0) return
			headersDone = true
			const head = headerBuf.subarray(0, end)
			const rest = headerBuf.subarray(end + sep)
			resolve(parseHeaders(head, stream))
			push(rest)
		}

		socket.on('data', (chunk: Buffer) => {
			pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
			while (pending.length >= 8) {
				const len = pending.readUInt16BE(4)
				const total = 8 + len + pending[6]
				if (pending.length < total) break
				const type = pending[1]
				const content = pending.subarray(8, 8 + len)
				if (type === STDOUT) onStdout(Buffer.from(content))
				else if (type === STDERR) {
					for (const line of content.toString().split('\n')) if (line.trim()) onStderr(line)
				} else if (type === END_REQUEST) finish()
				pending = pending.subarray(total)
			}
		})
		socket.on('error', (e) => finish(e))
		socket.on('close', () => finish())

		socket.on('connect', async () => {
			const begin = Buffer.alloc(8)
			begin.writeUInt16BE(RESPONDER, 0)
			begin[2] = 0 // do not keep the connection
			socket.write(record(BEGIN_REQUEST, begin))
			for (const r of chunked(PARAMS, encodeParams(params))) socket.write(r)
			socket.write(record(PARAMS))
			try {
				if (body) {
					const reader = body.getReader()
					for (;;) {
						const { done, value } = await reader.read()
						if (done) break
						for (const r of chunked(STDIN, value)) {
							if (!socket.write(r)) await new Promise((ok) => socket.once('drain', ok))
						}
					}
				}
				socket.write(record(STDIN))
			} catch (e) {
				socket.destroy(e as Error)
			}
		})
	})
}

function parseHeaders(head: Buffer, body: ReadableStream<Uint8Array>): FastCgiResponse {
	const headers = new Headers()
	let status = 200
	for (const line of head.toString('latin1').split(/\r?\n/)) {
		const i = line.indexOf(':')
		if (i <= 0) continue
		const name = line.slice(0, i).trim()
		const value = line.slice(i + 1).trim()
		if (name.toLowerCase() === 'status') status = parseInt(value, 10) || 200
		else headers.append(name, value)
	}
	if (status === 200 && headers.has('location')) status = 302
	return { status, headers, body }
}
