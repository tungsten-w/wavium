// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mail tools (ADR 0009 section 3, "Mail"). Reads come from the mail tables
// (read.ts); writes go through PHP's mail services (write.ts).
import type { AgentModule } from '../index'
import { arr, boolean, int, obj, str } from '../schema'
import type { Tool } from '../tools'
import { MailArrivals } from './arrival'
import { accountsTool, CATEGORIES, getMessage, getThread, listMessages, URGENCIES } from './read'
import { mailWrites, type MailBridge, phpBridge, purgeExpired } from './write'

export function mailTools(bridge: MailBridge | null): Tool[] {
	const fetchBody = bridge ? (grantor: string, id: number) => bridge.fetchBody(grantor, id) : null
	const reads: Tool[] = [
		{
			name: 'mail_accounts',
			description: 'Mail accounts (id, email, name) with their folders (id, name, role inbox/archive/sent/drafts/trash/junk/other, counts).',
			area: 'mail',
			input: obj({}),
			run: (ctx) => accountsTool(ctx.db, ctx.grantor),
		},
		{
			name: 'mail_message_list',
			description: 'Search mail, newest first. Default folders: inbox + archive. Rows have message_key, thread_key, folder, date, from, to, subject, snippet, flags, has_attachments and a compact classification. Use mail_message_get for the body.',
			area: 'mail',
			input: obj({
				account: int(),
				folder: { type: ['string', 'integer'], description: 'Folder id, or a role: inbox, archive, sent, drafts, trash, junk, other, all' },
				after: str('ISO date', { format: 'date-time' }),
				before: str('ISO date', { format: 'date-time' }),
				from: str('Part of the sender name or address'),
				to: str('Part of a recipient name or address'),
				subject: str(),
				text: str('Full text over subject, snippet and stored bodies'),
				category: { anyOf: [str(undefined, { enum: CATEGORIES }), arr(str(undefined, { enum: CATEGORIES }))] },
				curated: boolean('Only mail the owner\'s Curated setting shows (true, including mail not classified yet) or hides (false)'),
				urgency_min: str(undefined, { enum: URGENCIES }),
				needs_reply: boolean(),
				needs_action: boolean(),
				seen: boolean(),
				starred: boolean(),
				has_attachments: boolean(),
				limit: int('Default 25, max 100', { minimum: 1, maximum: 100 }),
				cursor: str('next_cursor of the previous page'),
			}),
			run: (ctx, input) => listMessages(ctx.db, ctx.grantor, input as never),
		},
		{
			name: 'mail_message_get',
			description: 'One mail: headers, text body (paged with max_chars/offset), optional sanitized HTML, attachments, flags, full classification (mail-v2), folder, only_in_atrium.',
			area: 'mail',
			input: obj({
				message_key: str(),
				html: boolean('Also return the sanitized HTML'),
				max_chars: int('Default 8000', { minimum: 1, maximum: 200000 }),
				offset: int('Start of the body slice', { minimum: 0 }),
			}, ['message_key']),
			run: (ctx, input) => getMessage(ctx.db, ctx.grantor, input as never, fetchBody),
		},
		{
			name: 'mail_thread_get',
			description: 'The mails of a conversation, oldest first; each body capped by max_chars (default 2000).',
			area: 'mail',
			input: obj({ thread_key: str(), max_chars: int(undefined, { minimum: 1, maximum: 50000 }) }, ['thread_key']),
			run: (ctx, input) => getThread(ctx.db, ctx.grantor, input as never),
		},
	]
	return bridge ? [...reads, ...mailWrites(bridge)] : reads
}

export function mailModule(): AgentModule {
	let bridge: MailBridge | null = null
	let timer: ReturnType<typeof setInterval> | null = null
	let arrivals: MailArrivals | null = null
	return {
		tools: (core) => {
			bridge = phpBridge(core)
			return mailTools(bridge)
		},
		start: (core) => {
			timer = setInterval(() => { void purgeExpired(core.db).catch((e) => console.error(`agent mail purge: ${(e as Error).message}`)) }, 3600_000)
			arrivals = new MailArrivals(core.db, { notifier: core.notifier, statusUrl: `${core.cfg.baseUrl}/apps/mail/status` })
			arrivals.start()
		},
		stop: () => {
			if (timer) clearInterval(timer)
			arrivals?.stop()
		},
		route: (core, req, url, path) => bridge ? bridge.route(core, req, url, path) : Promise.resolve(null),
	}
}
