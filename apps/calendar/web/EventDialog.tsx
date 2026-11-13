// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// New / edit event. Repeating events ask "this event or all events" on save and delete.
import { useEffect, useState } from 'react'
import { Button, Dialog, IconButton, Select, Spinner, Switch, TextArea, TextField, toast } from '@atrium/ui'
import { REMINDERS, createEvent, deleteEvent, formFrom, loadObject, masterOf, overrideOf, updateEvent, type Cal, type EventForm, type Instance, type Repeat, type StoredObject } from './api'
import { dateKey, parseKey, timeOfDay, useApp } from '@atrium/sdk'
import { answerInvite, isOrganizer, myAttendance, PARTSTAT_LABEL, validEmail, type PartStat, type People } from './extras'

export type Draft = { inst: Instance } | { start: Date, end: Date, allDay: boolean }

const REPEATS: { id: Repeat, label: string }[] = [
	{ id: 'none', label: 'Does not repeat' }, { id: 'DAILY', label: 'Every day' }, { id: 'WEEKLY', label: 'Every week' },
	{ id: 'MONTHLY', label: 'Every month' }, { id: 'YEARLY', label: 'Every year' },
]
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const withDate = (d: Date, key: string) => { const n = parseKey(key); return n ? new Date(n.getFullYear(), n.getMonth(), n.getDate(), d.getHours(), d.getMinutes()) : d }
const withTime = (d: Date, hm: string) => { const [h, m] = hm.split(':').map(Number); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h || 0, m || 0) }

export function EventDialog({ draft, calendars, defaultCal, onClose, onChanged }: { draft: Draft, calendars: Cal[], defaultCal: Cal | undefined, onClose: () => void, onChanged: () => void }) {
	const inst = 'inst' in draft ? draft.inst : null
	const [obj, setObj] = useState<StoredObject | null>(null)
	const [form, setForm] = useState<EventForm | null>(inst ? null : formFrom(undefined, null, { start: (draft as { start: Date }).start, end: (draft as { end: Date }).end, allDay: (draft as { allDay: boolean }).allDay }))
	const [calUrl, setCalUrl] = useState(inst?.cal.url ?? defaultCal?.url ?? '')
	const [busy, setBusy] = useState(false)
	const [ask, setAsk] = useState<null | 'save' | 'delete'>(null)
	const { session } = useApp()
	const me = { email: session.user.email ?? null, name: session.user.displayName }
	const [guest, setGuest] = useState('')
	const people: People = form?.people ?? { organizer: null, attendees: [] }
	const organizer = isOrganizer(people, me.email)
	const mine = myAttendance(people, me.email)
	// Invited by someone else: the event is theirs; only my answer changes.
	const invited = !!inst && !organizer
	const readOnly = !!inst?.cal.readOnly || invited
	const writable = calendars.filter((c) => !c.readOnly)
	const setPeople = (p: People) => setForm((f) => f && { ...f, people: p })
	const addGuest = () => {
		const email = guest.trim()
		if (!validEmail(email)) return toast.error('Not an email address')
		if (people.attendees.some((a) => a.email.toLowerCase() === email.toLowerCase())) return setGuest('')
		setPeople({ ...people, attendees: [...people.attendees, { email, name: '', partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT' }] })
		setGuest('')
	}
	async function answer(a: PartStat) {
		if (!obj || !me.email) return
		setBusy(true)
		try {
			await answerInvite(obj, me.email, a)
			toast(a === 'ACCEPTED' ? 'You accepted' : a === 'DECLINED' ? 'You declined' : 'You answered maybe')
			onChanged()
			onClose()
		} catch (e) {
			toast.error(`Could not answer: ${errText(e)}`)
		} finally { setBusy(false) }
	}

	useEffect(() => {
		if (!inst) return
		loadObject(inst).then((o) => {
			setObj(o)
			const ov = inst.recurrenceId ? overrideOf(o.root, inst.recurrenceId) : undefined
			setForm(formFrom(ov && inst.recurrenceId ? ov : masterOf(o.root) ?? o.root.children.find((c) => c.name === 'VEVENT'), inst))
		}, (e) => { toast.error(`Could not open the event: ${errText(e)}`); onClose() })
	}, [inst, onClose])

	const set = <K extends keyof EventForm>(k: K, v: EventForm[K]) => setForm((f) => f && { ...f, [k]: v })
	const repeating = !!inst?.recurrenceId

	async function save(scope: 'all' | 'this' = 'all') {
		if (!form) return
		const target = calendars.find((c) => c.url === calUrl) ?? defaultCal
		if (!target) return toast.error('No calendar you can write to')
		if (repeating && !ask) return setAsk('save')
		setBusy(true)
		try {
			const f = { ...form, me }
			if (inst && obj) await updateEvent(obj, inst, f, scope, target)
			else await createEvent(target, f)
			onChanged()
			onClose()
		} catch (e) {
			toast.error(`Could not save: ${errText(e)}`)
		} finally { setBusy(false); setAsk(null) }
	}
	async function remove(scope: 'all' | 'this' = 'all') {
		if (!inst || !obj) return
		if (repeating && !ask) return setAsk('delete')
		setBusy(true)
		try {
			await deleteEvent(obj, inst, scope)
			toast(scope === 'this' ? 'Deleted this occurrence' : `Deleted ${form?.title || 'the event'}`)
			onChanged()
			onClose()
		} catch (e) {
			toast.error(`Could not delete: ${errText(e)}`)
		} finally { setBusy(false); setAsk(null) }
	}

	if (ask) {
		return (
			<Dialog open title={ask === 'save' ? 'Save repeating event' : 'Delete repeating event'} onClose={() => setAsk(null)}
				actions={<>
					<Button variant="text" onClick={() => setAsk(null)}>Cancel</Button>
					<Button variant="tonal" busy={busy} onClick={() => (ask === 'save' ? save('this') : remove('this'))}>This event</Button>
					<Button variant={ask === 'delete' ? 'danger' : 'filled'} busy={busy} onClick={() => (ask === 'save' ? save('all') : remove('all'))}>All events</Button>
				</>}>
				<p style={{ margin: 0 }}>{ask === 'save' ? 'Change only this occurrence, or every event in the series?' : 'Delete only this occurrence, or the whole series?'}</p>
			</Dialog>
		)
	}

	return (
		<Dialog open title={inst ? (readOnly ? 'Event' : 'Edit event') : 'New event'} onClose={onClose}
			actions={form && (readOnly
				? <>
					{invited && mine && !inst?.cal.readOnly && <>
						<Button variant="text" busy={busy} onClick={() => answer('DECLINED')}>Decline</Button>
						<Button variant="tonal" busy={busy} onClick={() => answer('TENTATIVE')}>Maybe</Button>
						<Button busy={busy} onClick={() => answer('ACCEPTED')}>Accept</Button>
					</>}
					<Button variant="text" onClick={onClose}>Close</Button>
				</>
				: <>
					{inst && <Button variant="text" className="cal-dlg__delete" icon="delete" onClick={() => remove()} disabled={busy}>Delete</Button>}
					<span className="at-spacer" />
					<Button variant="text" onClick={onClose}>Cancel</Button>
					<Button icon="check" busy={busy} onClick={() => save()}>Save</Button>
				</>)}>
			{!form ? <div className="cal-dlg__loading"><Spinner /></div> : (
				<form className="cal-dlg" onSubmit={(e) => { e.preventDefault(); save() }}>
					<fieldset disabled={readOnly} className="cal-dlg__fields">
						<TextField label="Title" autoFocus={!inst} value={form.title} onChange={(e) => set('title', e.target.value)} />
						<Switch label="All day" checked={form.allDay} onChange={(e) => {
							const allDay = e.target.checked
							setForm((f) => f && (allDay
								? { ...f, allDay, end: new Date(f.end.getTime() - (f.end.getHours() === 0 && f.end.getMinutes() === 0 ? 1 : 0)) }
								: { ...f, allDay, start: withTime(f.start, '09:00'), end: withTime(f.end, '10:00') }))
						}} />
						<div className="cal-dlg__when">
							<TextField label={form.allDay ? 'From' : 'Starts'} type="date" value={dateKey(form.start)} onChange={(e) => {
								const s = withDate(form.start, e.target.value)
								const shift = s.getTime() - form.start.getTime()
								setForm((f) => f && { ...f, start: s, end: new Date(f.end.getTime() + shift) })
							}} />
							{!form.allDay && <TextField label="Time" type="time" value={timeOfDay(form.start)} onChange={(e) => {
								const s = withTime(form.start, e.target.value)
								const shift = s.getTime() - form.start.getTime()
								setForm((f) => f && { ...f, start: s, end: new Date(f.end.getTime() + shift) })
							}} />}
							<TextField label={form.allDay ? 'To' : 'Ends'} type="date" value={dateKey(form.end)} onChange={(e) => set('end', withDate(form.end, e.target.value))} />
							{!form.allDay && <TextField label="Time" type="time" value={timeOfDay(form.end)} onChange={(e) => set('end', withTime(form.end, e.target.value))} />}
						</div>
						<div className="cal-dlg__row">
							<Select label="Repeat" value={form.repeat} onChange={(e) => set('repeat', e.target.value as Repeat)}>
								{REPEATS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
								{form.repeat === 'custom' && <option value="custom">Custom (unchanged)</option>}
							</Select>
							<Select label="Reminder" value={form.reminder} onChange={(e) => set('reminder', e.target.value as EventForm['reminder'])}>
								{REMINDERS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
								{form.reminder === 'custom' && <option value="custom">Custom (unchanged)</option>}
							</Select>
						</div>
						<TextField label="Location" icon="place" value={form.location} onChange={(e) => set('location', e.target.value)} />
						<TextArea label="Description" rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} />
					</fieldset>
					<div className="cal-dlg__people">
						{invited && people.organizer && <p className="at-muted" style={{ margin: 0 }}>Invitation from {people.organizer.name || people.organizer.email}{mine ? ` · your answer: ${PARTSTAT_LABEL[mine.partstat]}` : ''}</p>}
						{people.attendees.length > 0 && <ul className="cal-guests" aria-label="Guests">
							{people.attendees.map((a) => (
								<li key={a.email}>
									<span className="cal-guests__who">{a.name || a.email}</span>
									<span className={`cal-guests__state cal-guests__state--${a.partstat.toLowerCase()}`}>{PARTSTAT_LABEL[a.partstat]}</span>
									{!readOnly && <IconButton icon="close" label={`Remove ${a.email}`} onClick={() => setPeople({ ...people, attendees: people.attendees.filter((x) => x !== a) })} />}
								</li>
							))}
						</ul>}
						{!readOnly && <div className="cal-guests__add">
							<TextField label="Invite by email" type="email" value={guest} onChange={(e) => setGuest(e.target.value)}
								onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGuest() } }} />
							<Button variant="tonal" disabled={!guest.trim()} onClick={addGuest}>Invite</Button>
						</div>}
						{!readOnly && people.attendees.length > 0 && <p className="at-muted cal-guests__hint">Guests get an invitation by email when you save{me.email ? '' : ' (set your email in Settings > Profile first)'}.</p>}
					</div>
					<fieldset disabled={readOnly} className="cal-dlg__fields">
						{(readOnly ? calendars : writable).length > 1 || readOnly ? (
							<Select label="Calendar" value={calUrl} onChange={(e) => setCalUrl(e.target.value)} disabled={readOnly}>
								{(readOnly ? calendars : writable).map((c) => <option key={c.url} value={c.url}>{c.name}</option>)}
							</Select>
						) : null}
					</fieldset>
					<button type="submit" hidden />
				</form>
			)}
		</Dialog>
	)
}
