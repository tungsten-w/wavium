// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import { readSse, SseLimitError } from './sse'
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

test('sse: last event without a blank line is still delivered, read hooks bracket each read', async () => {
	const log: string[] = []
	const evs = await collect(readSse(chunked('data: 1\n\ndata: 2', 3), { beforeRead: () => log.push('('), afterRead: () => log.push(')') }))
	expect(evs.map((e) => e.data)).toEqual(['1', '2'])
	expect(log.length).toBeGreaterThan(4)
	expect(log.join('')).toBe('()'.repeat(log.length / 2))
})

test('sse: a line or an event over the limit throws SseLimitError instead of buffering forever', async () => {
	const long = 'data: ' + 'x'.repeat(100)
	expect(await collect(readSse(chunked(long, 7), { maxEventChars: 50 })).catch((e) => e)).toBeInstanceOf(SseLimitError)
	const many = Array.from({ length: 20 }, () => 'data: 12345\n').join('') + '\n'
	expect(await collect(readSse(chunked(many, 64), { maxEventChars: 50 })).catch((e) => e)).toBeInstanceOf(SseLimitError)
	expect(await collect(readSse(chunked('data: ok\n\n'), { maxEventChars: 50 }))).toEqual([{ event: 'message', data: 'ok' }])
})
