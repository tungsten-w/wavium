// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tags (PLAN P4-1): Mail's own tags (IMAP keywords, so phones and other mail
// clients see them). A chip per tag in the list; "Tags…" in the reader adds or
// removes them and creates new ones.
import { useEffect, useState } from 'react'
import { Button, Checkbox, Dialog, Spinner, TextField, toast } from '@atrium/ui'
import { createTag, listTags, removeTag, setTag, type Message, type Tag } from './api'

/**
 * The colors a tag can be given, shared with the PHP side
 * (TagMapper::DISCOVERED_COLORS) so a keyword looks the same wherever its tag
 * row was created.
 */
export const COLORS = ['#0b6aa8', '#2e7d32', '#c62828', '#ef6c00', '#6a1b9a', '#00838f']

/**
 * Which color a label gets. Same arithmetic as TagMapper::colorIndex(), on the
 * bytes of the label with A-Z lowered and nothing else, so both sides agree.
 */
export function colorIndex(label: string): number {
	let h = 0
	for (const byte of new TextEncoder().encode(label.replace(/[A-Z]/g, (c) => c.toLowerCase()))) h = (h * 31 + byte) % 0x7fffffff
	return h % COLORS.length
}

/**
 * The color to draw a chip in. `mail_tags.color` defaults to '#fff', and Mail
 * sets no color on a tag it discovers as an IMAP keyword on the server, so
 * those tags are white: `color: #fff` over a 14%-of-white background is an
 * invisible chip. On this instance 668 of the 676 tagged mails were in that
 * state, all carrying "Promotion". White or empty therefore reads as "no color
 * chosen", not as "paint it white", and falls back to the palette.
 */
export function tagColor(t: { imapLabel?: string, color?: string | null }): string {
	const c = (t.color ?? '').trim().toLowerCase()
	const unset = c === '' || c === 'white' || /^#(f{3,4}|f{6}|f{8})$/.test(c)
	return unset ? COLORS[colorIndex(t.imapLabel ?? '')] : (t.color as string)
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function TagChips({ message }: { message: Message }) {
	const tags = Object.values(message.tags ?? {}).filter((t) => t.displayName)
	if (!tags.length) return null
	return <span className="ml-utags">{tags.map((t) => <span key={t.imapLabel} className="ml-utag" style={{ ['--tag' as string]: tagColor(t) }}>{t.displayName}</span>)}</span>
}

export function TagsDialog({ message, open, onClose, onChange }: { message: Message, open: boolean, onClose: () => void, onChange: (tags: Record<string, Tag>) => void }) {
	const [all, setAll] = useState<Tag[] | null>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const [name, setName] = useState('')
	useEffect(() => {
		if (open) listTags().then(setAll, (e) => { toast.error(errText(e)); setAll([]) })
	}, [open])
	const mine = message.tags ?? {}

	async function toggle(t: Tag, on: boolean) {
		setBusy(t.imapLabel)
		try {
			if (on) await setTag(message.databaseId, t.imapLabel)
			else await removeTag(message.databaseId, t.imapLabel)
			const next = { ...mine }
			if (on) next[t.imapLabel] = t
			else delete next[t.imapLabel]
			onChange(next)
		} catch (e) { toast.error(errText(e)) } finally { setBusy(null) }
	}

	async function add() {
		const n = name.trim()
		if (!n) return
		setBusy('new')
		try {
			const t = await createTag(n, COLORS[(all?.length ?? 0) % COLORS.length])
			setAll((a) => [...(a ?? []), t])
			setName('')
			await toggle(t, true)
		} catch (e) { toast.error(errText(e)) } finally { setBusy(null) }
	}

	return (
		<Dialog open={open} title="Tags" onClose={onClose} actions={<Button variant="text" onClick={onClose}>Done</Button>}>
			<div className="ml-tagpick">
				{!all && <Spinner small />}
				{all && all.map((t) => (
					<Checkbox key={t.imapLabel} label={<span className="ml-utag" style={{ ['--tag' as string]: tagColor(t) }}>{t.displayName}</span>}
						checked={!!mine[t.imapLabel]} disabled={busy !== null} onChange={(e) => void toggle(t, e.target.checked)} />
				))}
				<form className="ml-tagpick__new" onSubmit={(e) => { e.preventDefault(); void add() }}>
					<TextField label="New tag" value={name} onChange={(e) => setName(e.target.value)} />
					<Button type="submit" variant="tonal" busy={busy === 'new'} disabled={!name.trim()}>Add</Button>
				</form>
			</div>
		</Dialog>
	)
}
