// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Server-sent events reader shared by every provider. Network chunks can end
// anywhere (mid-line, mid-UTF-8 char, between "\r" and "\n"), so it buffers
// and only parses whole lines.

export interface SseEvent {
	/** "message" when the server sent no `event:` line. */
	event: string
	data: string
}

export interface SseOptions {
	/** Called around each network read: the idle timeout only runs while we wait for the server. */
	beforeRead?: () => void
	afterRead?: () => void
	/** Max size of one event (a base URL is user-set: a server must not make us buffer forever). */
	maxEventChars?: number
}

export const MAX_EVENT_CHARS = 1 << 20

/** Thrown when a server sends a line or event over the limit. */
export class SseLimitError extends RangeError {
	name = 'SseLimitError'
}

export async function* readSse(body: ReadableStream<Uint8Array>, opts: SseOptions = {}): AsyncGenerator<SseEvent> {
	const max = opts.maxEventChars ?? MAX_EVENT_CHARS
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buf = ''
	let event = ''
	let data: string[] = []
	let size = 0
	const flush = (): SseEvent | null => {
		const out = data.length ? { event: event || 'message', data: data.join('\n') } : null
		event = ''
		data = []
		size = 0
		return out
	}
	const line = (l: string): SseEvent | null => {
		if (l === '') return flush()
		if (l.startsWith(':')) return null
		const i = l.indexOf(':')
		const field = i < 0 ? l : l.slice(0, i)
		let value = i < 0 ? '' : l.slice(i + 1)
		if (value.startsWith(' ')) value = value.slice(1)
		if (field === 'data') {
			size += value.length
			if (size > max) throw new SseLimitError(`stream event over ${max} characters`)
			data.push(value)
		} else if (field === 'event') event = value
		return null
	}
	try {
		for (;;) {
			opts.beforeRead?.()
			const { done, value } = await reader.read()
			opts.afterRead?.()
			buf += done ? decoder.decode() : decoder.decode(value, { stream: true })
			// A trailing "\r" may be the first half of "\r\n": wait for the next chunk.
			const cut = done ? buf.length : buf.endsWith('\r') ? buf.length - 1 : buf.length
			const lines = buf.slice(0, cut).split(/\r\n|\r|\n/)
			buf = lines.pop()! + buf.slice(cut)
			if (buf.length > max) throw new SseLimitError(`stream line over ${max} characters`)
			for (const l of lines) {
				const ev = line(l)
				if (ev) yield ev
			}
			if (done) {
				// Be lenient with servers that close without the final blank line.
				if (buf) line(buf)
				const ev = flush()
				if (ev) yield ev
				return
			}
		}
	} finally {
		reader.releaseLock()
	}
}
