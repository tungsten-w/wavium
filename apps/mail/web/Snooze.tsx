// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Snooze (PLAN P4-1): the mail leaves the inbox for the account's snooze folder
// and Mail's WakeJob brings it back at the chosen time (Nextcloud Mail's own
// /api/messages/<id>/snooze). Times are the browser's local time.
import { useState } from 'react'
import { Button, Dialog, TextField } from '@atrium/ui'

export interface SnoozeChoice { label: string, at: number }

/** Later today (18:00, if still ahead), tomorrow 08:00, next Monday 08:00; unix seconds. */
export function snoozeChoices(now: Date = new Date()): SnoozeChoice[] {
	const at = (d: Date, h: number) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return Math.floor(x.getTime() / 1000) }
	const out: SnoozeChoice[] = []
	if (now.getHours() < 17) out.push({ label: 'Later today (18:00)', at: at(now, 18) })
	const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1)
	out.push({ label: 'Tomorrow morning (08:00)', at: at(tomorrow, 8) })
	const monday = new Date(now); monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7))
	const mondayAt = at(monday, 8)
	if (!out.some((c) => c.at === mondayAt)) out.push({ label: 'Next Monday (08:00)', at: mondayAt })
	return out
}

export function SnoozeDialog({ open, onClose, onPick }: { open: boolean, onClose: () => void, onPick: (at: number) => void }) {
	const [custom, setCustom] = useState('')
	const customAt = custom ? Math.floor(new Date(custom).getTime() / 1000) : NaN
	const ok = Number.isFinite(customAt) && customAt > Date.now() / 1000
	return (
		<Dialog open={open} title="Snooze until" onClose={onClose} actions={<>
			<Button variant="text" onClick={onClose}>Cancel</Button>
			<Button disabled={!ok} onClick={() => onPick(customAt)}>Snooze</Button>
		</>}>
			<div className="ml-snooze">
				{snoozeChoices().map((c) => <Button key={c.label} variant="tonal" onClick={() => onPick(c.at)}>{c.label}</Button>)}
				<TextField label="Pick a date and time" type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
			</div>
		</Dialog>
	)
}
