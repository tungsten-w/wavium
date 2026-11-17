// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, test } from 'vitest'
import { fakeServer, type FakeServer } from '../testing/fakeServer'
import { splitBySize, uploadLimit } from './index'

let server: FakeServer | null = null
afterEach(() => { server?.restore(); server = null })

test('files too big for the server are told apart before uploading (V4-1)', () => {
	const files = [{ name: 'a', size: 10 }, { name: 'b', size: 30 }]
	expect(splitBySize(files, 20)).toEqual({ ok: [files[0]], tooBig: [files[1]] })
	expect(splitBySize(files, null)).toEqual({ ok: files, tooBig: [] })
})

test('the limit comes from the server once', async () => {
	server = fakeServer().on('GET', '/core/web/dist/limits.json', () => Response.json({ max_upload: 1024 }))
	expect(await uploadLimit()).toBe(1024)
	expect(await uploadLimit()).toBe(1024)
	expect(server.calls('GET', '/core/web/dist/limits.json').length).toBe(1)
})
