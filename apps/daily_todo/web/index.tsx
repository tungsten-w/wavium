// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Daily Todo for the Atrium shell. Routes below /apps/daily_todo:
//   /                    today (own list)      ?owner=<uid>  a list shared with you
//   /day/YYYY-MM-DD      that day
//   /template /postponed /stats /settings      (always your own list)
// The classic hash links (#day/2026-10-03 from search, #postponed) still work.
import { useCallback, useEffect, useState } from 'react'
import { defineApp, navigate, useApp, useAppPath, useLocation } from '@atrium/sdk'
import { AppLayout, NavItem, NavSection, NavToggle } from '@atrium/ui'
import { api, dateKeyOf, parseKey, type SharedBoard } from './api'
import { DayView } from './DayView'
import { MonthCalendar, PostponedView, SettingsView, StatsView, TemplateView } from './views'
import './style.css'

type View = 'day' | 'template' | 'postponed' | 'stats' | 'settings'
const PAGES: View[] = ['template', 'postponed', 'stats', 'settings']

function DailyTodo() {
	const { basePath, setTitle } = useApp()
	const path = useAppPath()
	const { search, hash } = useLocation()
	const owner = new URLSearchParams(search).get('owner')
	const [shared, setShared] = useState<SharedBoard[]>([])
	const [version, setVersion] = useState(0)
	const bump = useCallback(() => setVersion((v) => v + 1), [])

	// Old hash links: #day/2026-10-03, #template, ...
	useEffect(() => {
		const m = /^#(day|template|postponed|stats|settings)(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(hash)
		if (m) navigate(m[1] === 'day' ? `${basePath}/${m[2] ? 'day/' + m[2] : ''}` : `${basePath}/${m[1]}`, { replace: true })
	}, [hash, basePath])
	useEffect(() => { api.shared().then(setShared, () => setShared([])) }, [])

	const seg = path.split('/').filter(Boolean)
	const view: View = PAGES.includes(seg[0] as View) ? seg[0] as View : 'day'
	const dayKey = seg[0] === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(seg[1] ?? '') ? seg[1] : null
	const date = dayKey ? parseKey(dayKey) : new Date()
	const sharedBy = shared.find((s) => s.owner === owner)?.name
	useEffect(() => { setTitle(view === 'day' ? 'Daily Todo' : `${view.charAt(0).toUpperCase() + view.slice(1)} - Daily Todo`) }, [view, setTitle])

	const withOwner = (p: string, o: string | null = owner) => p + (o ? `?owner=${encodeURIComponent(o)}` : '')
	const pickDate = (d: Date) => {
		const k = dateKeyOf(d)
		navigate(withOwner(k === dateKeyOf(new Date()) ? `${basePath}/` : `${basePath}/day/${k}`))
	}

	const nav = (
		<>
			<NavSection>
				<NavItem icon="today" label="Today" active={view === 'day' && !owner} href={`${basePath}/`} onClick={() => navigate(`${basePath}/`)} />
				<NavItem icon="refresh" label="Template" active={view === 'template'} href={`${basePath}/template`} onClick={() => navigate(`${basePath}/template`)} />
				<NavItem icon="schedule" label="Postponed" active={view === 'postponed'} href={`${basePath}/postponed`} onClick={() => navigate(`${basePath}/postponed`)} />
				<NavItem icon="barChart" label="Stats" active={view === 'stats'} href={`${basePath}/stats`} onClick={() => navigate(`${basePath}/stats`)} />
			</NavSection>
			{shared.length > 0 && (
				<NavSection title="Shared with you">
					{shared.map((s) => <NavItem key={s.owner} icon="person" label={s.name} active={view === 'day' && owner === s.owner} href={withOwner(`${basePath}/`, s.owner)} onClick={() => navigate(withOwner(`${basePath}/`, s.owner))} />)}
				</NavSection>
			)}
			<div className="dt-nav-fill" />
			<MonthCalendar value={date} owner={view === 'day' ? owner : null} version={version} onPick={(d) => { if (view !== 'day') navigate(`${basePath}/day/${dateKeyOf(d)}`); else pickDate(d) }} />
			<NavItem icon="settings" label="Settings" active={view === 'settings'} href={`${basePath}/settings`} onClick={() => navigate(`${basePath}/settings`)} />
		</>
	)

	return (
		<AppLayout nav={nav}>
			<div className="dt-toolbar at-only-mobile"><NavToggle /></div>
			{view === 'day' && <DayView date={date} owner={owner} sharedBy={sharedBy} onDate={pickDate} onChanged={bump} />}
			{view === 'template' && <TemplateView />}
			{view === 'postponed' && <PostponedView onChanged={bump} />}
			{view === 'stats' && <StatsView />}
			{view === 'settings' && <SettingsView />}
		</AppLayout>
	)
}

export default defineApp({ Component: DailyTodo })
