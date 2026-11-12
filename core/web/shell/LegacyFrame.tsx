// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hosts a classic (PHP/Vue) page in an iframe until the app is ported. The Bun
// server hides the classic header in frames (Sec-Fetch-Dest: iframe); this
// component keeps the address bar in sync with the page inside.
import { useEffect, useRef, useState } from 'react'
import { navigate } from '@atrium/sdk'
import { Spinner } from '@atrium/ui'

/** Extra CSS for frames, e.g. hiding the classic settings navigation. */
export function LegacyFrame({ src, css, onTitle }: { src: string, css?: string, onTitle?: (t: string) => void }) {
	const ref = useRef<HTMLIFrameElement>(null)
	const [loading, setLoading] = useState(true)
	// The URL we last told the iframe to load (or that it reported back), so a
	// navigation inside the frame does not reload it.
	const current = useRef<string>(src)
	const [initial] = useState(src)

	useEffect(() => {
		const f = ref.current
		if (!f) return
		if (current.current === src) return
		current.current = src
		setLoading(true)
		f.contentWindow?.location.replace(src)
	}, [src])

	function onLoad() {
		setLoading(false)
		const f = ref.current
		let w: Window | null = null
		try { w = f?.contentWindow ?? null; void w?.location.pathname } catch { return }
		if (!w) return
		const here = w.location.pathname + w.location.search + w.location.hash
		if (w.location.pathname === '/login' || w.location.pathname.startsWith('/login/challenge')) {
			// Session ended inside the frame: log in at top level.
			location.href = here
			return
		}
		if (css) {
			const s = w.document.createElement('style')
			s.textContent = css
			w.document.head?.append(s)
		}
		onTitle?.(w.document.title)
		// Links that leave the classic UI for a shell route open in the shell.
		w.document.addEventListener('click', (e) => {
			const a = (e.target as Element | null)?.closest?.('a') as HTMLAnchorElement | null
			if (!a || a.target === '_blank' || e.defaultPrevented) return
			const u = new URL(a.href, w!.location.href)
			if (u.origin !== location.origin) return
			if (a.getAttribute('href')?.startsWith('#')) return
			if (topLevel(u.pathname) && appOf(u.pathname) !== appOf(w!.location.pathname)) {
				e.preventDefault()
				navigate(u.pathname + u.search + u.hash)
			}
		})
		if (here !== current.current) {
			current.current = here
			if (here !== location.pathname + location.search + location.hash) history.replaceState(null, '', here)
		}
	}

	// Keep the shell URL updated on in-frame history changes (pushState by Vue routers).
	useEffect(() => {
		const t = setInterval(() => {
			let w: Window | null = null
			try { w = ref.current?.contentWindow ?? null; if (!w) return; void w.location.pathname } catch { return }
			const here = w.location.pathname + w.location.search + w.location.hash
			if (here !== current.current && w.location.href !== 'about:blank') {
				current.current = here
				if (here !== location.pathname + location.search + location.hash) history.replaceState(null, '', here)
			}
		}, 500)
		return () => clearInterval(t)
	}, [])

	return (
		<>
			<iframe ref={ref} className="shell-frame" title="App" onLoad={onLoad} src={initial} />
			{loading && <div className="shell-loading"><Spinner /></div>}
		</>
	)
}

const appOf = (p: string) => p.match(/^\/(apps|settings)\/([^/]+)/)?.slice(1).join('/') ?? p
const topLevel = (p: string) => /^\/(apps|settings)\//.test(p)
