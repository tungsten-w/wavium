// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Activity for the Atrium shell: the user's activity stream from every app
// (Files, Calendar, Tasks, Contacts, Daily Todo, Notes, ...), over the unchanged
// Activity OCS API. Routes below /apps/activity:
//   /             all activities
//   /<filter>     one filter (self, by, files, calendar, daily_todo, ...), the classic URLs
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { avatarUrl, defineApp, navigate, relativeTime, useApp, useAppPath, useQuery } from '@atrium/sdk'
import { AppLayout, Button, EmptyState, Icon, NavItem, NavSection, NavToggle, Spinner, toast, type IconName } from '@atrium/ui'
import { feed, listFilters, type Activity, type Filter, type Rich, type RichParam } from './api'
import './style.css'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

// Daily Todo's sunset (apps/daily_todo/img/app.svg), recentred on the 24px grid.
const SUNSET = 'M11 2h2v3h-2V2ZM4.22 5.64l1.42-1.42 2.12 2.12-1.42 1.42-2.12-2.12Zm12.02.7 2.12-2.12 1.42 1.42-2.12 2.12-1.42-1.42ZM3 11h3v2H3v-2Zm15 0h3v2h-3v-2Zm-9.9 2a4 4 0 1 1 7.8 0h-2.08a2 2 0 1 0-3.64 0H8.1ZM3 15h18v2H3v-2Zm0 4h12v2H3v-2Zm14 0h4v2h-4v-2Z'
const FILTER_ICONS: Record<string, IconName | string> = {
	all: 'notifications', self: 'person', by: 'group', files_favorites: 'star', files: 'folder', files_sharing: 'share',
	security: 'lock', calendar: 'event', calendar_todo: 'task', contacts: 'contacts', comments: 'description',
	notes: 'notes', daily_todo: SUNSET, systemtags: 'label', mail: 'mail',
}
const APP_ICONS: Record<string, string> = {
	files: 'file', files_sharing: 'share', calendar: 'calendar-event', contacts: 'address-book', comments: 'file-text', systemtags: 'tag',
	notes: 'notes', mail: 'mail', daily_todo: SUNSET, tasks: 'circle-check', twofactor_backupcodes: 'shield-lock', core: 'shield-lock', files_trashbin: 'trash', files_versions: 'restore',
}
const VERB_ICONS: [RegExp, string][] = [
	[/delete|trash|remove/, 'trash'], [/restore/, 'restore'], [/add|create|new/, 'plus'], [/change|edit|update|rename/, 'pencil'],
	[/share|link/, 'share'], [/star|favou?rite/, 'star'], [/comment/, 'file-text'], [/lock|password|security|login/, 'shield-lock'],
]
/** Tabler icon for an event: the verb in the server icon name (file-add.svg), else its app. */
function entryIcon(a: { app: string, icon: string }): string {
	const file = (a.icon || '').split('/').pop() ?? ''
	return VERB_ICONS.find(([re]) => re.test(file))?.[1] ?? APP_ICONS[a.app] ?? 'bell'
}
const localPath = (u: string) => { try { const x = new URL(u, location.href); return x.origin === location.origin ? x.pathname + x.search + x.hash : u } catch { return u } }


function dayLabel(d: Date): string {
	const today = new Date()
	const k = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
	const diff = Math.round((k(today) - k(d)) / 86400000)
	if (diff === 0) return 'Today'
	if (diff === 1) return 'Yesterday'
	return d.toLocaleDateString(undefined, { weekday: diff < 7 ? 'long' : undefined, day: 'numeric', month: 'long', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined })
}

function ActivityApp() {
	const { basePath, setTitle } = useApp()
	const path = useAppPath()
	const query = useQuery()
	const filter = decodeURIComponent(path.split('/').filter(Boolean)[0] ?? query.get('filter') ?? 'all')
	const [filters, setFilters] = useState<Filter[] | null>(null)
	const [items, setItems] = useState<Activity[] | null>(null)
	const [next, setNext] = useState<number | null>(null)
	const [loadingMore, setLoadingMore] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const gen = useRef(0)

	useEffect(() => { listFilters().then(setFilters, (e) => { toast.error(`Could not load filters: ${errText(e)}`); setFilters([]) }) }, [])

	const loadFirst = useCallback(async (quiet = false) => {
		const g = ++gen.current
		if (!quiet) { setItems(null); setNext(null); setError(null) }
		try {
			const r = await feed(filter)
			if (g !== gen.current) return
			setItems((old) => {
				if (!quiet || !old) { setNext(r.next); return r.items }
				// Refresh: put new events on top, keep the pages already loaded.
				const known = new Set(old.map((a) => a.activity_id))
				return [...r.items.filter((a) => !known.has(a.activity_id)), ...old]
			})
		} catch (e) {
			if (g !== gen.current) return
			if (!quiet) { setError(errText(e)); setItems([]) }
		}
	}, [filter])
	useEffect(() => { loadFirst() }, [loadFirst])
	useEffect(() => {
		const onVis = () => { if (!document.hidden) loadFirst(true) }
		document.addEventListener('visibilitychange', onVis)
		const t = setInterval(() => { if (!document.hidden) loadFirst(true) }, 60000)
		return () => { document.removeEventListener('visibilitychange', onVis); clearInterval(t) }
	}, [loadFirst])

	const loadMore = useCallback(async () => {
		if (next === null || loadingMore) return
		const g = gen.current
		setLoadingMore(true)
		try {
			const r = await feed(filter, next)
			if (g !== gen.current) return
			setItems((old) => {
				const known = new Set((old ?? []).map((a) => a.activity_id))
				return [...(old ?? []), ...r.items.filter((a) => !known.has(a.activity_id))]
			})
			setNext(r.next)
		} catch (e) { toast.error(`Could not load more: ${errText(e)}`) } finally { setLoadingMore(false) }
	}, [filter, next, loadingMore])

	// Infinite scroll: load the next page when the end of the list comes into view.
	const sentinel = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const el = sentinel.current
		if (!el || next === null) return
		const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore() }, { rootMargin: '400px' })
		io.observe(el)
		return () => io.disconnect()
	}, [next, loadMore, items])

	const current = filters?.find((f) => f.id === filter)
	const heading = current?.name ?? (filter === 'all' ? 'All activities' : 'Activity')
	useEffect(() => { setTitle(filter === 'all' ? 'Activity' : `${heading} - Activity`) }, [filter, heading, setTitle])

	const groups = useMemo(() => {
		const out: { label: string, items: Activity[] }[] = []
		for (const a of items ?? []) {
			const label = dayLabel(new Date(a.datetime))
			const last = out[out.length - 1]
			if (last && last.label === label) last.items.push(a)
			else out.push({ label, items: [a] })
		}
		return out
	}, [items])

	const go = (id: string) => navigate(id === 'all' ? basePath : `${basePath}/${encodeURIComponent(id)}`)
	const navFor = (f: Filter) => {
		const ic = FILTER_ICONS[f.id] ?? APP_ICONS[f.id] ?? 'bell'
		return <NavItem key={f.id} icon={ic} label={f.name} active={filter === f.id} href={f.id === 'all' ? basePath : `${basePath}/${encodeURIComponent(f.id)}`} onClick={() => go(f.id)} />
	}
	const main = (filters ?? []).filter((f) => f.priority < 10)
	const apps = (filters ?? []).filter((f) => f.priority >= 10)
	const nav = (
		<>
			<NavSection>{filters === null ? <div className="ac-center"><Spinner small /></div> : main.map(navFor)}</NavSection>
			{apps.length > 0 && <NavSection title="Apps">{apps.map(navFor)}</NavSection>}
			<NavSection>
				<NavItem icon="settings" label="Activity settings" href="/settings/user/notifications" onClick={() => navigate('/settings/user/notifications')} />
			</NavSection>
		</>
	)

	return (
		<AppLayout nav={nav}>
			<div className="ac">
				<header className="ac-head">
					<NavToggle />
					<h1 className="ac-title">{heading}</h1>
				</header>
				{items === null ? <div className="ac-center"><Spinner /></div>
					: error ? <EmptyState icon="warning" title="Could not load activities">{error}<div><Button variant="tonal" onClick={() => loadFirst()}>Try again</Button></div></EmptyState>
					: items.length === 0 ? <EmptyState icon="notifications" title="No activity yet">{filter === 'all' ? 'Changes to your files, calendars, tasks, notes and Daily Todo show up here.' : 'Nothing here for this filter yet.'}</EmptyState>
					: (
						<>
							{groups.map((g) => (
								<section key={g.label} className="ac-day">
									<h2 className="ac-day__label">{g.label}</h2>
									<ul className="ac-list">{g.items.map((a) => <Entry key={a.activity_id} a={a} />)}</ul>
								</section>
							))}
							<div ref={sentinel} className="ac-more">
								{loadingMore ? <Spinner small /> : next !== null ? <Button variant="text" onClick={loadMore}>Show older</Button> : <span className="ac-muted">That is everything.</span>}
							</div>
						</>
					)}
			</div>
		</AppLayout>
	)
}

/** Opens same-origin links inside the shell. */
function onLink(e: React.MouseEvent<HTMLAnchorElement>) {
	if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
	const url = new URL(e.currentTarget.href, location.href)
	if (url.origin !== location.origin) return
	e.preventDefault()
	e.stopPropagation()
	navigate(url.pathname + url.search + url.hash)
}

function RichText({ rich, fallback }: { rich: Rich, fallback: string }) {
	const [tpl, params] = rich ?? ['', {}]
	if (!tpl) return <>{fallback}</>
	const p = (Array.isArray(params) ? {} : params) as Record<string, RichParam>
	const parts = tpl.split(/(\{[a-zA-Z0-9_-]+\})/)
	return (
		<>
			{parts.map((s, i) => {
				const m = /^\{([a-zA-Z0-9_-]+)\}$/.exec(s)
				const v = m ? p[m[1]] : undefined
				if (!v) return s
				const name = v.name || v.path || v.id
				if (v.type === 'user') {
					return <span key={i} className="ac-user"><img src={avatarUrl(v.id, 32)} alt="" />{name}</span>
				}
				if (v.type === 'highlight' && !v.link) return <strong key={i}>{name}</strong>
				const link = v.link ? localPath(v.link) : null
				const title = typeof v.path === 'string' && v.path !== name ? v.path : undefined
				return link
					? <a key={i} className="ac-param" href={link} title={title} onClick={onLink}>{name}</a>
					: <strong key={i} title={title}>{name}</strong>
			})}
		</>
	)
}

function Entry({ a }: { a: Activity }) {
	const when = new Date(a.datetime)
	const previews = (a.previews ?? []).filter((p) => !p.isMimeTypeIcon).slice(0, 4)
	const link = a.link ? localPath(a.link) : null
	return (
		<li className={'ac-entry' + (link ? ' ac-entry--link' : '')} onClick={(e) => {
			// The whole row opens the event's link; links inside it open their own target.
			if (!link || (e.target as HTMLElement).closest('a') || getSelection()?.toString()) return
			if (e.metaKey || e.ctrlKey) window.open(link, '_blank', 'noopener')
			else if (new URL(link, location.href).origin === location.origin) navigate(link)
			else window.open(link, '_blank', 'noopener')
		}}>
			<span className="ac-entry__icon"><Icon name={entryIcon(a)} /></span>
			<div className="ac-entry__body">
				<p className="ac-entry__subject"><RichText rich={a.subject_rich} fallback={a.subject} /></p>
				{(a.message || a.message_rich?.[0]) && <p className="ac-entry__message"><RichText rich={a.message_rich} fallback={a.message} /></p>}
				{previews.length > 0 && (
					<div className="ac-previews">
						{previews.map((p) => (
							<a key={p.fileId + p.source} href={localPath(p.link)} onClick={onLink} className="ac-preview" title={p.filePath}>
								<img src={localPath(p.source)} alt="" loading="lazy" />
							</a>
						))}
					</div>
				)}
			</div>
			<time className="ac-entry__time" dateTime={a.datetime} title={when.toLocaleString()}>
				{Date.now() - when.getTime() < 3600_000 ? relativeTime(when) : when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
			</time>
		</li>
	)
}

export default defineApp({ Component: ActivityApp })
