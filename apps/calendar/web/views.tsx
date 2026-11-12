// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Month grid, day/week time grid and the small month in the navigation.
import { useEffect, useMemo, useRef, useState } from 'react'
import { IconButton } from '@atrium/ui'
import type { Instance } from './api'
import { addDays, addMonths, fmtTime, sameDay, startOfDay, startOfWeek } from '@atrium/sdk'

const HOUR = 48 // px per hour in the time grid

/** Instances that touch the local day d. */
function onDay(list: Instance[], d: Date): Instance[] {
	const s = startOfDay(d).getTime()
	const e = addDays(startOfDay(d), 1).getTime()
	return list.filter((i) => i.start.getTime() < e && (i.end.getTime() > s || (i.end.getTime() === i.start.getTime() && i.start.getTime() >= s)))
}
const byStart = (a: Instance, b: Instance) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime() || (b.end.getTime() - b.start.getTime()) - (a.end.getTime() - a.start.getTime())

export function weekdayNames(style: 'short' | 'narrow' = 'short'): string[] {
	const ws = startOfWeek(new Date())
	return Array.from({ length: 7 }, (_, i) => addDays(ws, i).toLocaleDateString(undefined, { weekday: style }))
}

// Continuous month view (like Apple Calendar): weeks scroll without end. Only the
// rows on screen are rendered; the scroll position maps straight to a week index.
const EPOCH = startOfWeek(new Date(2000, 0, 5))
const WEEKS = 100 * 53 // 2000 .. ~2100
const WEEK_MS = 7 * 86400000
const weekIndex = (d: Date) => Math.round((startOfWeek(d).getTime() - EPOCH.getTime()) / WEEK_MS)
const weekStart = (i: number) => addDays(EPOCH, i * 7)

export function MonthView({ date, events, onPick, onOpen, onDay: goDay, onScrollMonth }: { date: Date, events: Instance[], onPick: (d: Date) => void, onOpen: (i: Instance) => void, onDay: (d: Date) => void, onScrollMonth: (firstOfMonth: Date) => void }) {
	const scroller = useRef<HTMLDivElement>(null)
	const [rowH, setRowH] = useState(120)
	const [top, setTop] = useState(0)
	const [viewH, setViewH] = useState(600)
	const reported = useRef<number | null>(null)
	const ownNav = useRef(false)
	const today = new Date()

	// Row height: six weeks fill the screen, so any month (up to 6 week rows) is fully visible.
	useEffect(() => {
		const el = scroller.current
		if (!el) return
		const ro = new ResizeObserver(() => {
			const h = Math.max(96, Math.floor(el.clientHeight / 6))
			setViewH(el.clientHeight)
			setRowH((old) => {
				if (old !== h) el.scrollTop = (el.scrollTop / old) * h
				return h
			})
		})
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	// Jump to `date` when it changes from outside (Today, arrows, mini month), not from our own scrolling.
	useEffect(() => {
		const el = scroller.current
		if (!el) return
		const first = new Date(date.getFullYear(), date.getMonth(), 1).getTime()
		if (ownNav.current) { ownNav.current = false; return }
		const isToday = sameDay(date, today)
		// Start at the first week of the month; for today scroll further only if today would fall off screen.
		const target = Math.max(0, (isToday ? Math.max(weekIndex(new Date(first)), weekIndex(date) - 3) : weekIndex(new Date(first))) * rowH)
		const smooth = reported.current !== null && Math.abs(el.scrollTop - target) < rowH * 30
		reported.current = first
		el.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'auto' })
		setTop(target)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [date.getTime(), rowH > 0])

	const onScroll = () => {
		const el = scroller.current!
		setTop(el.scrollTop)
		// The month in view is the one in the middle of the screen.
		const mid = weekStart(Math.floor((el.scrollTop + el.clientHeight / 2) / rowH))
		const d = addDays(mid, 3)
		const first = new Date(d.getFullYear(), d.getMonth(), 1)
		if (first.getTime() !== reported.current) {
			reported.current = first.getTime()
			ownNav.current = !sameDay(first, date)
			onScrollMonth(first)
		}
	}

	const monthInView = new Date(reported.current ?? new Date(date.getFullYear(), date.getMonth(), 1).getTime())
	const firstRow = Math.max(0, Math.floor(top / rowH) - 2)
	const lastRow = Math.min(WEEKS, Math.ceil((top + viewH) / rowH) + 2)
	const maxChips = Math.max(1, Math.floor((rowH - 30) / 24))
	const rows = []
	for (let w = firstRow; w < lastRow; w++) {
		const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart(w), i))
		rows.push(
			<div key={w} className="cal-week" style={{ top: w * rowH, height: rowH }}>
				{days.map((d) => {
					const list = onDay(events, d).sort(byStart)
					const extra = list.length > maxChips ? list.length - (maxChips - 1) : 0
					const shown = extra ? list.slice(0, maxChips - 1) : list
					const isFirst = d.getDate() === 1
					return (
						<div key={d.getTime()} className={'cal-day' + (d.getMonth() !== monthInView.getMonth() || d.getFullYear() !== monthInView.getFullYear() ? ' cal-day--out' : '') + (isFirst ? ' cal-day--first' : '')} onClick={(e) => { if (e.target === e.currentTarget) onPick(d) }}>
							<button type="button" className={'cal-day__num' + (sameDay(d, today) ? ' cal-day__num--today' : '')} onClick={() => goDay(d)} aria-label={d.toLocaleDateString(undefined, { dateStyle: 'full' })}>
								{isFirst && <span className="cal-day__month">{d.toLocaleDateString(undefined, { month: 'short' })}</span>}
								<span className="cal-day__n">{d.getDate()}</span>
							</button>
							{shown.map((i) => (
								<button key={i.key} type="button" className={'cal-chip' + (i.allDay || multiDay(i) ? ' cal-chip--block' : '')} style={{ ['--c' as string]: i.color }} onClick={() => onOpen(i)} title={i.title}>
									{!i.allDay && !multiDay(i) && <span className="cal-chip__dot" />}
									{!i.allDay && sameDay(i.start, d) && <span className="cal-chip__time">{fmtTime(i.start)}</span>}
									<span className="cal-chip__title">{i.title}</span>
								</button>
							))}
							{extra > 0 && <button type="button" className="cal-more" onClick={() => goDay(d)}>+{extra} more</button>}
						</div>
					)
				})}
			</div>,
		)
	}
	return (
		<div className="cal-month">
			<div className="cal-month__head">{weekdayNames().map((n) => <div key={n}>{n}</div>)}</div>
			<div className="cal-month__scroll" ref={scroller} onScroll={onScroll}>
				<div style={{ height: WEEKS * rowH, position: 'relative' }}>{rows}</div>
			</div>
		</div>
	)
}
const multiDay = (i: Instance) => !sameDay(i.start, new Date(i.end.getTime() - 1))

interface Placed { inst: Instance, top: number, height: number, col: number, cols: number }
/** Side-by-side columns for overlapping events (greedy, per cluster). */
function layout(list: Instance[], day: Date): Placed[] {
	const s0 = startOfDay(day).getTime()
	const items = list.map((inst) => {
		const top = Math.max(0, (inst.start.getTime() - s0) / 3600000)
		const bottom = Math.min(24, (inst.end.getTime() - s0) / 3600000)
		return { inst, top, bottom: Math.max(bottom, top + 0.4) }
	}).sort((a, b) => a.top - b.top || b.bottom - a.bottom)
	const out: Placed[] = []
	let cluster: (typeof items[number] & { col: number })[] = []
	let clusterEnd = -1
	const flush = () => {
		const cols = Math.max(1, ...cluster.map((c) => c.col + 1))
		for (const c of cluster) out.push({ inst: c.inst, top: c.top * HOUR, height: (c.bottom - c.top) * HOUR, col: c.col, cols })
		cluster = []
	}
	for (const it of items) {
		if (it.top >= clusterEnd && cluster.length) flush()
		const used = new Set(cluster.filter((c) => c.bottom > it.top).map((c) => c.col))
		let col = 0
		while (used.has(col)) col++
		cluster.push({ ...it, col })
		clusterEnd = Math.max(clusterEnd, it.bottom)
	}
	if (cluster.length) flush()
	return out
}

export function TimeGrid({ days, events, onPick, onOpen, onDay: goDay }: { days: Date[], events: Instance[], onPick: (start: Date, allDay: boolean) => void, onOpen: (i: Instance) => void, onDay: (d: Date) => void }) {
	const scroller = useRef<HTMLDivElement>(null)
	const [now, setNow] = useState(new Date())
	useEffect(() => { const t = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(t) }, [])
	useEffect(() => {
		// Open on the working day (an hour before the first event, or 7:00).
		const first = events.filter((e) => !e.allDay && days.some((d) => sameDay(d, e.start))).map((e) => e.start.getHours()).sort((a, b) => a - b)[0]
		if (scroller.current) scroller.current.scrollTop = Math.max(0, (first === undefined ? 7 : Math.max(0, Math.min(first, 8) - 1)) * HOUR - 10)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [days[0]?.getTime(), days.length])
	const allDay = useMemo(() => days.map((d) => onDay(events, d).filter((i) => i.allDay || multiDay(i)).sort(byStart)), [days, events])
	const timed = useMemo(() => days.map((d) => layout(onDay(events, d).filter((i) => !i.allDay && !multiDay(i)), d)), [days, events])
	const hours = Array.from({ length: 24 }, (_, h) => h)
	const cols = { gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }
	const pickAt = (d: Date, e: React.MouseEvent<HTMLDivElement>) => {
		const y = e.clientY - e.currentTarget.getBoundingClientRect().top
		const mins = Math.floor((y / HOUR) * 2) * 30
		onPick(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, mins), false)
	}
	return (
		<div className="cal-tg">
			<div className="cal-tg__head" style={cols}>
				<div className="cal-tg__tz">{Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value}</div>
				{days.map((d) => (
					<button key={d.getTime()} type="button" className={'cal-tg__day' + (sameDay(d, now) ? ' cal-tg__day--today' : '')} onClick={() => goDay(d)}>
						<span className="cal-tg__dow">{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
						<span className="cal-tg__num">{d.getDate()}</span>
					</button>
				))}
			</div>
			<div className="cal-tg__allday" style={cols}>
				<div className="cal-tg__label">All day</div>
				{days.map((d, i) => (
					<div key={d.getTime()} className="cal-tg__allcell" onClick={(e) => { if (e.target === e.currentTarget) onPick(d, true) }}>
						{allDay[i].map((ev) => (
							<button key={ev.key} type="button" className="cal-chip cal-chip--block" style={{ ['--c' as string]: ev.color }} onClick={() => onOpen(ev)} title={ev.title}><span className="cal-chip__title">{ev.title}</span></button>
						))}
					</div>
				))}
			</div>
			<div className="cal-tg__scroll" ref={scroller}>
				<div className="cal-tg__body" style={{ ...cols, height: 24 * HOUR }}>
					<div className="cal-tg__hours">{hours.map((h) => <div key={h} style={{ height: HOUR }}>{h ? new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' }) : ''}</div>)}</div>
					{days.map((d, i) => (
						<div key={d.getTime()} className="cal-tg__col" onClick={(e) => { if (e.target === e.currentTarget) pickAt(d, e) }}>
							{timed[i].map((p) => (
								<button key={p.inst.key} type="button" className={'cal-ev' + (p.height < HOUR * 0.75 ? ' cal-ev--short' : '')} onClick={() => onOpen(p.inst)}
									style={{ top: p.top, height: Math.max(p.height - 2, 18), left: `calc(${(p.col / p.cols) * 100}% + 2px)`, width: `calc(${100 / p.cols}% - 4px)`, ['--c' as string]: p.inst.color }}>
									<span className="cal-ev__title">{p.inst.title}</span>
									<span className="cal-ev__time">{fmtTime(p.inst.start)} – {fmtTime(p.inst.end)}{p.inst.location ? ` · ${p.inst.location}` : ''}</span>
								</button>
							))}
							{sameDay(d, now) && <div className="cal-now" style={{ top: (now.getHours() + now.getMinutes() / 60) * HOUR }} />}
						</div>
					))}
				</div>
			</div>
		</div>
	)
}

export function MiniMonth({ value, onPick, marks }: { value: Date, onPick: (d: Date) => void, marks: Set<string> }) {
	const [month, setMonth] = useState(new Date(value.getFullYear(), value.getMonth(), 1))
	useEffect(() => { setMonth(new Date(value.getFullYear(), value.getMonth(), 1)) }, [value.getFullYear(), value.getMonth()]) // eslint-disable-line react-hooks/exhaustive-deps
	const start = startOfWeek(month)
	const days = Array.from({ length: 42 }, (_, i) => addDays(start, i))
	const today = new Date()
	return (
		<div className="cal-mini">
			<div className="cal-mini__head">
				<IconButton icon="chevronLeft" label="Previous month" onClick={() => setMonth(addMonths(month, -1))} />
				<span>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
				<IconButton icon="chevronRight" label="Next month" onClick={() => setMonth(addMonths(month, 1))} />
			</div>
			<div className="cal-mini__grid">
				{weekdayNames('narrow').map((n, i) => <span key={i} className="cal-mini__dow">{n}</span>)}
				{days.map((d) => (
					<button key={d.getTime()} type="button" onClick={() => onPick(d)}
						className={'cal-mini__day' + (d.getMonth() !== month.getMonth() ? ' cal-mini__day--out' : '') + (sameDay(d, today) ? ' cal-mini__day--today' : '') + (sameDay(d, value) ? ' cal-mini__day--sel' : '')}>
						{d.getDate()}
						{marks.has(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`) && <i />}
					</button>
				))}
			</div>
		</div>
	)
}
