// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public demo (v3): the Bun server says whether this instance is the public
// demo (GET /core/web/dist/demo.json, see server/publicdemo.ts). The shell then
// shows a banner with a Feedback link, and the login page the shared accounts.
import { useEffect, useState } from 'react'

export interface DemoInfo {
	enabled: boolean
	feedbackUrl?: string
	resetAt?: string
	accounts?: Array<{ user: string, password: string, label: string }>
}

let cached: Promise<DemoInfo> | null = null

/** Asked once per page; any error means "not a demo". */
export function loadDemo(): Promise<DemoInfo> {
	cached ??= fetch('/core/web/dist/demo.json', { credentials: 'same-origin' })
		.then((r) => (r.ok ? r.json() : { enabled: false }))
		.then((j) => (j && j.enabled === true ? j as DemoInfo : { enabled: false }))
		.catch(() => ({ enabled: false }))
	return cached
}

/** For tests. */
export function resetDemoCache() { cached = null }

export function useDemo(): DemoInfo {
	const [d, setD] = useState<DemoInfo>({ enabled: false })
	useEffect(() => { let live = true; loadDemo().then((x) => { if (live) setD(x) }); return () => { live = false } }, [])
	return d
}

const BANNER_KEY = 'wavium.demo-banner'
export const bannerHidden = () => { try { return sessionStorage.getItem(BANNER_KEY) === '0' } catch { return false } }
export const hideBanner = () => { try { sessionStorage.setItem(BANNER_KEY, '0') } catch { /* shown again next page */ } }
