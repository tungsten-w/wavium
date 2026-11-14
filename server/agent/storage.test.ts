// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { folderSize, hostPlace, storageReport } from './storage'

describe('Settings > Your data', () => {
	it('reads host places: a path or a Docker volume', () => {
		expect(hostPlace('/srv/wavium/data/', '/alice/files')).toEqual({ kind: 'path', path: '/srv/wavium/data/alice/files' })
		expect(hostPlace('volume:wavium_html/data', '/alice/files')).toMatchObject({ kind: 'volume', volume: 'wavium_html', path: '/var/lib/docker/volumes/wavium_html/_data/data/alice/files' })
		expect(hostPlace('volume:wavium_db')?.path).toBe('/var/lib/docker/volumes/wavium_db/_data')
		expect(hostPlace('')).toBeUndefined()
		expect(hostPlace(undefined)).toBeUndefined()
	})

	it('counts a folder, and stops on very big ones', async () => {
		const d = mkdtempSync(join(tmpdir(), 'wv-size-'))
		mkdirSync(join(d, 'a/b'), { recursive: true })
		writeFileSync(join(d, 'one'), 'x'.repeat(100))
		writeFileSync(join(d, 'a/b/two'), 'y'.repeat(50))
		expect(await folderSize(d)).toEqual({ bytes: 150, partial: false })
		expect((await folderSize(d, 2))?.partial).toBe(true)
		expect(await folderSize(join(d, 'missing'))).toBeNull()
	})

	it("lists the user's places, with host paths and sizes", async () => {
		const data = mkdtempSync(join(tmpdir(), 'wv-data-'))
		mkdirSync(join(data, 'alice/files/Notes'), { recursive: true })
		writeFileSync(join(data, 'alice/files/Notes/a.md'), '# hi')
		const r = await storageReport({ uid: 'alice', datadirectory: data, dbtype: 'pgsql', dbname: 'wavium', prefix: 'oc_', env: { ATRIUM_HOST_DATA: '/home/me/wavium/data', ATRIUM_HOST_DB: 'volume:wavium_db' } })
		const files = r.items.find((i) => i.id === 'files')!
		expect(files.container).toBe(join(data, 'alice/files'))
		expect(files.host?.path).toBe('/home/me/wavium/data/alice/files')
		expect(files.bytes).toBe(4)
		expect(r.items.find((i) => i.id === 'mail')?.tables).toContain('oc_mail_messages')
		expect(r.database).toMatchObject({ type: 'PostgreSQL', name: 'wavium', host: { kind: 'volume', volume: 'wavium_db' } })
	})

	it('hides host paths in the public demo', async () => {
		const r = await storageReport({ uid: 'bob', datadirectory: '/nope', dbtype: 'pgsql', dbname: 'x', prefix: 'oc_', sizes: false, env: { ATRIUM_PUBLIC_DEMO: '1', ATRIUM_HOST_DATA: '/home/secret/data', ATRIUM_HOST_DB: '/home/secret/db' } })
		expect(JSON.stringify(r)).not.toContain('/home/secret')
		expect(r.notes[0]).toContain('Public demo')
	})

	it('refuses odd user ids (they end up in paths)', async () => {
		await expect(storageReport({ uid: '../admin', datadirectory: '/d', dbtype: 'pgsql', dbname: 'x', prefix: 'oc_', sizes: false, env: {} })).rejects.toThrow()
	})
})
