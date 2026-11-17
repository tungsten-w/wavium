// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shell entry: decides between the login page and the logged-in shell.
import { createRoot } from 'react-dom/client'
import { HttpError, loadSession, type Session } from '@atrium/sdk'
import { installRipple, Snackbars } from '@atrium/ui'
import { Login } from './Login'
import { Shell } from './Shell'
import { applyTheme } from './theme'
import { loadAppIndex, type AppIndex } from './apps'

installRipple()
const root = createRoot(document.getElementById('atrium')!)

function render(node: React.ReactNode) {
	root.render(<>{node}<Snackbars /></>)
}

async function boot() {
	const path = location.pathname
	if (path === '/login' || path === '/login/') {
		// Already logged in: go where the login was meant to lead.
		const me = await fetch('/ocs/v2.php/cloud/user?format=json', { headers: { 'OCS-APIRequest': 'true' }, credentials: 'same-origin' }).catch(() => null)
		if (me?.ok) {
			location.replace(safeRedirect(new URLSearchParams(location.search).get('redirect_url')))
			return
		}
		applyTheme(null)
		render(<Login />)
		return
	}
	let session: Session | null
	let index: AppIndex
	try {
		;[session, index] = await Promise.all([loadSession(), loadAppIndex()])
	} catch (e) {
		render(<div className="shell-boot"><p>Could not reach the server ({e instanceof HttpError ? e.status : String(e)}). <a href="">Retry</a></p></div>)
		return
	}
	if (!session) {
		const back = location.pathname + location.search + location.hash
		location.replace('/login' + (back !== '/' ? '?redirect_url=' + encodeURIComponent(back) : ''))
		return
	}
	applyTheme(session)
	render(<Shell session={session} index={index} />)
}

/** Only same-origin paths. */
export function safeRedirect(to: string | null): string {
	return to && to.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\') ? to : '/'
}

void boot()
