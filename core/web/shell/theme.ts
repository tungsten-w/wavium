// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Theme = mode (per browser) + accent colour + wallpaper (both per user, stored by
// the theming app, so classic pages in frames and other devices match).
import { ocs, request, type Session } from '@atrium/sdk'

export type ThemeMode = 'system' | 'light' | 'dark'
type Theming = NonNullable<Session['capabilities']['theming']>

function read(key: string): string | null {
	try { return localStorage.getItem(key) } catch { return null }
}
function write(key: string, value: string | null) {
	try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value) } catch {}
}

export const getMode = (): ThemeMode => (read('atrium.theme') as ThemeMode) || 'system'

/** The wallpaper setting: 'default' (Atrium's generated one), 'color' (plain), 'custom' or a shipped file name. */
export type WallpaperSetting = string

const state = {
	/** The user's accent; until the session is loaded, the last one seen in this browser (login page). */
	accent: read('atrium.seed'),
	/** The admin's colour, used when the user resets their accent. */
	serverAccent: null as string | null,
	wallpaper: 'default' as WallpaperSetting,
	wallpaperUrl: null as string | null,
	/** The admin themed the background: their image replaces the generated default. */
	adminWallpaper: false,
}

/** Shipped wallpapers that have a dark variant (BackgroundService::SHIPPED_BACKGROUNDS). */
const DARK_VARIANTS: Record<string, string> = {
	'jo-myoung-hee-fluid.webp': 'jo-myoung-hee-fluid-dark.webp',
	'jenna-kim-the-globe.webp': 'jenna-kim-the-globe-dark.webp',
}

function isDark(): boolean {
	const mode = getMode()
	return mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
}

/** Take accent and wallpaper from theming capabilities (logged in: the user's; login page: the server's). */
export function readTheming(t: Theming | undefined, user: boolean) {
	if (!t) return
	const x = t as Theming & Record<string, unknown>
	state.serverAccent = (x.defaultPrimaryColor as string | undefined) ?? t.color
	if (user) {
		state.accent = t.color
		write('atrium.seed', t.color)
	} else if (!state.accent) {
		state.accent = t.color
	}
	state.adminWallpaper = x['background-default'] === false
	state.wallpaper = (x['background-image'] as string | undefined) ?? 'default'
	state.wallpaperUrl = t.background && !t['background-plain'] ? t.background : null
}

export function applyTheme(session: Session | null) {
	if (session) readTheming(session.capabilities.theming, true)
	const el = document.documentElement
	const mode = getMode()
	if (mode === 'system') delete el.dataset.theme
	else el.dataset.theme = mode
	if (state.accent) el.style.setProperty('--at-seed', state.accent)
	else el.style.removeProperty('--at-seed')

	const generated = state.wallpaper === 'default' && !state.adminWallpaper
	let url = generated || state.wallpaper === 'color' ? null : state.wallpaperUrl
	if (url && isDark()) {
		const file = url.split('/').pop()!.split('?')[0]
		if (DARK_VARIANTS[file]) url = url.replace(file, DARK_VARIANTS[file])
	}
	if (url) el.style.setProperty('--at-wallpaper', `url("${url.replace(/"/g, '%22')}")`)
	else el.style.removeProperty('--at-wallpaper')
	el.classList.toggle('at-has-wallpaper', !!url)
	el.classList.toggle('at-wallpaper-atrium', generated)
	write('atrium.wp', JSON.stringify({ g: generated, u: url }))
	const name = session?.capabilities.theming?.name
	if (name) document.title = name
}

export function setMode(mode: ThemeMode) {
	write('atrium.theme', mode === 'system' ? null : mode)
	applyTheme(null)
}

export const getAccent = () => state.accent
export const getServerAccent = () => state.serverAccent
export const getWallpaper = () => state.wallpaper

const PREF = 'apps/provisioning_api/api/v1/config/users/theming/primary_color'
let saveTimer: ReturnType<typeof setTimeout> | undefined
/** Change the accent now; saving waits a moment so dragging the colour picker sends one request. */
export function setAccent(color: string | null) {
	state.accent = color ?? state.serverAccent
	write('atrium.seed', state.accent)
	applyTheme(null)
	clearTimeout(saveTimer)
	saveTimer = setTimeout(() => {
		void (color ? ocs(PREF, { method: 'POST', body: { configValue: color } }) : ocs(PREF, { method: 'DELETE' })).catch(() => {})
	}, 400)
}

/** Pick a wallpaper ('default', 'color' or a shipped file name) and save it in the theming app. */
export async function setWallpaper(value: WallpaperSetting, url: string | null) {
	state.wallpaper = value
	state.wallpaperUrl = url
	applyTheme(null)
	const type = value === 'default' || value === 'color' ? value : 'shipped'
	await request(`/apps/theming/background/${type}`, { method: 'POST', body: type === 'shipped' ? { value } : type === 'color' ? { color: state.accent } : {} })
}

matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(null))
