// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Calendar for the Atrium shell, straight over CalDAV. Routes keep upstream's shape:
//   /apps/calendar/<view>/<date|now>     view = dayGridMonth | timeGridWeek | timeGridDay | listMonth
//   /apps/calendar/edit/<base64>[/<rid>] and /<view>/<date>/edit/<mode>/<base64>/<rid>: classic event links (extras.ts)
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defineApp, navigate, useApp, useAppPath } from '@atrium/sdk'
import { AppLayout, Button, Checkbox, Dialog, EmptyState, Icon, IconButton, Menu, NavSection, NavToggle, Spinner, TextField, confirmDialog, toast } from '@atrium/ui'
import { createCalendar, deleteCalendar, exportUrl, listCalendars, listInstances, updateCalendar, type Cal, type Instance } from './api'
import { EventDialog, type Draft } from './EventDialog'
import { Appointments } from './Appointments'
import { feedUrl, instanceAt, parseEditPath, subscribe } from './extras'
import { addDays, addMonths, dateKey, fmtTime, parseKey, sameDay, startOfDay, startOfWeek } from '@atrium/sdk'
import { MiniMonth, MonthView, TimeGrid } from './views'
import './style.css'

type View = 'dayGridMonth' | 'timeGridWeek' | 'timeGridDay' | 'listMonth'
const VIEWS: { id: View, label: string }[] = [{ id: 'timeGridDay', label: 'Day' }, { id: 'timeGridWeek', label: 'Week' }, { id: 'dayGridMonth', label: 'Month' }, { id: 'listMonth', label: 'List' }]
const COLORS = ['#0082c9', '#386a20', '#b3261e', '#e8710a', '#a142f4', '#00897b', '#c2185b', '#5f6368']
const HIDDEN_KEY = 'atrium.calendar.hidden'

function readHidden(): Set<string> {
	try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]')) } catch { return new Set() }
}

function range(view: View, date: Date): [Date, Date] {
	if (view === 'timeGridDay') return [startOfDay(date), addDays(startOfDay(date), 1)]
	if (view === 'timeGridWeek') { const s = startOfWeek(date); return [s, addDays(s, 7)] }
	const first = new Date(date.getFullYear(), date.getMonth(), 1)
	if (view === 'listMonth') return [first, new Date(date.getFullYear(), date.getMonth() + 1, 1)]
	// Continuous month view: the month in view plus its neighbours, so scrolling a bit needs no reload.
	return [startOfWeek(new Date(date.getFullYear(), date.getMonth() - 1, 1)), addDays(startOfWeek(new Date(date.getFullYear(), date.getMonth() + 2, 1)), 7)]
}

function Calendar() {
	const { basePath, session, setTitle } = useApp()
	const user = session.user.id
	const path = useAppPath()
	const seg = path.split('/').filter(Boolean)
	const view: View = VIEWS.some((v) => v.id === seg[0]) ? seg[0] as View : 'timeGridWeek'
	const date = (seg[1] && seg[1] !== 'now' ? parseKey(seg[1]) : null) ?? startOfDay(new Date())

	const [cals, setCals] = useState<Cal[] | null>(null)
	const [events, setEvents] = useState<Instance[]>([])
	const [loading, setLoading] = useState(false)
	const [hidden, setHidden] = useState<Set<string>>(readHidden)
	const [draft, setDraft] = useState<Draft | null>(null)
	const [calDialog, setCalDialog] = useState<{ cal: Cal | null, name: string, color: string } | null>(null)
	const [subDialog, setSubDialog] = useState<{ url: string, name: string, color: string } | null>(null)
	const [from, to] = range(view, date)

	const go = useCallback((v: View, d: Date | 'now', replace = false) => navigate(`${basePath}/${v}/${d === 'now' || sameDay(d, new Date()) ? 'now' : dateKey(d)}`, { replace }), [basePath])
	useEffect(() => { setTitle('Calendar') }, [setTitle])

	const loadCals = useCallback(async () => {
		try {
			let list = await listCalendars(user)
			// Like upstream: everyone gets a "Personal" calendar to write to.
			if (!list.some((c) => !c.readOnly && !c.shared)) {
				await createCalendar(user, 'Personal', '#0082c9', 'personal').catch(() => {})
				list = await listCalendars(user)
			}
			setCals(list)
		} catch (e) { toast.error(`Could not load calendars: ${e instanceof Error ? e.message : e}`); setCals([]) }
	}, [user])
	useEffect(() => { loadCals() }, [loadCals])

	// A classic event link (search result, old bookmark): open that event, then show the normal view.
	const editLink = useMemo(() => parseEditPath(seg), [path]) // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (!editLink || !cals) return
		let gone = false
		instanceAt(editLink, cals).then((inst) => {
			if (gone) return
			if (inst) { setDraft({ inst }); go(view, inst.start, true) }
			else { toast.error('This event is not in your calendars'); go(view, 'now', true) }
		}, () => { if (!gone) { toast.error('Could not open this event'); go(view, 'now', true) } })
		return () => { gone = true }
	}, [editLink, cals]) // eslint-disable-line react-hooks/exhaustive-deps

	const visibleCals = useMemo(() => (cals ?? []).filter((c) => !hidden.has(c.url)), [cals, hidden])
	const reqId = useRef(0)
	const loadEvents = useCallback(async () => {
		if (!cals) return
		const id = ++reqId.current
		setLoading(true)
		const lists = await Promise.all(visibleCals.map((c) => listInstances(c, from, to).catch(() => [] as Instance[])))
		if (id !== reqId.current) return
		setEvents(lists.flat())
		setLoading(false)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cals, visibleCals, from.getTime(), to.getTime()])
	useEffect(() => { loadEvents() }, [loadEvents])

	// Changes from phones and other clients: check ctags when the tab comes back and every minute.
	const calsRef = useRef(cals)
	calsRef.current = cals
	useEffect(() => {
		const check = async () => {
			if (document.hidden || !calsRef.current) return
			const fresh = await listCalendars(user).catch(() => null)
			if (!fresh) return
			const old = new Map(calsRef.current.map((c) => [c.url, c.ctag]))
			if (fresh.length !== old.size || fresh.some((c) => old.get(c.url) !== c.ctag)) setCals(fresh)
		}
		document.addEventListener('visibilitychange', check)
		const t = setInterval(check, 60000)
		return () => { document.removeEventListener('visibilitychange', check); clearInterval(t) }
	}, [user])

	const toggle = (c: Cal) => setHidden((h) => {
		const n = new Set(h)
		if (n.has(c.url)) n.delete(c.url); else n.add(c.url)
		try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...n])) } catch { /* private mode */ }
		return n
	})
	const writable = (cals ?? []).filter((c) => !c.readOnly)
	const defaultCal = writable.find((c) => !hidden.has(c.url)) ?? writable[0]
	const changed = () => loadCals()

	const step = (n: number) => go(view, view === 'timeGridDay' ? addDays(date, n) : view === 'timeGridWeek' ? addDays(date, 7 * n) : addMonths(date, n))
	const newAt = (start: Date, allDay: boolean) => setDraft(allDay
		? { start: startOfDay(start), end: addDays(startOfDay(start), 1), allDay: true }
		: { start, end: new Date(start.getTime() + 3600000), allDay: false })
	const newNow = () => {
		const n = new Date()
		const base = sameDay(date, n) ? n : new Date(date.getFullYear(), date.getMonth(), date.getDate(), 9)
		const s = new Date(base.getFullYear(), base.getMonth(), base.getDate(), base.getHours() + (sameDay(date, n) ? 1 : 0), 0)
		newAt(s, false)
	}

	const title = view === 'timeGridDay' ? date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
		: view === 'timeGridWeek' ? weekTitle(from, addDays(to, -1))
		: date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
	const marks = useMemo(() => {
		const s = new Set<string>()
		for (const e of events) { let d = startOfDay(e.start); do { s.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`); d = addDays(d, 1) } while (d < e.end) }
		return s
	}, [events])

	async function submitCal() {
		if (!calDialog?.name.trim()) return
		try {
			if (calDialog.cal) await updateCalendar(calDialog.cal, calDialog.name.trim(), calDialog.color)
			else await createCalendar(user, calDialog.name.trim(), calDialog.color)
			setCalDialog(null)
			loadCals()
		} catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
	}
	async function submitSub() {
		const url = subDialog && feedUrl(subDialog.url)
		if (!subDialog || !url) return toast.error('Give an https:// or webcal:// address')
		try {
			await subscribe(user, url, subDialog.name.trim() || new URL(url).hostname, subDialog.color)
			setSubDialog(null)
			toast('Subscribed. Events appear after the first refresh (a few minutes).')
			loadCals()
		} catch (e) { toast.error(`Could not subscribe: ${e instanceof Error ? e.message : e}`) }
	}
	async function removeCal(c: Cal) {
		if (!await confirmDialog(`Delete the calendar "${c.name}" and all its events?`, { title: 'Delete calendar', confirm: 'Delete', danger: true })) return
		try { await deleteCalendar(c); loadCals() } catch (e) { toast.error(String(e instanceof Error ? e.message : e)) }
	}

	const nav = (
		<>
			<Button icon="add" className="cal-new" disabled={!defaultCal} onClick={newNow}>New event</Button>
			<MiniMonth value={date} marks={marks} onPick={(d) => go(view, d)} />
			<NavSection title="Calendars">
				{(cals ?? []).map((c) => (
					<div key={c.url} className="cal-calrow" style={{ ['--c' as string]: c.color }}>
						<Checkbox className="cal-calrow__check" checked={!hidden.has(c.url)} onChange={() => toggle(c)} label={c.name} />
						{c.readOnly && <span className="cal-calrow__ro" title="Read-only">read-only</span>}
						<Menu trigger={(o, x) => <IconButton icon="moreVert" label={`${c.name} actions`} aria-expanded={x} onClick={o} />} items={[
							!c.shared && (!c.readOnly || !!c.sub) && { label: 'Edit', icon: 'edit', onClick: () => setCalDialog({ cal: c, name: c.name, color: c.color }) },
							{ label: 'Download', icon: 'download', href: exportUrl(c) },
							!c.shared && c.id !== 'contact_birthdays' && { label: 'Delete', icon: 'delete', danger: true, onClick: () => removeCal(c) },
						]} />
					</div>
				))}
				<button type="button" className="at-app-nav__item" onClick={() => setCalDialog({ cal: null, name: '', color: COLORS[(cals?.length ?? 0) % COLORS.length] })}>
					<Icon name="add" /><span>New calendar</span>
				</button>
				<button type="button" className="at-app-nav__item" onClick={() => setSubDialog({ url: '', name: '', color: COLORS[((cals?.length ?? 0) + 3) % COLORS.length] })}>
					<Icon name="link" /><span>Subscribe to a calendar</span>
				</button>
			</NavSection>
			<Appointments calendars={writable} />
		</>
	)

	return (
		<AppLayout nav={nav}>
			<div className="cal">
				<div className="cal-toolbar">
					<NavToggle />
					<Button variant="outlined" onClick={() => go(view, 'now')}>Today</Button>
					<IconButton icon="chevronLeft" label="Previous" onClick={() => step(-1)} />
					<IconButton icon="chevronRight" label="Next" onClick={() => step(1)} />
					<h1 className="cal-title">{title}</h1>
					{loading && <Spinner small />}
					<span className="at-spacer" />
					<div className="cal-views" role="tablist" aria-label="View">
						{VIEWS.map((v) => <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={'cal-views__btn' + (view === v.id ? ' cal-views__btn--on' : '')} onClick={() => go(v.id, date)}>{v.label}</button>)}
					</div>
				</div>
				<div className="cal-body">
					{cals === null ? <div className="cal-center"><Spinner /></div>
						: view === 'dayGridMonth' ? <MonthView date={date} events={events} onScrollMonth={(d) => go('dayGridMonth', d, true)} onPick={(d) => newAt(d, true)} onOpen={(inst) => setDraft({ inst })} onDay={(d) => go('timeGridDay', d)} />
						: view === 'listMonth' ? <ListView events={events} onOpen={(inst) => setDraft({ inst })} />
						: <TimeGrid days={view === 'timeGridDay' ? [startOfDay(date)] : Array.from({ length: 7 }, (_, i) => addDays(from, i))} events={events} onPick={newAt} onOpen={(inst) => setDraft({ inst })} onDay={(d) => go('timeGridDay', d)} />}
				</div>
			</div>
			{draft && <EventDialog draft={draft} calendars={cals ?? []} defaultCal={defaultCal} onClose={() => setDraft(null)} onChanged={changed} />}
			<Dialog open={!!calDialog} title={calDialog?.cal ? 'Edit calendar' : 'New calendar'} onClose={() => setCalDialog(null)}
				actions={<><Button variant="text" onClick={() => setCalDialog(null)}>Cancel</Button><Button disabled={!calDialog?.name.trim()} onClick={submitCal}>{calDialog?.cal ? 'Save' : 'Create'}</Button></>}>
				<form className="cal-caldlg" onSubmit={(e) => { e.preventDefault(); submitCal() }}>
					<TextField label="Name" autoFocus value={calDialog?.name ?? ''} onChange={(e) => setCalDialog((d) => d && { ...d, name: e.target.value })} />
					<div className="cal-swatches" role="radiogroup" aria-label="Colour">
						{COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={calDialog?.color === c} aria-label={c} className="cal-swatch" style={{ background: c }} onClick={() => setCalDialog((d) => d && { ...d, color: c })} />)}
						<label className="cal-swatch cal-swatch--custom" title="Custom colour" style={{ background: COLORS.includes(calDialog?.color ?? '') ? undefined : calDialog?.color }}>
							<input type="color" value={calDialog?.color ?? '#0082c9'} onChange={(e) => setCalDialog((d) => d && { ...d, color: e.target.value })} />
						</label>
					</div>
				</form>
			</Dialog>
			<Dialog open={!!subDialog} title="Subscribe to a calendar" onClose={() => setSubDialog(null)}
				actions={<><Button variant="text" onClick={() => setSubDialog(null)}>Cancel</Button><Button disabled={!subDialog?.url.trim()} onClick={submitSub}>Subscribe</Button></>}>
				<form className="cal-caldlg" onSubmit={(e) => { e.preventDefault(); submitSub() }}>
					<TextField label="Calendar address (https:// or webcal://)" autoFocus value={subDialog?.url ?? ''} onChange={(e) => setSubDialog((d) => d && { ...d, url: e.target.value })} />
					<TextField label="Name (optional)" value={subDialog?.name ?? ''} onChange={(e) => setSubDialog((d) => d && { ...d, name: e.target.value })} />
					<p className="at-muted" style={{ margin: 0 }}>Read-only; Wavium refreshes it regularly.</p>
				</form>
			</Dialog>
		</AppLayout>
	)
}

function weekTitle(a: Date, b: Date): string {
	if (a.getMonth() === b.getMonth()) return a.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
	const y = a.getFullYear() !== b.getFullYear()
	return `${a.toLocaleDateString(undefined, { month: 'short', ...(y ? { year: 'numeric' } : {}) })} – ${b.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`
}

function ListView({ events, onOpen }: { events: Instance[], onOpen: (i: Instance) => void }) {
	const days = new Map<string, { day: Date, list: Instance[] }>()
	for (const e of [...events].sort((a, b) => a.start.getTime() - b.start.getTime())) {
		const d = startOfDay(e.start)
		const k = dateKey(d)
		if (!days.has(k)) days.set(k, { day: d, list: [] })
		days.get(k)!.list.push(e)
	}
	if (days.size === 0) return <EmptyState icon="event" title="No events this month" />
	const today = new Date()
	return (
		<div className="cal-list">
			{[...days.values()].map(({ day, list }) => (
				<section key={day.getTime()} className="cal-list__day">
					<h2 className={'cal-list__date' + (sameDay(day, today) ? ' cal-list__date--today' : '')}>
						<span className="cal-list__num">{day.getDate()}</span>
						<span>{day.toLocaleDateString(undefined, { weekday: 'long', month: 'long' })}</span>
					</h2>
					{list.map((e) => (
						<button key={e.key} type="button" className="cal-list__ev" style={{ ['--c' as string]: e.color }} onClick={() => onOpen(e)}>
							<span className="cal-list__dot" />
							<span className="cal-list__time">{e.allDay ? 'All day' : `${fmtTime(e.start)} – ${fmtTime(e.end)}`}</span>
							<span className="cal-list__title">{e.title}</span>
							{e.location && <span className="cal-list__loc">{e.location}</span>}
						</button>
					))}
				</section>
			))}
		</div>
	)
}

export default defineApp({ Component: Calendar })
