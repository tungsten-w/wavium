// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Security: password, devices & sessions, app passwords (JSON endpoint
// /settings/personal/authtokens), two-factor (TwoFactor.tsx). Passkeys stay classic for now.
import { useState } from 'react'
import { confirmPassword, HttpError, relativeTime, request, useAsync, type Session } from '@atrium/sdk'
import { Button, Card, Dialog, Icon, IconButton, Spinner, Tabs, TextField, confirmDialog, toast } from '@atrium/ui'
import { LegacyFrame } from '../LegacyFrame'
import { TwoFactor } from './TwoFactor'

interface Token {
	id: number
	name: string
	lastActivity: number
	type: number // 0 = session, 1 = app password
	scope: Record<string, boolean>
	canDelete: boolean
	canRename: boolean
	current?: boolean
}
interface TokenData { app_tokens: Token[], can_create_app_token: boolean }

const FRAME_CSS = '#app-navigation,.app-navigation{display:none!important}#app-content,.app-content{margin-left:0!important;width:100%!important}'

export function Security({ session }: { session: Session }) {
	const [tab, setTab] = useState<'main' | 'classic'>('main')
	return (
		<section className="settings-section settings-section--wide">
			<h2 className="at-headline">Security</h2>
			<p className="at-muted">Your password, two-factor, signed-in devices and app passwords.</p>
			<Tabs tabs={[{ id: 'main', label: 'Passwords & devices' }, { id: 'classic', label: 'Passkeys & more (classic)' }]} value={tab} onChange={setTab} />
			<div style={{ marginTop: 16 }}>
				{tab === 'main' ? <><ChangePassword /><TwoFactor session={session} onClassic={() => setTab('classic')} /><Devices session={session} /></> : <div className="settings-embed"><LegacyFrame src="/settings/user/security" css={FRAME_CSS} /></div>}
			</div>
		</section>
	)
}

function ChangePassword() {
	const [oldpassword, setOld] = useState('')
	const [newpassword, setNew] = useState('')
	const [repeat, setRepeat] = useState('')
	const [busy, setBusy] = useState(false)
	const mismatch = repeat !== '' && repeat !== newpassword

	async function submit(e: React.FormEvent) {
		e.preventDefault()
		setBusy(true)
		try {
			await request('/settings/personal/changepassword', { body: { oldpassword, newpassword } })
			toast('Password changed')
			setOld(''); setNew(''); setRepeat('')
		} catch (err) {
			const body = err instanceof HttpError ? (err.body as { data?: { message?: string } }) : null
			toast.error(body?.data?.message ?? (err instanceof Error ? err.message : String(err)))
		}
		setBusy(false)
	}

	return (
		<Card className="settings-block">
			<h3>Password</h3>
			<form onSubmit={submit} className="settings-row">
				<TextField label="Current password" type="password" autoComplete="current-password" value={oldpassword} onChange={(e) => setOld(e.target.value)} required />
				<TextField label="New password" type="password" autoComplete="new-password" value={newpassword} onChange={(e) => setNew(e.target.value)} required />
				<TextField label="Repeat new password" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required error={mismatch ? 'Does not match' : undefined} />
				<Button type="submit" busy={busy} disabled={!oldpassword || !newpassword || repeat !== newpassword}>Change password</Button>
			</form>
		</Card>
	)
}

function Devices({ session }: { session: Session }) {
	const { data, error, loading, reload } = useAsync(() => request<TokenData>('/settings/personal/authtokens'), [])
	const [name, setName] = useState('')
	const [busy, setBusy] = useState(false)
	const [created, setCreated] = useState<{ loginName: string, token: string } | null>(null)

	async function create(e: React.FormEvent) {
		e.preventDefault()
		setBusy(true)
		try {
			const auth = await confirmPassword(session.user.id, 'Confirm your password to create an app password.')
			const res = await request<{ token: string, loginName: string }>('/settings/personal/authtokens', { body: { name }, headers: auth })
			setCreated(res)
			setName('')
			reload()
		} catch (err) {
			if (!(err instanceof HttpError && err.status === 0)) toast.error(err instanceof Error ? err.message : String(err))
		}
		setBusy(false)
	}

	async function revoke(t: Token) {
		if (!(await confirmDialog(`Revoke "${t.name}"? It will be signed out.`, { confirm: 'Revoke', danger: true }))) return
		try {
			const auth = await confirmPassword(session.user.id, 'Confirm your password to revoke access.')
			await request(`/settings/personal/authtokens/${t.id}`, { method: 'DELETE', headers: auth })
			toast('Access revoked')
			reload()
		} catch (err) {
			if (!(err instanceof HttpError && err.status === 0)) toast.error(err instanceof Error ? err.message : String(err))
		}
	}

	return (
		<Card className="settings-block">
			<h3>Devices & sessions</h3>
			<p className="at-muted" style={{ marginTop: 0 }}>Web, desktop and mobile clients and app passwords that can use your account.</p>
			{loading && !data ? <Spinner /> : error ? <p>{error.message}</p> : (
				<div style={{ overflowX: 'auto' }}>
					<table className="settings-table">
						<thead><tr><th>Device</th><th>Type</th><th>Last activity</th><th /></tr></thead>
						<tbody>
							{[...data!.app_tokens].sort((a, b) => b.lastActivity - a.lastActivity).map((t) => (
								<tr key={t.id}>
									<td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name={t.type === 1 ? 'key' : 'computer'} />{t.name}{t.current && <span className="at-chip at-chip--small">This session</span>}</span></td>
									<td className="at-muted">{t.type === 1 ? 'App password' : 'Session'}</td>
									<td className="at-muted">{relativeTime(t.lastActivity * 1000)}</td>
									<td style={{ textAlign: 'right' }}>{t.canDelete && !t.current && <IconButton icon="delete" label={`Revoke ${t.name}`} onClick={() => revoke(t)} />}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{data?.can_create_app_token && (
				<form onSubmit={create} className="settings-row" style={{ marginTop: 16 }}>
					<TextField label="App name" value={name} onChange={(e) => setName(e.target.value)} required hint="For example: phone, laptop, Nova" />
					<Button type="submit" icon="add" busy={busy} disabled={!name.trim()}>Create app password</Button>
				</form>
			)}
			<Dialog open={!!created} title="New app password" onClose={() => setCreated(null)} actions={<Button onClick={() => setCreated(null)}>Done</Button>}>
				<p className="at-muted" style={{ marginTop: 0 }}>Use these in the app. The password is shown only once.</p>
				<TextField label="Login" value={created?.loginName ?? ''} readOnly onFocus={(e) => e.target.select()} />
				<div style={{ height: 12 }} />
				<TextField label="Password" value={created?.token ?? ''} readOnly onFocus={(e) => e.target.select()} />
				<div style={{ marginTop: 12 }}>
					<Button variant="tonal" icon="check" onClick={() => { void navigator.clipboard?.writeText(created?.token ?? ''); toast('Copied') }}>Copy password</Button>
				</div>
			</Dialog>
		</Card>
	)
}
