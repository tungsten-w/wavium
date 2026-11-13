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

export async function* readSse(body: ReadableStream<Uint8Array>, onChunk?: () => void): AsyncGenerator<SseEvent> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buf = ''
	let event = ''
	let data: string[] = []
	const flush = (): SseEvent | null => {
		const out = data.length ? { event: event || 'message', data: data.join('\n') } : null
		event = ''
		data = []
		return out
	}
	const line = (l: string): SseEvent | null => {
		if (l === '') return flush()
		if (l.startsWith(':')) return null
		const i = l.indexOf(':')
		const field = i < 0 ? l : l.slice(0, i)
		let value = i < 0 ? '' : l.slice(i + 1)
		if (value.startsWith(' ')) value = value.slice(1)
		if (field === 'data') data.push(value)
		else if (field === 'event') event = value
		return null
	}
	try {
		for (;;) {
			const { done, value } = await reader.read()
			buf += done ? decoder.decode() : decoder.decode(value, { stream: true })
			if (!done) onChunk?.()
			// A trailing "\r" may be the first half of "\r\n": wait for the next chunk.
			const cut = done ? buf.length : buf.endsWith('\r') ? buf.length - 1 : buf.length
			const lines = buf.slice(0, cut).split(/\r\n|\r|\n/)
			buf = lines.pop()! + buf.slice(cut)
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
