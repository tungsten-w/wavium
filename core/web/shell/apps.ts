// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// React app modules built by build/atrium/web-build.ts (core/web/dist/apps.json).
import type { AtriumAppModule, NavEntry, Session } from '@atrium/sdk'

export interface AppManifest {
	route: string
	app: string
	entry: string
	css: string[]
	hash: string
	url: string
	/** Classic app whose navigation entry this UI takes over (e.g. "contacts"). */
	replaces?: string
}
export type AppIndex = Record<string, AppManifest>

export async function loadAppIndex(): Promise<AppIndex> {
	try {
		const res = await fetch('/core/web/dist/apps.json', { cache: 'no-cache' })
		return res.ok ? await res.json() : {}
	} catch {
		return {}
	}
}

/** React UI for /apps/<route>/..., if one is built and its app is enabled. */
export function findApp(index: AppIndex, session: Session, pathname: string): AppManifest | null {
	const m = pathname.match(/^\/apps\/([^/]+)/)
	if (!m) return null
	const man = index[m[1]]
	return man && session.enabledApps.includes(man.app) ? man : null
}

const cache = new Map<string, Promise<AtriumAppModule>>()
export function importApp(man: AppManifest): Promise<AtriumAppModule> {
	const key = man.app + man.hash
	let p = cache.get(key)
	if (!p) {
		for (const css of man.css) {
			const href = `${man.url}${css}?v=${man.hash}`
			if (!document.querySelector(`link[href="${href}"]`)) {
				const l = document.createElement('link')
				l.rel = 'stylesheet'
				l.href = href
				document.head.append(l)
			}
		}
		p = import(/* @vite-ignore */ `${man.url}${man.entry}?v=${man.hash}`).then((mod) => (mod.default ?? mod) as AtriumAppModule)
		cache.set(key, p)
	}
	return p
}

/** Header entries: the navigation of enabled apps, minus classic apps a React app replaces. */
export function navApps(index: AppIndex, session: Session): NavEntry[] {
	const enabled = Object.values(index).filter((m) => session.enabledApps.includes(m.app))
	const replaced = new Set(enabled.filter((m) => m.replaces).map((m) => m.replaces!))
	// An app whose UI lives on another route (atrium_contacts on /apps/contacts) links there.
	const routeOf = new Map(enabled.filter((m) => m.route !== m.app).map((m) => [m.app, m.route]))
	return session.apps
		.filter((a) => !replaced.has(a.app ?? a.id) && a.type !== 'settings')
		.map((a) => ({ ...(routeOf.has(a.app ?? a.id) ? { ...a, href: `/apps/${routeOf.get(a.app ?? a.id)}/` } : a), icon: versionedIcon(a.icon) }))
}

/**
 * App icons are served with a 6-month cache lifetime, so a browser that once saw an
 * older icon (Daily Todo's checkbox before its sunset) keeps showing it. Bump this
 * whenever an app icon changes: the new URL makes every browser fetch it again.
 */
const ICON_VERSION = '20261101'
const versionedIcon = (icon: string) => icon && !icon.includes('?') ? `${icon}?v=${ICON_VERSION}` : icon
