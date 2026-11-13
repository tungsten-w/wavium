// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Chunked request bodies (Transfer-Encoding: chunked, no Content-Length):
// FastCGI/PHP need the length up front, so the body has to be read in full
// first (nginx does the same). Small bodies stay in memory; past `memLimit` the
// body goes to a temp file on disk, so a multi-GB upload never sits in RAM.
//
// ATRIUM_UPLOAD_TMP picks the directory (default: the OS temp dir). It must be
// on disk, not a tmpfs, or the "file" is RAM again.
import { open, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Spooled {
	length: number
	stream: () => ReadableStream<Uint8Array>
	/** Removes the temp file (if any). Safe to call more than once. */
	cleanup: () => Promise<void>
	/** True when the body went to disk. */
	onDisk: boolean
}

export const SPOOL_MEMORY_LIMIT = 1024 * 1024

export async function spoolBody(
	body: ReadableStream<Uint8Array>,
	opts: { dir?: string, memLimit?: number, maxBytes?: number } = {},
): Promise<Spooled> {
	const memLimit = opts.memLimit ?? SPOOL_MEMORY_LIMIT
	const maxBytes = opts.maxBytes ?? Number.MAX_SAFE_INTEGER
	const reader = body.getReader()
	const parts: Uint8Array[] = []
	let length = 0
	let file: Awaited<ReturnType<typeof open>> | null = null
	let tmp: string | null = null
	const cleanup = async () => {
		const dir = tmp
		tmp = null
		if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
	}
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			length += value.length
			if (length > maxBytes) throw new BodyTooLarge(maxBytes)
			if (!file && length > memLimit) {
				// Past the memory limit: move what we have to a private temp file.
				tmp = await mkdtemp(join(opts.dir ?? process.env.ATRIUM_UPLOAD_TMP ?? tmpdir(), 'atrium-upload-'))
				file = await open(join(tmp, 'body'), 'w+', 0o600)
				for (const p of parts) await file.write(p)
				parts.length = 0
			}
			if (file) await file.write(value)
			else parts.push(value)
		}
	} catch (e) {
		reader.cancel().catch(() => {})
		await file?.close().catch(() => {})
		await cleanup()
		throw e
	}
	if (!file) {
		const buf = concat(parts, length)
		return { length, onDisk: false, stream: () => new Blob([buf]).stream(), cleanup: async () => {} }
	}
	await file.close()
	const path = join(tmp!, 'body')
	return { length, onDisk: true, stream: () => Bun.file(path).stream(), cleanup }
}

export class BodyTooLarge extends Error {
	constructor(readonly limit: number) {
		super(`request body larger than ${limit} bytes`)
	}
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
	if (parts.length === 1) return parts[0]
	const out = new Uint8Array(length)
	let at = 0
	for (const p of parts) {
		out.set(p, at)
		at += p.length
	}
	return out
}
