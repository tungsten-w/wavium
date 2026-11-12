// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The logged-in shell: header with the enabled apps, then the current app.
//   /apps/<route>/...  React module if one is built, else the classic page in a frame
//   /settings/...      Settings (React sections + classic sections in a frame)
//   /                  default app
import { Component, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AppCtx, avatarUrl, linkHandler, navigate, setPasswordPrompt, useLocation, type AppContext, type AtriumAppModule, type NavEntry, type Session } from '@atrium/sdk'
import { Avatar, Badge, Button, Dialog, Icon, IconButton, Menu, Spinner, TextField } from '@atrium/ui'
import { findApp, importApp, navApps, type AppIndex, type AppManifest } from './apps'
import { LegacyFrame } from './LegacyFrame'
import { Search } from './Search'
import { Settings } from './settings/Settings'

export function Shell({ session, index }: { session: Session, index: AppIndex }) {
	const { pathname, search, hash } = useLocation()
	const allApps = useMemo(() => navApps(index, session), [index, session])
	// The Dashboard is home (the logo opens it), not an app in the header.
	const [order, setOrder] = useState<string[]>(readOrder)
	const apps = useMemo(() => {
		const list = allApps.filter((a) => a.id !== 'dashboard' && a.app !== 'dashboard')
		// The user's own order first; apps they never placed keep the default order after.
		const rank = (a: NavEntry) => { const i = order.indexOf(a.id); return i < 0 ? order.length : i }
		return list.map((a, i) => [a, i] as const).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([a]) => a)
	}, [allApps, order])
	const [dragId, setDragId] = useState<string | null>(null)
	const moveApp = (from: string, to: string) => {
		if (from === to) return
		const ids = apps.map((a) => a.id).filter((id) => id !== from)
		ids.splice(ids.indexOf(to), 0, from)
		setOrder(ids)
		try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)) } catch { /* order is not remembered */ }
	}
	const home = allApps.find((a) => a.id === 'dashboard' || a.app === 'dashboard')?.href ?? apps[0]?.href ?? '/settings/user'
	const [picker, setPicker] = useState(false)

	useEffect(() => {
		if (pathname === '/' || pathname === '/index.php' || pathname === '/index.php/') {
			navigate(home, { replace: true })
		}
	}, [pathname, home])

	const active = apps.find((a) => pathname.startsWith(new URL(a.href, location.origin).pathname.replace(/\/$/, '') + '/') || pathname === new URL(a.href, location.origin).pathname.replace(/\/$/, ''))
	const logout = session.settings.find((s) => s.id === 'logout')

	let body: ReactNode
	if (pathname.startsWith('/settings')) {
		body = <Settings session={session} index={index} />
	} else {
		const man = findApp(index, session, pathname)
		body = man
			? <ReactApp key={man.app} man={man} session={session} />
			: pathname === '/' ? null : <LegacyFrame src={pathname + search + hash} />
	}

	return (
		<div className="shell">
			<PasswordPrompt />
			<header className="shell-header">
				<div className="shell-left">
				<IconButton className="shell-picker-btn" icon="apps" label="Apps" onClick={() => setPicker(true)} />
				<a className="shell-logo" href={home} onClick={linkHandler} title={session.capabilities.theming?.name}>
					{session.capabilities.theming?.logo ? <img src={session.capabilities.theming.logo} alt="" /> : <Icon name="home" />}
				</a>
				<Search />
				</div>
				<nav className="shell-apps" aria-label="Apps">
					{apps.map((a) => <AppLink key={a.id} app={a} active={a === active} dragging={dragId === a.id} onDragStart={() => setDragId(a.id)} onDragEnd={() => setDragId(null)} onDropOn={() => { if (dragId) moveApp(dragId, a.id); setDragId(null) }} />)}
				</nav>
				<div className="shell-user">
					<Menu
						trigger={(open, expanded) => (
							<button className="shell-user-btn" aria-label="Account menu" aria-expanded={expanded} onClick={open}>
								<Avatar name={session.user.displayName} src={avatarUrl(session.user.id, 64)} size={34} />
							</button>
						)}
						items={[
							{ label: session.user.displayName, icon: 'person', onClick: () => navigate('/settings/user') },
							{ label: 'Settings', icon: 'settings', onClick: () => navigate('/settings/user') },
							session.user.isAdmin && { label: 'Apps', icon: 'extension', onClick: () => navigate('/settings/apps') },
							session.user.isAdmin && { label: 'Accounts', icon: 'group', onClick: () => navigate('/settings/users') },
							!!logout && { label: 'Log out', icon: 'logout', href: logout!.href },
						]}
					/>
				</div>
			</header>
			<div className={`shell-body${pathname.startsWith('/apps/dashboard') ? ' shell-body--bare' : ''}`}>{body}</div>
			<Dialog open={picker} title="Apps" onClose={() => setPicker(false)}>
				<div className="shell-picker">
					{apps.map((a) => (
						<a key={a.id} href={a.href} onClick={(e) => { setPicker(false); linkHandler(e) }}>
							<span className="ic"><img src={a.icon} alt="" /></span>
							{a.name}
						</a>
					))}
				</div>
			</Dialog>
		</div>
	)
}

const ORDER_KEY = 'atrium-app-order'
function readOrder(): string[] {
	try { const v = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}

/** An app in the header. Drag it onto another to reorder; the order is remembered in this browser. */
function AppLink({ app, active, dragging, onDragStart, onDragEnd, onDropOn }: { app: NavEntry, active: boolean, dragging?: boolean, onDragStart?: () => void, onDragEnd?: () => void, onDropOn?: () => void }) {
	return (
		<a className={'shell-app' + (active ? ' shell-app--active' : '') + (dragging ? ' shell-app--drag' : '')} href={app.href} onClick={linkHandler} aria-current={active ? 'page' : undefined} title={`${app.name} (drag to reorder)`}
			draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', app.id); onDragStart?.() }} onDragEnd={onDragEnd}
			onDragOver={(e) => { if (onDropOn) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }} onDrop={(e) => { e.preventDefault(); onDropOn?.() }}>
			<img src={app.icon} alt="" />
			<span>{app.name}</span>
			{app.unread > 0 && <Badge>{app.unread}</Badge>}
		</a>
	)
}

function ReactApp({ man, session }: { man: AppManifest, session: Session }) {
	const [mod, setMod] = useState<AtriumAppModule | null>(null)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => { importApp(man).then(setMod, (e) => setError(String(e))) }, [man])
	const ctx: AppContext = useMemo(() => ({
		appId: man.app,
		basePath: `/apps/${man.route}`,
		session,
		setTitle: (t: string) => { document.title = t ? `${t} - ${session.capabilities.theming?.name ?? 'Atrium'}` : session.capabilities.theming?.name ?? 'Atrium' },
	}), [man, session])
	if (error) return <div className="shell-loading"><p>Could not load {man.app}: {error}</p></div>
	if (!mod) return <div className="shell-loading"><Spinner /></div>
	const C = mod.Component
	if (!C) return <LegacyFrame src={location.pathname} />
	return (
		<AppCtx.Provider value={ctx}>
			<ErrorBoundary name={man.app}>
				<Suspense fallback={<div className="shell-loading"><Spinner /></div>}><C /></Suspense>
			</ErrorBoundary>
		</AppCtx.Provider>
	)
}

class ErrorBoundary extends Component<{ name: string, children: ReactNode }, { error: Error | null }> {
	state = { error: null as Error | null }
	static getDerivedStateFromError(error: Error) { return { error } }
	render() {
		if (this.state.error) {
			return (
				<div className="shell-loading" style={{ textAlign: 'center', padding: 24 }}>
					<div>
						<Icon name="warning" size="l" />
						<p><strong>{this.props.name}</strong> crashed: {this.state.error.message}</p>
						<Button variant="tonal" onClick={() => this.setState({ error: null })}>Try again</Button>
					</div>
				</div>
			)
		}
		return this.props.children
	}
}

/** Password dialog behind confirmPassword() in the SDK. */
function PasswordPrompt() {
	const [req, setReq] = useState<{ reason?: string, resolve: (v: string | null) => void } | null>(null)
	const [value, setValue] = useState('')
	useEffect(() => {
		setPasswordPrompt((reason) => new Promise((resolve) => { setValue(''); setReq({ reason, resolve }) }))
	}, [])
	const done = (v: string | null) => { req?.resolve(v); setReq(null) }
	return (
		<Dialog open={!!req} title="Confirm your password" onClose={() => done(null)} actions={<>
			<Button variant="text" onClick={() => done(null)}>Cancel</Button>
			<Button type="submit" form="atrium-confirm" disabled={!value}>Confirm</Button>
		</>}>
			<form id="atrium-confirm" onSubmit={(e) => { e.preventDefault(); done(value) }} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
				<p className="at-muted" style={{ margin: 0 }}>{req?.reason ?? 'This action needs your password.'}</p>
				<TextField label="Password" type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
			</form>
		</Dialog>
	)
}
