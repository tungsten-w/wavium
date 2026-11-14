// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Your data (v4): where each kind of the user's data is stored, on
// this machine, and how much of it there is.
//
//   GET /agent/v1/storage     for the logged-in user (owner session)
//
// Paths: inside the container (what Wavium sees) and on the host (what the
// person who runs it sees), from ATRIUM_HOST_DATA / ATRIUM_HOST_DB: a path, or
// volume:<name>[/<folder>] for a Docker named volume. The public demo shows
// container paths only (the host's layout is nobody's business there).
import { readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentModule, LayerCore } from './index'

export interface HostPlace { kind: 'path' | 'volume' | 'container', path: string, volume?: string, hint?: string }

export interface StorageItem {
	id: string
	label: string
	what: string
	where: 'disk' | 'database'
	container?: string
	host?: HostPlace
	tables?: string[]
	bytes?: number
	/** True when the count stopped early (very big folder): bytes is a lower bound. */
	partial?: boolean
}

export interface StorageReport {
	uid: string
	items: StorageItem[]
	database: { type: string, name: string, host?: HostPlace }
	notes: string[]
}

/** volume:<name>[/<sub>] or a plain path -> what to show for the host side. */
export function hostPlace(raw: string | undefined, sub = ''): HostPlace | undefined {
	const v = (raw ?? '').trim()
	if (!v) return undefined
	const m = /^volume:([\w.-]+)(\/.*)?$/.exec(v)
	if (m) {
		const inner = `${m[2] ?? ''}${sub}`.replace(/\/+/g, '/')
		return { kind: 'volume', volume: m[1], path: `/var/lib/docker/volumes/${m[1]}/_data${inner}`, hint: `Docker volume ${m[1]} (the path is where Docker keeps it on Linux)` }
	}
	return { kind: 'path', path: `${v.replace(/\/+$/, '')}${sub}` }
}

/** Size of a folder, stopping after `limit` entries. Symlinks are not followed. */
export async function folderSize(dir: string, limit = 20_000): Promise<{ bytes: number, partial: boolean } | null> {
	let bytes = 0
	let seen = 0
	const stack = [dir]
	try { await lstat(dir) } catch { return null }
	while (stack.length) {
		const d = stack.pop()!
		let entries
		try { entries = await readdir(d, { withFileTypes: true }) } catch { continue }
		for (const e of entries) {
			if (++seen > limit) return { bytes, partial: true }
			const p = join(d, e.name)
			if (e.isDirectory()) stack.push(p)
			else if (e.isFile()) { try { bytes += (await lstat(p)).size } catch { /* gone meanwhile */ } }
		}
	}
	return { bytes, partial: false }
}

const SAFE_UID = /^[\w.@+-]{1,64}$/

export async function storageReport(opts: { uid: string, datadirectory: string, dbtype: string, dbname: string, prefix: string, env: Record<string, string | undefined>, sizes?: boolean }): Promise<StorageReport> {
	const { uid, datadirectory, env } = opts
	if (!SAFE_UID.test(uid)) throw new Error('unexpected user id')
	const demo = env.ATRIUM_PUBLIC_DEMO === '1'
	const host = (sub: string) => demo ? undefined : hostPlace(env.ATRIUM_HOST_DATA, sub)
	const p = opts.prefix
	const disk = (id: string, label: string, what: string, folder: string): StorageItem => ({
		id, label, what, where: 'disk', container: join(datadirectory, uid, folder), host: host(`/${uid}/${folder}`),
	})
	const db = (id: string, label: string, what: string, tables: string[]): StorageItem => ({ id, label, what, where: 'database', tables: tables.map((t) => p + t) })

	const items: StorageItem[] = [
		disk('files', 'Files', 'Everything in Files, as normal files and folders. Notes are Markdown files in its Notes folder.', 'files'),
		disk('versions', 'Older versions of files', 'Kept when a file changes, removed as space runs low.', 'files_versions'),
		disk('trash', 'Deleted files', 'Files you deleted, until the trash is emptied.', 'files_trashbin'),
		db('mail', 'Mail', 'Every mail Wavium copied (text, never attachments in bulk), its classification, and the attachments you downloaded. Never deleted, even when gone from the mail server.', ['mail_messages', 'mail_bodies', 'mail_triage', 'mail_accounts']),
		db('calendar', 'Calendar and tasks', 'Events and tasks (CalDAV).', ['calendarobjects', 'calendars']),
		db('contacts', 'Contacts', 'Address books (CardDAV).', ['cards', 'addressbooks']),
		db('todo', 'Daily Todo', 'Your lists and their history.', ['daily_todo_items']),
		db('agents', 'Agents and AI', 'Agents, their permissions and activity, approvals, AI providers. API keys are encrypted.', ['atrium_agents', 'atrium_agent_access', 'atrium_agent_events', 'atrium_agent_approvals', 'atrium_ai_providers']),
	]

	if (opts.sizes !== false) {
		await Promise.all(items.filter((i) => i.where === 'disk').map(async (i) => {
			const s = await folderSize(i.container!)
			if (s) { i.bytes = s.bytes; if (s.partial) i.partial = true }
		}))
	}

	const notes = [
		'Nothing leaves this machine unless you ask: an AI provider gets only what a feature sends it (Settings > AI), a mail server gets what you send.',
		'Backups are up to whoever runs Wavium (make backup, or a copy of both places above).',
	]
	if (opts.dbtype === 'sqlite3') notes.unshift('The database is a single file in the data folder.')
	if (demo) notes.unshift('Public demo: paths on the host are hidden, and everything is reset every night.')

	return {
		uid,
		items,
		database: { type: opts.dbtype === 'pgsql' ? 'PostgreSQL' : opts.dbtype === 'sqlite3' ? 'SQLite' : opts.dbtype, name: opts.dbname, host: demo ? undefined : hostPlace(env.ATRIUM_HOST_DB) },
		notes,
	}
}

export function storageModule(env: Record<string, string | undefined> = process.env): AgentModule {
	const cache = new Map<string, { at: number, report: StorageReport }>()
	return {
		tools: () => [],
		async route(core: LayerCore, req: Request, _url: URL, path: string) {
			if (path !== '/agent/v1/storage') return null
			if (req.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
			const who = await core.auth.owner(req)
			const hit = cache.get(who.uid)
			if (hit && Date.now() - hit.at < 60_000) return Response.json(hit.report)
			const report = await storageReport({ uid: who.uid, datadirectory: core.cfg.datadirectory, dbtype: core.cfg.dbtype, dbname: core.cfg.dbname, prefix: core.cfg.dbtableprefix, env })
			cache.set(who.uid, { at: Date.now(), report })
			return Response.json(report)
		},
	}
}
