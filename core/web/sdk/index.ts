// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @atrium/sdk: how React UIs talk to the backend (the unchanged Nextcloud APIs)
// and to the shell. Shared through the import map.
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ComponentType } from 'react'

export * from './dav'
export * from './ical'
export * from './caltime'

// ---------------------------------------------------------------- requests

let token: string | null = null
let tokenPromise: Promise<string> | null = null

/** CSRF token for cookie-authenticated requests (Nextcloud's "requesttoken"). */
export function requestToken(): Promise<string> {
	if (token) return Promise.resolve(token)
	tokenPromise ??= fetch('/csrftoken', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
		.then((r) => r.json())
		.then((j: { token: string }) => (token = j.token))
		.finally(() => { tokenPromise = null })
	return tokenPromise
}
export function setRequestToken(t: string) { token = t }

export class HttpError extends Error {
	constructor(public status: number, message: string, public body?: unknown) {
		super(message)
	}
}

export interface RequestOptions {
	method?: string
	body?: unknown
	headers?: Record<string, string>
	signal?: AbortSignal
	raw?: boolean
}

/** fetch with the session cookie and CSRF token. JSON in, JSON out (unless raw). */
export async function request<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
	const headers: Record<string, string> = { Accept: 'application/json', requesttoken: await requestToken(), ...opts.headers }
	let body: BodyInit | undefined
	if (opts.body instanceof Blob || opts.body instanceof FormData || typeof opts.body === 'string' || opts.body instanceof ArrayBuffer) {
		body = opts.body as BodyInit
	} else if (opts.body !== undefined) {
		body = JSON.stringify(opts.body)
		headers['Content-Type'] = 'application/json'
	}
	const res = await fetch(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin', signal: opts.signal })
	if (res.status === 412 && !opts.headers?.retried) {
		// Token expired (session renewed): fetch a new one once.
		token = null
		return request(url, { ...opts, headers: { ...opts.headers, retried: '1' } })
	}
	if (opts.raw) {
		if (!res.ok) throw new HttpError(res.status, res.statusText)
		return res as unknown as T
	}
	const text = await res.text()
	let data: unknown = text
	try { data = text ? JSON.parse(text) : null } catch {}
	if (!res.ok) {
		const msg = (data as { message?: string, error?: string, ocs?: { meta?: { message?: string } } })
		throw new HttpError(res.status, msg?.ocs?.meta?.message || msg?.message || msg?.error || res.statusText || `HTTP ${res.status}`, data)
	}
	return data as T
}

/** OCS API call: ocs('cloud/user') -> data. */
export async function ocs<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
	const sep = path.includes('?') ? '&' : '?'
	const res = await request<{ ocs: { meta: { status: string, statuscode: number, message: string }, data: T } }>(
		`/ocs/v2.php/${path.replace(/^\//, '')}${sep}format=json`,
		{ ...opts, headers: { 'OCS-APIRequest': 'true', ...opts.headers } },
	)
	return res.ocs.data
}

/** URL of an app route: appUrl('daily_todo', '/api/day/2026-11-01'). */
export const appUrl = (app: string, path = '') => `/apps/${app}${path.startsWith('/') || !path ? path : '/' + path}`

// ---------------------------------------------------------------- session

export interface User {
	id: string
	displayName: string
	email: string | null
	isAdmin: boolean
	groups: string[]
	language: string
	locale: string
	quota?: { used: number, total: number, relative: number, free: number }
}
export interface Capabilities {
	theming?: { name: string, color: string, 'color-text': string, logo: string, background: string, 'background-plain'?: boolean, 'background-text'?: string, slogan: string, url: string }
	core?: { webdav_root?: string }
	[app: string]: unknown
}
export interface NavEntry { id: string, name: string, href: string, icon: string, order: number, unread: number, type: string, app?: string }

export interface SettingsSectionInfo { id: string, name: string, icon: string }
export interface AgentGrantInfo { area: string, actions: string[], full: boolean }
export interface AgentInfo { uid: string, displayName: string, description: string, createdAt: number, grants: AgentGrantInfo[] }

export interface Session {
	user: User
	capabilities: Capabilities
	apps: NavEntry[]
	settings: NavEntry[]
	/** Apps enabled for this user (core/atrium/session). */
	enabledApps: string[]
	/** Classic settings sections the user may open. */
	settingsSections: { personal: SettingsSectionInfo[], admin: SettingsSectionInfo[] }
	/** Agents owned by this user (phase 3 fills these in). */
	agents: AgentInfo[]
	isAgent: boolean
}

export async function loadSession(): Promise<Session | null> {
	let u: Record<string, unknown>
	try {
		u = await ocs('cloud/user')
	} catch (e) {
		if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return null
		throw e
	}
	const [caps, apps, settings, atrium] = await Promise.all([
		ocs<{ capabilities: Capabilities }>('cloud/capabilities').then((c) => c.capabilities).catch(() => ({} as Capabilities)),
		ocs<NavEntry[]>('core/navigation/apps?absolute=false').catch(() => []),
		ocs<NavEntry[]>('core/navigation/settings?absolute=false').catch(() => []),
		ocs<{ enabledApps: string[], agents: AgentInfo[], settings: Session['settingsSections'], user: { isAdmin: boolean, isAgent: boolean } }>('core/atrium/session').catch(() => null),
	])
	const groups = (u.groups as string[]) ?? []
	return {
		user: {
			id: String(u.id),
			displayName: String(u.displayname ?? u['display-name'] ?? u.id),
			email: (u.email as string) ?? null,
			isAdmin: atrium?.user.isAdmin ?? groups.includes('admin'),
			groups,
			language: String(u.language ?? 'en'),
			locale: String(u.locale ?? ''),
			quota: u.quota as User['quota'],
		},
		capabilities: caps,
		apps: apps.sort((a, b) => a.order - b.order),
		settings,
		enabledApps: atrium?.enabledApps ?? apps.map((a) => a.app ?? a.id),
		settingsSections: atrium?.settings ?? { personal: [], admin: [] },
		agents: atrium?.agents ?? [],
		isAgent: atrium?.user.isAgent ?? false,
	}
}

// ---------------------------------------------------------------- password confirmation

let confirmedPassword: { user: string, password: string, at: number } | null = null
let passwordPrompt: ((reason?: string) => Promise<string | null>) | null = null
/** The shell registers the dialog that asks for the password. */
export function setPasswordPrompt(fn: (reason?: string) => Promise<string | null>) { passwordPrompt = fn }

/**
 * Headers for actions behind PasswordConfirmationRequired. Asks for the password
 * (at most every 10 minutes), confirms it with /login/confirm for the normal
 * check and returns Basic auth for the strict one. Throws if the user cancels.
 */
export async function confirmPassword(user: string, reason?: string): Promise<Record<string, string>> {
	if (!confirmedPassword || confirmedPassword.user !== user || Date.now() - confirmedPassword.at > 10 * 60_000) {
		if (!passwordPrompt) throw new Error('No password prompt registered')
		for (;;) {
			const password = await passwordPrompt(reason)
			if (password === null) throw new HttpError(0, 'Cancelled')
			try {
				await request('/login/confirm', { body: { password } })
				confirmedPassword = { user, password, at: Date.now() }
				break
			} catch (e) {
				if (!(e instanceof HttpError) || e.status !== 403) throw e
				reason = 'Wrong password, try again'
			}
		}
	}
	const bytes = new TextEncoder().encode(`${user}:${confirmedPassword.password}`)
	return { Authorization: 'Basic ' + btoa(String.fromCharCode(...bytes)) }
}

export const avatarUrl = (user: string, size = 64) => `/avatar/${encodeURIComponent(user)}/${size}`

// ---------------------------------------------------------------- routing

// The shell owns the browser history. Apps read the location with useLocation()
// and change it with navigate(); links inside the shell stay real URLs.
type Loc = { pathname: string, search: string, hash: string }
const subs = new Set<() => void>()
let loc: Loc = typeof location !== 'undefined' ? { pathname: location.pathname, search: location.search, hash: location.hash } : { pathname: '/', search: '', hash: '' }
function refresh() {
	const n = { pathname: location.pathname, search: location.search, hash: location.hash }
	if (n.pathname !== loc.pathname || n.search !== loc.search || n.hash !== loc.hash) {
		loc = n
		subs.forEach((s) => s())
	}
}
if (typeof window !== 'undefined') window.addEventListener('popstate', refresh)

export function navigate(to: string, opts: { replace?: boolean } = {}) {
	const url = new URL(to, location.href)
	if (url.origin !== location.origin) { location.href = to; return }
	history[opts.replace ? 'replaceState' : 'pushState'](null, '', url.pathname + url.search + url.hash)
	refresh()
}
export function useLocation(): Loc {
	return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb) }, () => loc)
}
export function useQuery(): URLSearchParams {
	const { search } = useLocation()
	return new URLSearchParams(search)
}
/** Click handler for <a href> that navigates inside the shell. */
export function linkHandler(e: React.MouseEvent<HTMLAnchorElement>) {
	if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
	const a = e.currentTarget
	if (a.target && a.target !== '_self') return
	const url = new URL(a.href, location.href)
	if (url.origin !== location.origin) return
	e.preventDefault()
	navigate(url.pathname + url.search + url.hash)
}

// ---------------------------------------------------------------- app modules

/** What the shell gives an app. */
export interface AppContext {
	appId: string
	/** "/apps/<id>" */
	basePath: string
	session: Session
	setTitle(title: string): void
}
export const AppCtx = createContext<AppContext | null>(null)
export function useApp(): AppContext {
	const c = useContext(AppCtx)
	if (!c) throw new Error('useApp() outside an Atrium app')
	return c
}
/** Path below the app's base path: "/apps/files/foo" -> "/foo". */
export function useAppPath(): string {
	const { basePath } = useApp()
	const { pathname } = useLocation()
	return pathname.startsWith(basePath) ? pathname.slice(basePath.length) || '/' : '/'
}

export interface SettingsSection {
	id: string
	label: string
	icon?: string
	/** 'personal' (every user) or 'admin' */
	scope: 'personal' | 'admin'
	Component: ComponentType
}

/**
 * The module an app's web build exports (apps/<id>/web/index.tsx):
 *   export default defineApp({ Component: MyApp, settings: [...] })
 */
export interface AtriumAppModule {
	Component?: ComponentType
	settings?: SettingsSection[]
}
export const defineApp = (m: AtriumAppModule) => m

// ---------------------------------------------------------------- helpers

/** Load data in a component: const { data, error, loading, reload } = useAsync(() => ocs(...), [deps]) */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
	const [state, setState] = useState<{ data?: T, error?: Error, loading: boolean }>({ loading: true })
	const [n, setN] = useState(0)
	useEffect(() => {
		let live = true
		setState((s) => ({ ...s, loading: true }))
		fn().then((data) => live && setState({ data, loading: false }), (error) => live && setState({ error, loading: false }))
		return () => { live = false }
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...deps, n])
	return { ...state, reload: () => setN((x) => x + 1), setData: (data: T) => setState({ data, loading: false }) }
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`
	const u = ['KB', 'MB', 'GB', 'TB']
	let i = -1
	do { n /= 1024; i++ } while (n >= 1024 && i < u.length - 1)
	return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`
}
export function formatDate(d: Date | string | number, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
	return new Intl.DateTimeFormat(undefined, opts).format(new Date(d))
}
export function relativeTime(d: Date | string | number): string {
	const diff = (new Date(d).getTime() - Date.now()) / 1000
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
	const abs = Math.abs(diff)
	if (abs < 60) return rtf.format(Math.round(diff), 'second')
	if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
	if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
	if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day')
	return formatDate(d)
}
