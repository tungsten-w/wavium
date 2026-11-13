// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Files tools (PLAN P3-4, area `files`): browse, search, read, write, move,
// delete (to the trash bin) and share. The work is done by PHP
// (apps/files/lib/Controller/AtriumAgentController.php) as the user, so
// versions, trash bin, activity, quotas and sharing rules apply as usual.
//
// Gated actions ask the owner by default: delete (files:delete) and every
// sharing change (files:share). Approval requests are void if the item
// changed (delete) or disappeared (share) before the owner said yes.
// Public links are created without a password: a password would sit in the
// approval log; set one in the Files app if needed.
import type { AgentModule, LayerCore } from '../index'
import { boolean, int, obj, str } from '../schema'
import type { Tool, ToolCtx } from '../tools'
import { AgentError, iso } from '../util'

export interface PhpNode {
	file_id: number
	path: string
	name: string
	type: 'file' | 'folder'
	mime: string | null
	size: number
	modified: number
	etag: string
	can: { write: boolean, delete: boolean, share: boolean }
	shared_with_me: boolean
}

export interface PhpShare {
	share_id: string
	type: 'user' | 'group' | 'link' | 'email' | 'other'
	with: string | null
	path: string | null
	file_id: number
	permission: 'read' | 'edit'
	expires: string | null
	has_password: boolean
	url: string | null
	note: string | null
}

export interface Target { path?: string, file_id?: number }

/** The PHP side. Each call acts as `uid` (the grantor). */
export interface FilesBridge {
	call<T>(uid: string, op: string, body: Record<string, unknown>): Promise<T>
}

export function phpFiles(core: Pick<LayerCore, 'php'>): FilesBridge {
	return { call: (uid, op, body) => core.php.app('POST', `apps/files/api/atrium-agent/${op}`, { body: { uid, ...body } }) }
}

export function nodeView(n: PhpNode) {
	return { ...n, modified: iso(n.modified) }
}

const target = {
	path: str('Path from the home folder, e.g. "/Documents/report.md"', { maxLength: 4000 }),
	file_id: int('Or the file_id from another call', { minimum: 1 }),
}

/** path or file_id, exactly one (the root needs path "/"). */
function targetOf(input: Record<string, unknown>): Target {
	const hasPath = typeof input.path === 'string'
	const hasId = input.file_id !== undefined
	if (hasPath === hasId) throw new AgentError('invalid_input', 'Give either path or file_id')
	return hasPath ? { path: String(input.path) } : { file_id: Number(input.file_id) }
}

export function filesTools(bridge: FilesBridge): Tool[] {
	const stat = (ctx: ToolCtx, t: Target) => bridge.call<PhpNode>(ctx.grantor, 'stat', { ...t })
	const exists = async (ctx: ToolCtx, t: Target) => {
		try {
			return await stat(ctx, t)
		} catch (e) {
			if (e instanceof AgentError && e.code === 'not_found') return null
			throw e
		}
	}
	return [
		{
			name: 'files_list',
			description: 'Content of a folder (folders first, then by name): file_id, path, name, type, mime, size, modified, etag, what the user can do (can.write/delete/share), shared_with_me. Default folder: the home folder "/".',
			area: 'files',
			input: obj({ ...target, limit: int('Default 100, max 500', { minimum: 1, maximum: 500 }), cursor: str() }),
			run: async (ctx, input) => {
				const t = input.path === undefined && input.file_id === undefined ? { path: '/' } : targetOf(input)
				const offset = input.cursor === undefined ? 0 : Number(input.cursor)
				if (!Number.isInteger(offset) || offset < 0) throw new AgentError('invalid_input', 'Bad cursor')
				const limit = input.limit === undefined ? 100 : Number(input.limit)
				const r = await bridge.call<{ folder: PhpNode, entries: PhpNode[], total: number }>(ctx.grantor, 'list', { ...t, limit, offset })
				const next = offset + r.entries.length
				return { folder: nodeView(r.folder), entries: r.entries.map(nodeView), total: r.total, next_cursor: next < r.total ? String(next) : null }
			},
		},
		{
			name: 'files_search',
			description: 'Find files and folders by name (2+ characters), newest first, optionally under a folder.',
			area: 'files',
			input: obj({ query: str(undefined, { minLength: 2, maxLength: 200 }), path: target.path, limit: int('Default 50, max 200', { minimum: 1, maximum: 200 }) }, ['query']),
			run: async (ctx, input) => {
				const r = await bridge.call<{ results: PhpNode[] }>(ctx.grantor, 'search', { query: input.query, path: input.path ?? '', limit: input.limit ?? 50 })
				return { results: r.results.map(nodeView) }
			},
		},
		{
			name: 'files_get',
			description: 'Metadata of one file or folder.',
			area: 'files',
			input: obj(target),
			run: async (ctx, input) => nodeView(await stat(ctx, targetOf(input))),
		},
		{
			name: 'files_read',
			description: 'Content of a text file (UTF-8, max 2 MB), or of any file as base64 with binary: true (max 1 MB). Bigger files: WebDAV.',
			area: 'files',
			input: obj({ ...target, binary: boolean('Return base64') }),
			run: async (ctx, input) => {
				const r = await bridge.call<PhpNode & { encoding: string, content: string }>(ctx.grantor, 'read', { ...targetOf(input), binary: input.binary === true })
				return nodeView(r)
			},
		},
		{
			name: 'files_write',
			description: 'Create or overwrite a file (max 5 MB). An overwrite keeps the previous content as a version. etag: refuse if the file changed since you read it; create_only: refuse if it exists; create_parents: make missing folders.',
			area: 'files',
			action: 'write',
			input: obj({
				path: target.path,
				content: str('Text, or base64 with encoding "base64"', { maxLength: 7_000_000 }),
				encoding: str(undefined, { enum: ['text', 'base64'] }),
				etag: str(),
				create_only: boolean(),
				create_parents: boolean(),
			}, ['path', 'content']),
			run: async (ctx, input) => nodeView(await bridge.call<PhpNode>(ctx.grantor, 'write', {
				path: input.path, content: input.content, encoding: input.encoding ?? 'text',
				etag: input.etag ?? null, create_only: input.create_only === true, create_parents: input.create_parents === true,
			})),
		},
		{
			name: 'files_mkdir',
			description: 'Create a folder (and missing parents). Fine if it already exists.',
			area: 'files',
			action: 'write',
			input: obj({ path: target.path }, ['path']),
			run: async (ctx, input) => nodeView(await bridge.call<PhpNode>(ctx.grantor, 'mkdir', { path: input.path })),
		},
		{
			name: 'files_move',
			description: 'Move or rename a file or folder. Never overwrites: fails if `to` exists.',
			area: 'files',
			action: 'write',
			input: obj({ ...target, to: str('New path from the home folder', { maxLength: 4000 }) }, ['to']),
			run: async (ctx, input) => nodeView(await bridge.call<PhpNode>(ctx.grantor, 'move', { ...targetOf(input), to: input.to })),
		},
		{
			name: 'files_delete',
			description: 'Delete a file or folder (asks the owner unless allowed). It goes to the trash bin, where the owner can restore it.',
			area: 'files',
			action: 'delete',
			input: obj(target),
			prepare: async (ctx, input) => {
				const n = await stat(ctx, targetOf(input))
				const what = n.type === 'folder' ? `folder ${n.path}` : `${n.path} (${n.size} bytes)`
				return { payload: { file_id: n.file_id, etag: n.etag, path: n.path }, summary: `Delete ${what}`, ref: `file:${n.file_id}` }
			},
			stillValid: async (ctx, payload) => {
				const p = payload as { file_id: number, etag: string }
				return (await exists(ctx, { file_id: p.file_id }))?.etag === p.etag
			},
			execute: async (ctx, payload) => {
				const p = payload as { file_id: number, etag: string }
				const r = await bridge.call<{ deleted: boolean, in_trash_bin: boolean, item: PhpNode }>(ctx.grantor, 'delete', { file_id: p.file_id, etag: p.etag })
				return { deleted: r.deleted, in_trash_bin: r.in_trash_bin, item: nodeView(r.item) }
			},
		},
		{
			name: 'files_share_list',
			description: 'Shares the owner made (user, group, public link), on one item or all.',
			area: 'files',
			input: obj(target),
			run: async (ctx, input) => {
				const t = input.path === undefined && input.file_id === undefined ? {} : targetOf(input)
				return bridge.call<{ shares: PhpShare[] }>(ctx.grantor, 'shares', { ...t })
			},
		},
		{
			name: 'files_share',
			description: 'Share a file or folder with a user, a group, or as a public link (asks the owner unless allowed). permission read (default) or edit; optional expire_date YYYY-MM-DD and a note for the recipient. Public links get no password here.',
			area: 'files',
			action: 'share',
			input: obj({
				...target,
				type: str(undefined, { enum: ['user', 'group', 'link'] }),
				with: str('User id or group id (not for links)', { maxLength: 200 }),
				permission: str(undefined, { enum: ['read', 'edit'] }),
				expire_date: str('YYYY-MM-DD'),
				note: str(undefined, { maxLength: 2000 }),
			}, ['type']),
			prepare: async (ctx, input) => {
				const n = await stat(ctx, targetOf(input))
				const type = String(input.type)
				if (type !== 'link' && !input.with) throw new AgentError('invalid_input', `with is required for a ${type} share`)
				if (type === 'link' && input.with) throw new AgentError('invalid_input', 'A public link has no `with`')
				if (input.expire_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(input.expire_date))) throw new AgentError('invalid_input', 'expire_date must be YYYY-MM-DD')
				if (!n.can.share) throw new AgentError('forbidden', `${n.path} cannot be reshared`)
				const permission = input.permission === 'edit' ? 'edit' : 'read'
				const payload = { file_id: n.file_id, path: n.path, type, with: input.with ?? '', permission, expire_date: input.expire_date ?? null, note: input.note ?? '' }
				const who = type === 'link' ? 'as a public link' : `with ${type} ${String(input.with)}`
				const until = payload.expire_date ? `, until ${payload.expire_date}` : ''
				return { payload, summary: `Share ${n.path} ${who} (${permission}${until})`, ref: `file:${n.file_id}` }
			},
			stillValid: async (ctx, payload) => (await exists(ctx, { file_id: (payload as { file_id: number }).file_id })) !== null,
			execute: async (ctx, payload) => {
				const { path: _path, ...p } = payload as Record<string, unknown>
				return bridge.call<PhpShare>(ctx.grantor, 'share', p)
			},
		},
		{
			name: 'files_unshare',
			description: 'Remove a share made by the owner (share_id from files_share_list). Asks the owner unless allowed.',
			area: 'files',
			action: 'share',
			input: obj({ share_id: str(undefined, { maxLength: 200 }) }, ['share_id']),
			prepare: async (ctx, input) => {
				const all = await bridge.call<{ shares: PhpShare[] }>(ctx.grantor, 'shares', {})
				const s = all.shares.find((x) => x.share_id === input.share_id)
				if (!s) throw new AgentError('not_found', `No share ${String(input.share_id)}`)
				const who = s.type === 'link' ? 'public link' : `${s.type} ${s.with}`
				return { payload: { share_id: s.share_id }, summary: `Stop sharing ${s.path ?? `file #${s.file_id}`} (${who})`, ref: `share:${s.share_id}` }
			},
			execute: async (ctx, payload) => bridge.call(ctx.grantor, 'unshare', payload as Record<string, unknown>),
		},
	]
}

export function filesModule(make: (core: LayerCore) => FilesBridge = phpFiles): AgentModule {
	return { tools: (core) => filesTools(make(core)) }
}
