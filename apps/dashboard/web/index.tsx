// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dashboard for the Atrium shell. It is the one app without the white panel: widgets
// are cards that float on the wallpaper (the shell adds .shell-body--bare).
// Same API as the classic dashboard (apps/dashboard/lib/Controller/DashboardApiController.php):
//   GET  /ocs/v2.php/apps/dashboard/api/v1/widgets           registered widgets
//   GET  /ocs/v2.php/apps/dashboard/api/v2/widget-items      items (v1 endpoint for widgets without v2)
//   GET|POST /ocs/v2.php/apps/dashboard/api/v3/layout        the user's widget ids, in order
// Widgets that only exist as JavaScript (no item API) cannot be shown here.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defineApp, linkHandler, ocs, useApp } from '@atrium/sdk'
import { Button, Dialog, Icon, IconButton, Spinner, Switch, cx, toast } from '@atrium/ui'
import './style.css'

interface Widget {
	id: string
	title: string
	order: number
	icon_url: string
	widget_url: string | null
	item_icons_round: boolean
	item_api_versions: number[]
	reload_interval: number
	buttons?: { type: string, text: string, link: string }[]
}
interface Item { title: string, subtitle: string, link: string, iconUrl: string, overlayIconUrl?: string, sinceId?: string | number }
interface Items { items: Item[], emptyContentMessage?: string, halfEmptyContentMessage?: string }

const API = 'apps/dashboard/api'
const LIMIT = 7
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function greeting(name: string): string {
	const h = new Date().getHours()
	const part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
	return `${part}, ${name}`
}

/** Items of one widget: v2 when the widget offers it, else v1. */
async function loadItems(w: Widget): Promise<Items> {
	const q = `limit=${LIMIT}&widgets[]=${encodeURIComponent(w.id)}`
	if (w.item_api_versions.includes(2)) {
		const r = await ocs<Record<string, Items>>(`${API}/v2/widget-items?${q}`)
		return r[w.id] ?? { items: [] }
	}
	const r = await ocs<Record<string, Item[]>>(`${API}/v1/widget-items?${q}`)
	return { items: r[w.id] ?? [] }
}
const canShow = (w: Widget) => w.item_api_versions.length > 0

function Dashboard() {
	const { session, setTitle } = useApp()
	const [widgets, setWidgets] = useState<Widget[] | null>(null)
	const [layout, setLayout] = useState<string[]>([])
	const [error, setError] = useState<string | null>(null)
	const [customize, setCustomize] = useState(false)
	const [now, setNow] = useState(() => new Date())

	useEffect(() => { setTitle('Dashboard') }, [setTitle])
	useEffect(() => {
		const t = setInterval(() => setNow(new Date()), 60_000)
		return () => clearInterval(t)
	}, [])
	useEffect(() => {
		let live = true
		Promise.all([ocs<Record<string, Widget>>(`${API}/v1/widgets`), ocs<{ layout: string[] }>(`${API}/v3/layout`)])
			.then(([w, l]) => {
				if (!live) return
				setWidgets(Object.values(w).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)))
				setLayout(l.layout)
			})
			.catch((e) => live && setError(errText(e)))
		return () => { live = false }
	}, [])

	const shown = useMemo(() => {
		if (!widgets) return []
		return layout.map((id) => widgets.find((w) => w.id === id)).filter((w): w is Widget => !!w && canShow(w))
	}, [widgets, layout])

	async function saveLayout(next: string[]) {
		const prev = layout
		setLayout(next)
		try {
			const r = await ocs<{ layout: string[] }>(`${API}/v3/layout`, { method: 'POST', body: { layout: next } })
			setLayout(r.layout)
		} catch (e) {
			setLayout(prev)
			toast.error(`Could not save the dashboard: ${errText(e)}`)
		}
	}

	return (
		<div className="dash">
			<header className="dash-head">
				<h1>{greeting(session.user.displayName)}</h1>
				<p>{now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
				<Button variant="tonal" icon="edit" className="dash-customize" onClick={() => setCustomize(true)}>Customize</Button>
			</header>
			{error && <div className="dash-card dash-note">Could not load the dashboard: {error}</div>}
			{!widgets && !error && <div className="dash-loading"><Spinner /></div>}
			{widgets && !shown.length && (
				<div className="dash-card dash-note">
					<Icon name="dashboard" size="l" />
					<p>No widgets yet. Pick the ones you want.</p>
					<Button onClick={() => setCustomize(true)}>Customize</Button>
				</div>
			)}
			<div className="dash-grid">
				{shown.map((w) => <WidgetCard key={w.id} widget={w} />)}
			</div>
			<Customize open={customize} onClose={() => setCustomize(false)} widgets={(widgets ?? []).filter(canShow)} layout={layout} onSave={saveLayout} />
		</div>
	)
}

function WidgetCard({ widget: w }: { widget: Widget }) {
	const [data, setData] = useState<Items | null>(null)
	const [error, setError] = useState(false)
	const load = useCallback(() => {
		loadItems(w).then((d) => { setData(d); setError(false) }, () => setError(true))
	}, [w])
	useEffect(() => { load() }, [load])
	// Reload like the classic dashboard: on the widget's interval (when it has one) and when the tab is shown again.
	const loadRef = useRef(load)
	loadRef.current = load
	useEffect(() => {
		const t = w.reload_interval > 0 ? setInterval(() => loadRef.current(), w.reload_interval * 1000) : undefined
		const vis = () => { if (!document.hidden) loadRef.current() }
		document.addEventListener('visibilitychange', vis)
		return () => { if (t) clearInterval(t); document.removeEventListener('visibilitychange', vis) }
	}, [w.reload_interval])

	const more = w.buttons?.find((b) => b.type === 'more') ?? (w.widget_url ? { text: 'Open', link: w.widget_url } : null)
	return (
		<section className="dash-card" aria-label={w.title}>
			<h2>
				{w.icon_url && <img className="dash-card__icon" src={w.icon_url} alt="" />}
				{w.widget_url ? <a href={w.widget_url} onClick={linkHandler}>{w.title}</a> : w.title}
			</h2>
			{!data && !error && <div className="dash-loading"><Spinner small /></div>}
			{error && <p className="dash-empty">Could not load this widget.</p>}
			{data && (data.items.length
				? (
					<ul className="dash-items">
						{data.items.map((it, i) => (
							<li key={`${it.sinceId ?? ''}${i}`}>
								<a href={it.link || undefined} onClick={linkHandler} target={it.link && new URL(it.link, location.href).origin !== location.origin ? '_blank' : undefined} rel="noopener">
									{it.iconUrl ? <img className={cx('dash-item__icon', w.item_icons_round && 'is-round', /\.svg(\?|$)/.test(it.iconUrl) && 'is-mono')} src={it.iconUrl} alt="" /> : <span className={cx('dash-item__icon', w.item_icons_round && 'is-round')} />}
									<span className="dash-item__text">
										<span className="dash-item__title">{it.title}</span>
										{it.subtitle && <span className="dash-item__sub">{it.subtitle}</span>}
									</span>
								</a>
							</li>
						))}
					</ul>
				)
				: <p className="dash-empty">{data.emptyContentMessage || data.halfEmptyContentMessage || 'Nothing to show'}</p>)}
			{data && data.items.length > 0 && data.halfEmptyContentMessage && <p className="dash-empty dash-empty--small">{data.halfEmptyContentMessage}</p>}
			{more && <a className="dash-more" href={more.link} onClick={linkHandler}>{more.text}</a>}
		</section>
	)
}

function Customize({ open, onClose, widgets, layout, onSave }: { open: boolean, onClose: () => void, widgets: Widget[], layout: string[], onSave: (l: string[]) => void }) {
	const known = new Set(widgets.map((w) => w.id))
	const on = layout.filter((id) => known.has(id))
	const off = widgets.filter((w) => !on.includes(w.id))
	const byId = new Map(widgets.map((w) => [w.id, w]))
	// Keep widgets this UI cannot show (JS-only) where they were.
	const keep = (next: string[]) => onSave([...next, ...layout.filter((id) => !known.has(id))])
	const move = (i: number, d: number) => {
		const next = [...on]
		;[next[i], next[i + d]] = [next[i + d], next[i]]
		keep(next)
	}
	return (
		<Dialog open={open} title="Customize the dashboard" onClose={onClose} actions={<Button variant="text" onClick={onClose}>Done</Button>}>
			<ul className="dash-pick">
				{on.map((id, i) => {
					const w = byId.get(id)!
					return (
						<li key={id}>
							<Switch checked label={w.title} onChange={() => keep(on.filter((x) => x !== id))} />
							<IconButton icon="arrowUp" label={`Move ${w.title} up`} disabled={i === 0} onClick={() => move(i, -1)} />
							<IconButton icon="arrowDown" label={`Move ${w.title} down`} disabled={i === on.length - 1} onClick={() => move(i, 1)} />
						</li>
					)
				})}
				{off.map((w) => (
					<li key={w.id}><Switch checked={false} label={w.title} onChange={() => keep([...on, w.id])} /></li>
				))}
			</ul>
		</Dialog>
	)
}

export default defineApp({ Component: Dashboard })
