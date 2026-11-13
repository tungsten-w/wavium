// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conversation view (PLAN P4-1): under the open mail, the other messages of
// its thread (Mail's /api/messages/<id>/thread), oldest first; one click opens
// a message in the reader.
import { useEffect, useState } from 'react'
import { Icon } from '@atrium/ui'
import { getThread, type Message } from './api'

const who = (m: Message) => m.from[0]?.label || m.from[0]?.email || 'Unknown'
const date = (t: number) => new Date(t * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function ThreadList({ id, onOpen }: { id: number, onOpen: (id: number) => void }) {
	const [items, setItems] = useState<Message[]>([])
	useEffect(() => {
		let live = true
		setItems([])
		getThread(id).then((t) => { if (live) setItems(t) }, () => { if (live) setItems([]) })
		return () => { live = false }
	}, [id])
	const others = items.filter((m) => m.databaseId !== id).sort((a, b) => a.dateInt - b.dateInt)
	if (!others.length) return null
	return (
		<section className="ml-thread" aria-label="Conversation">
			<h2><Icon name="mail" /> {others.length === 1 ? '1 other message' : `${others.length} other messages`} in this conversation</h2>
			<ul>
				{others.map((m) => (
					<li key={m.databaseId}>
						<button type="button" onClick={() => onOpen(m.databaseId)}>
							<span className="ml-thread__who">{who(m)}</span>
							<span className="ml-thread__preview">{m.previewText || m.subject}</span>
							<time>{date(m.dateInt)}</time>
						</button>
					</li>
				))}
			</ul>
		</section>
	)
}
