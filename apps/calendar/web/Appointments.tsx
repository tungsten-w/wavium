// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Appointment pages (P4-2): people book a slot in your free time through a
// public link. Here: list (copy the link, delete) and create one (name,
// length, calendar, weekly hours). The public booking page is the Calendar
// app's own page; bookings land in the chosen calendar.
import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, Dialog, Icon, IconButton, NavSection, Select, TextArea, TextField, confirmDialog, toast } from '@atrium/ui'
import type { Cal } from './api'
import { type AppointmentConfig, type AppointmentForm, bookingUrl, createAppointment, DAYS, type Day, deleteAppointment, listAppointments } from './extras'

const DAY_LABEL: Record<Day, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' }
const LENGTHS = [15, 30, 45, 60, 90]
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export function Appointments({ calendars }: { calendars: Cal[] }) {
	const [list, setList] = useState<AppointmentConfig[] | null>(null)
	const [form, setForm] = useState<AppointmentForm | null>(null)
	const [busy, setBusy] = useState(false)
	const load = useCallback(() => { listAppointments().then(setList, () => setList([])) }, [])
	useEffect(load, [load])
	const own = calendars.filter((c) => !c.shared && !c.sub)

	const open = () => setForm({ name: '', description: '', location: '', visibility: 'PUBLIC', calendar: own[0]?.id ?? '', length: 30, days: ['MO', 'TU', 'WE', 'TH', 'FR'], from: '09:00', to: '17:00' })
	const set = <K extends keyof AppointmentForm>(k: K, v: AppointmentForm[K]) => setForm((f) => f && { ...f, [k]: v })
	const valid = !!form && !!form.name.trim() && !!form.calendar && form.days.length > 0 && form.from < form.to

	async function create() {
		if (!form || !valid) return
		setBusy(true)
		try {
			const c = await createAppointment(form, tz())
			setForm(null)
			load()
			if (c) await copy(c)
		} catch (e) {
			toast.error(`Could not create: ${errText(e)}`)
		} finally { setBusy(false) }
	}
	async function copy(c: AppointmentConfig) {
		try { await navigator.clipboard.writeText(bookingUrl(c)); toast('Booking link copied') } catch { toast(bookingUrl(c)) }
	}
	async function remove(c: AppointmentConfig) {
		if (!await confirmDialog(`Delete the appointment page "${c.name}"? Its link stops working; booked events stay.`, { title: 'Delete appointment page', confirm: 'Delete', danger: true })) return
		try { await deleteAppointment(c.id); load() } catch (e) { toast.error(errText(e)) }
	}

	return (
		<NavSection title="Appointments">
			{(list ?? []).map((c) => (
				<div key={c.id} className="cal-appt" data-appointment={c.id}>
					<span className="cal-appt__name" title={c.description || c.name}>{c.name}</span>
					<span className="at-muted cal-appt__len">{Math.round(c.length / 60)} min</span>
					<IconButton icon="copy" label={`Copy the booking link of ${c.name}`} onClick={() => copy(c)} />
					<IconButton icon="delete" label={`Delete ${c.name}`} onClick={() => remove(c)} />
				</div>
			))}
			<button type="button" className="at-app-nav__item" disabled={own.length === 0} onClick={open}>
				<Icon name="add" /><span>New appointment page</span>
			</button>
			<Dialog open={!!form} title="New appointment page" onClose={() => setForm(null)}
				actions={<><Button variant="text" onClick={() => setForm(null)}>Cancel</Button><Button busy={busy} disabled={!valid} onClick={create}>Create</Button></>}>
				{form && <form className="cal-caldlg cal-appt-form" onSubmit={(e) => { e.preventDefault(); create() }}>
					<TextField label="Name" autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} />
					<TextArea label="Description" rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />
					<TextField label="Location" value={form.location} onChange={(e) => set('location', e.target.value)} />
					<div className="cal-dlg__row">
						<Select label="Length" value={String(form.length)} onChange={(e) => set('length', Number(e.target.value))}>
							{LENGTHS.map((m) => <option key={m} value={m}>{m} minutes</option>)}
						</Select>
						<Select label="Book into" value={form.calendar} onChange={(e) => set('calendar', e.target.value)}>
							{own.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
						</Select>
					</div>
					<fieldset className="cal-appt-days">
						<legend className="at-muted">Days</legend>
						{DAYS.map((d) => <Checkbox key={d} label={DAY_LABEL[d]} checked={form.days.includes(d)} onChange={(e) => set('days', e.target.checked ? DAYS.filter((x) => x === d || form.days.includes(x)) : form.days.filter((x) => x !== d))} />)}
					</fieldset>
					<div className="cal-dlg__row">
						<TextField label="From" type="time" value={form.from} onChange={(e) => set('from', e.target.value)} />
						<TextField label="To" type="time" value={form.to} onChange={(e) => set('to', e.target.value)} />
					</div>
					{form.from >= form.to && <p className="cal-appt-form__err" role="alert">"To" must be after "From".</p>}
					<Select label="Visibility" value={form.visibility} onChange={(e) => set('visibility', e.target.value as AppointmentForm['visibility'])}>
						<option value="PUBLIC">Listed on your public profile</option>
						<option value="PRIVATE">Only people with the link</option>
					</Select>
				</form>}
			</Dialog>
		</NavSection>
	)
}
