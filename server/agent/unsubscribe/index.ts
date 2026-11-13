// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Assisted unsubscribe (PLAN P5-5), from a mail's List-Unsubscribe header.
//
//   tool mail_unsubscribe_info   (read)  what the mail offers: one-click link, web link, mailto
//   tool mail_unsubscribe        (send = the owner's approval by default)
//        one-click (RFC 8058) only: PHP posts to the link, after checking it is
//        still the mail's link and https; Nextcloud's HTTP client refuses
//        local addresses. A web page or a mailto is never followed by an agent:
//        the answer says what the owner can do instead.
//
// The Mail UI uses Nextcloud Mail's own route (/apps/mail/api/list/unsubscribe/<id>)
// after a confirmation dialog; see apps/mail/web.
import type { AgentModule, LayerCore } from '../index'
import { rowsForKey } from '../mail/read'
import type { Tool, ToolCtx } from '../tools'
import { AgentError } from '../util'

export interface ListInfo { url: string | null, one_click: boolean, mailto: string | null }

export interface UnsubBridge {
	info(uid: string, id: number): Promise<ListInfo>
	unsubscribe(uid: string, id: number, url: string): Promise<{ ok: boolean, status: number }>
}

export function phpUnsubBridge(core: Pick<LayerCore, 'php'>): UnsubBridge {
	return {
		info: (uid, id) => core.php.app<ListInfo>('POST', 'apps/mail/api/atrium-agent/listinfo', { body: { uid, id } }),
		unsubscribe: (uid, id, url) => core.php.app('POST', 'apps/mail/api/atrium-agent/unsubscribe', { body: { uid, id, url } }),
	}
}

/** The mail's row on the server (not one gone from it). */
async function mailRow(ctx: ToolCtx, key: unknown) {
	if (typeof key !== 'string' || !key) throw new AgentError('invalid_input', 'message_key is required')
	const { rows } = await rowsForKey(ctx.db, ctx.grantor, key)
	const row = rows.find((r) => !r.server_gone_at)
	if (!row) throw new AgentError('conflict', 'The mail is no longer on the mail server')
	return { id: Number(row.id), subject: String(row.subject ?? ''), key }
}

/** What the owner can do when there is no one-click link. */
export function manualAdvice(info: ListInfo): string | null {
	if (info.one_click) return null
	if (info.url) return 'This list only offers a web page: the owner can open the "Unsubscribe" link in Mail.'
	if (info.mailto) return 'This list unsubscribes by email: the owner can send the prepared mail from Mail.'
	return 'This mail has no unsubscribe header.'
}

export function unsubscribeTools(bridge: (core: LayerCore) => UnsubBridge): (core: LayerCore) => Tool[] {
	return (core) => {
		const b = bridge(core)
		return [
			{
				name: 'mail_unsubscribe_info',
				description: 'What a mail offers to unsubscribe from its mailing list (List-Unsubscribe): a one-click link (mail_unsubscribe can use it), a web page or an email address (the owner does those in Mail).',
				area: 'mail',
				input: { type: 'object', properties: { message_key: { type: 'string' } }, required: ['message_key'], additionalProperties: false },
				run: async (ctx, input) => {
					const m = await mailRow(ctx, input.message_key)
					const info = await b.info(ctx.grantor, m.id)
					return { message_key: m.key, one_click: info.one_click, has_web_link: !!info.url, has_mailto: !!info.mailto, advice: manualAdvice(info) }
				},
			},
			{
				name: 'mail_unsubscribe',
				description: 'Unsubscribe from the mailing list of a mail with its one-click link (RFC 8058). Usually needs the owner\'s approval: you get {status: "pending_approval", request_id}. Only one-click links; check mail_unsubscribe_info first.',
				area: 'mail',
				action: 'send',
				input: { type: 'object', properties: { message_key: { type: 'string' } }, required: ['message_key'], additionalProperties: false },
				prepare: async (ctx, input) => {
					const m = await mailRow(ctx, input.message_key)
					const info = await b.info(ctx.grantor, m.id)
					if (!info.one_click || !info.url) throw new AgentError('conflict', manualAdvice(info) ?? 'No one-click link')
					let host = ''
					try { host = new URL(info.url).host } catch { throw new AgentError('conflict', 'The unsubscribe link is not a valid URL') }
					return { payload: { message_key: m.key, id: m.id, url: info.url }, summary: `Unsubscribe from the list of "${m.subject.slice(0, 80)}" (${host})`, ref: m.key }
				},
				stillValid: async (ctx, payload) => {
					const p = payload as { id: number, url: string }
					try { return (await b.info(ctx.grantor, p.id)).url === p.url } catch { return false }
				},
				execute: async (ctx, payload) => {
					const p = payload as { message_key: string, id: number, url: string }
					const r = await b.unsubscribe(ctx.grantor, p.id, p.url)
					return { message_key: p.message_key, unsubscribed: r.ok, http_status: r.status }
				},
			},
		]
	}
}

export function unsubscribeModule(): AgentModule {
	const tools = unsubscribeTools(phpUnsubBridge)
	return { tools: (core) => tools(core) }
}
