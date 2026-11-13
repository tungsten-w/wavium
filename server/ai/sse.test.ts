// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import { readSse } from './sse'
import { chunked, collect } from './testkit'

const text = 'event: a\ndata: {"x":"é€"}\n\n: comment\ndata: line1\ndata: line2\n\nevent: b\ndata:no-space\n\n'

test('sse: events, multi-line data, comments, every chunk size', async () => {
	for (const size of [1, 2, 3, 5, 64, 4096]) {
		const evs = await collect(readSse(chunked(text, size)))
		expect(evs).toEqual([
			{ event: 'a', data: '{"x":"é€"}' },
			{ event: 'message', data: 'line1\nline2' },
			{ event: 'b', data: 'no-space' },
		])
	}
})

test('sse: \\r\\n and lone \\r line endings, split between \\r and \\n', async () => {
	for (const eol of ['\r\n', '\r']) {
		for (const size of [1, 2, 3, 4]) {
			const evs = await collect(readSse(chunked(text.replaceAll('\n', eol), size)))
			expect(evs.map((e) => e.data)).toEqual(['{"x":"é€"}', 'line1\nline2', 'no-space'])
		}
	}
})

test('sse: last event without a blank line is still delivered, onChunk is called', async () => {
	let n = 0
	const evs = await collect(readSse(chunked('data: 1\n\ndata: 2', 3), () => n++))
	expect(evs.map((e) => e.data)).toEqual(['1', '2'])
	expect(n).toBeGreaterThan(2)
})
