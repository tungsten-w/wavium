// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tags (PLAN P4-1): Mail's own tags (IMAP keywords, so phones and other mail
// clients see them). A chip per tag in the list; "Tags…" in the reader adds or
// removes them and creates new ones.
import { useEffect, useState } from 'react'
import { Button, Checkbox, Dialog, Spinner, TextField, toast } from '@atrium/ui'
import { createTag, listTags, removeTag, setTag, type Message, type Tag } from './api'

const COLORS = ['#0b6aa8', '#2e7d32', '#c62828', '#ef6c00', '#6a1b9a', '#00838f']
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function TagChips({ message }: { message: Message }) {
	const tags = Object.values(message.tags ?? {}).filter((t) => t.displayName)
	if (!tags.length) return null
	return <>{tags.map((t) => <span key={t.imapLabel} className="ml-tag" style={{ ['--tag' as string]: t.color || '#888' }}>{t.displayName}</span>)}</>
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
			<div className="ml-tags">
				{!all && <Spinner small />}
				{all && all.map((t) => (
					<Checkbox key={t.imapLabel} label={<span className="ml-tag" style={{ ['--tag' as string]: t.color || '#888' }}>{t.displayName}</span>}
						checked={!!mine[t.imapLabel]} disabled={busy !== null} onChange={(e) => void toggle(t, e.target.checked)} />
				))}
				<form className="ml-tags__new" onSubmit={(e) => { e.preventDefault(); void add() }}>
					<TextField label="New tag" value={name} onChange={(e) => setName(e.target.value)} />
					<Button type="submit" variant="tonal" busy={busy === 'new'} disabled={!name.trim()}>Add</Button>
				</form>
			</div>
		</Dialog>
	)
}
