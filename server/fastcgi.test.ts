// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import { fastcgi } from './fastcgi'
import { fakeFpm } from './testing/fake-fpm'

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
