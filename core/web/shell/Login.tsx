// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Login page. Posts the same form Nextcloud's login page posts (POST /login),
// so brute-force protection, 2FA and login flows keep working unchanged.
import { useEffect, useState } from 'react'
import { request, requestToken } from '@atrium/sdk'
import { applyTheme, readTheming } from './theme'
import { Button, Checkbox, Icon, TextField } from '@atrium/ui'
import { loginBody } from './loginBody'

interface Theming { name: string, slogan: string, logo: string, color: string, background?: string, 'background-plain'?: boolean }

export function Login() {
	const params = new URLSearchParams(location.search)
	const [user, setUser] = useState(params.get('user') ?? '')
	const [password, setPassword] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [remember, setRemember] = useState(true)
	const [busy, setBusy] = useState(false)
	const [mode, setMode] = useState<'login' | 'lost'>('login')
	const [info, setInfo] = useState<string | null>(null)
	const [theming, setTheming] = useState<Theming | null>(null)

	useEffect(() => {
		fetch('/status.php').then((r) => r.json()).then((s) => { if (s.maintenance) setError('The server is in maintenance mode.') }).catch(() => {})
		fetch('/ocs/v2.php/cloud/capabilities?format=json', { headers: { 'OCS-APIRequest': 'true' } })
			.then((r) => r.json()).then((j) => {
				const t = j.ocs.data.capabilities.theming as Theming | undefined
				if (t) {
					setTheming(t)
					readTheming(t as never, false)
					applyTheme(null)
					document.title = t.name
				}
			}).catch(() => {})
	}, [])

	async function login(e: React.FormEvent) {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const redirect = params.get('redirect_url')
			const body = loginBody({
				user, password, remember, redirect,
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				timezoneOffset: -new Date().getTimezoneOffset() / 60,
				requesttoken: await requestToken(),
			})
			const res = await fetch('/login', { method: 'POST', body, credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
			const to = new URL(res.url)
			if (res.status === 429) {
				setError('Too many attempts. Wait a moment and try again.')
			} else if (to.pathname === '/login' || to.pathname === '/login/') {
				setError('Wrong login or password.')
			} else {
				// Logged in (or a 2FA challenge / login flow page): load it for real.
				location.href = to.pathname === '/' && redirect && redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : to.pathname + to.search + to.hash
				return
			}
		} catch (err) {
			setError(String(err))
		}
		setBusy(false)
	}

	async function lost(e: React.FormEvent) {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			await request('/lostpassword/email', { body: { user } })
			setInfo('If this account exists, a reset message has been sent to its email address.')
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		}
		setBusy(false)
	}

	return (
		<div className="login">
			<div className="login-card">
				<div className="login-brand">
					<div className="mark">{theming?.logo ? <img src={theming.logo} alt="" /> : <Icon name="home" size="l" />}</div>
					<div>
						<h1 className="at-headline" style={{ margin: 0 }}>{theming?.name ?? 'Atrium'}</h1>
						{theming?.slogan && <p className="at-muted" style={{ margin: '4px 0 0' }}>{theming.slogan}</p>}
					</div>
				</div>
				{error && <div className="login-error" role="alert" style={{ marginBottom: 16 }}>{error}</div>}
				{mode === 'login' ? (
					<form onSubmit={login}>
						<TextField label="Account name or email" name="user" autoComplete="username" autoCapitalize="none" spellCheck={false} value={user} onChange={(e) => setUser(e.target.value)} required autoFocus={!user} icon="person" />
						<TextField label="Password" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus={!!user} icon="lock" />
						<Checkbox label="Stay signed in" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
						<Button type="submit" block busy={busy} size="l">Log in</Button>
						<Button variant="text" onClick={() => { setMode('lost'); setError(null) }}>Forgot password?</Button>
					</form>
				) : (
					<form onSubmit={lost}>
						<p className="at-muted" style={{ margin: 0 }}>Enter your account name or email to get a reset link.</p>
						<TextField label="Account name or email" value={user} onChange={(e) => setUser(e.target.value)} required autoFocus icon="person" />
						{info && <p style={{ margin: 0 }}>{info}</p>}
						<Button type="submit" block busy={busy} disabled={!!info}>Reset password</Button>
						<Button variant="text" icon="arrowBack" onClick={() => { setMode('login'); setInfo(null); setError(null) }}>Back to login</Button>
					</form>
				)}
			</div>
		</div>
	)
}
