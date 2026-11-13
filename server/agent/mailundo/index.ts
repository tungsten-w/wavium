// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Undo a delete in the Mail UI (PLAN P4-1). Deleting moves the mail to Trash
// (never a hard delete); its database id changes there. The UI keeps the
// Message-ID, syncs Trash, then calls:
//
//   POST /agent/v1/mail/undo-delete {account, message_id, to}   owner (session, OCS-APIRequest)
//
// which finds the mail in that account's Trash by Message-ID and moves it back
// to `to` (a folder of the same account) through the Mail bridge.
import type { Db } from '../db'
import type { AgentModule, LayerCore } from '../index'
import { messageKey, msgHash } from '../mail/keys'
import { rowsForKey } from '../mail/read'
import { type MailBridge, phpBridge } from '../mail/write'
import { AgentError } from '../util'

export async function undoDelete(db: Db, bridge: Pick<MailBridge, 'move'>, uid: string, input: Record<string, unknown>): Promise<{ restored: boolean, to: number }> {
	const account = Number(input.account)
	const to = Number(input.to)
	const mid = typeof input.message_id === 'string' ? input.message_id.trim() : ''
	if (!Number.isInteger(account) || !Number.isInteger(to) || !mid) throw new AgentError('invalid_input', 'account, message_id and to are required')
	let found
	try {
		found = await rowsForKey(db, uid, messageKey(account, msgHash(mid, 0)))
	} catch {
		throw new AgentError('not_found', 'The mail is not in Trash yet: try again in a moment')
	}
	const dest = found.scope.folderById.get(to)
	if (!dest || dest.accountId !== account) throw new AgentError('invalid_input', 'to must be a folder of the same account')
	const inTrash = found.rows.find((r) => found.scope.folderById.get(Number(r.mailbox_id))?.role === 'trash' && !r.server_gone_at)
	if (!inTrash) {
		// Already back (another tab, a second click): nothing to do.
		if (found.rows.some((r) => Number(r.mailbox_id) === to)) return { restored: false, to }
		throw new AgentError('not_found', 'The mail is not in Trash yet: try again in a moment')
	}
	await bridge.move(uid, Number(inTrash.id), to)
	return { restored: true, to }
}

export function mailUndoModule(): AgentModule {
	return {
		tools: () => [],
		async route(core: LayerCore, req, _url, pathname) {
			if (pathname !== '/agent/v1/mail/undo-delete') return null
			if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
			const { uid } = await core.auth.owner(req)
			let body: Record<string, unknown>
			try { body = await req.json() as Record<string, unknown> } catch { throw new AgentError('invalid_input', 'Body must be JSON') }
			return Response.json(await undoDelete(core.db, phpBridge(core), uid, body ?? {}))
		},
	}
}
