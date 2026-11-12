// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Accounts (admin): provisioning API cloud/users + cloud/groups.
import { useState } from 'react'
import { avatarUrl, confirmPassword, formatBytes, HttpError, ocs, useAsync, type Session } from '@atrium/sdk'
import { Avatar, Button, Card, Chip, Dialog, Icon, Menu, SearchBar, Spinner, TextField, confirmDialog, toast, useDebounced, IconButton } from '@atrium/ui'

interface UserDetails {
	id: string
	displayname: string
	email: string | null
	enabled: boolean
	groups: string[]
	lastLogin: number
	quota: { used: number, quota: number, relative: number }
	backend: string
}

export function Users({ session }: { session: Session }) {
	const [search, setSearch] = useState('')
	const [group, setGroup] = useState<string | null>(null)
	const q = useDebounced(search)
	const groups = useAsync(() => ocs<{ groups: string[] }>('cloud/groups').then((g) => g.groups), [])
	const users = useAsync(async () => {
		const path = group
			? `cloud/groups/${encodeURIComponent(group)}/users/details?search=${encodeURIComponent(q)}&limit=100`
			: `cloud/users/details?search=${encodeURIComponent(q)}&limit=100`
		const r = await ocs<{ users: Record<string, UserDetails> | UserDetails[] }>(path)
		return Object.values(r.users).filter((u) => u && u.id)
	}, [q, group])
	const [creating, setCreating] = useState(false)

	async function act(label: string, fn: (auth: Record<string, string>) => Promise<unknown>) {
		try {
			const auth = await confirmPassword(session.user.id)
			await fn(auth)
			toast(label)
			users.reload()
		} catch (e) {
			if (!(e instanceof HttpError && e.status === 0)) toast.error(e instanceof Error ? e.message : String(e))
		}
	}

	return (
		<section className="settings-section settings-section--wide">
			<div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
				<div style={{ flex: 1 }}>
					<h2 className="at-headline">Accounts</h2>
					<p className="at-muted" style={{ margin: '4px 0 0' }}>People and agents with an account on this server.</p>
				</div>
				<Button icon="add" onClick={() => setCreating(true)}>New account</Button>
			</div>
			<div style={{ margin: '20px 0 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
				<SearchBar value={search} onChange={setSearch} placeholder="Search accounts" />
				<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
					<Chip selected={group === null} onClick={() => setGroup(null)}>Everyone</Chip>
					{groups.data?.map((g) => <Chip key={g} selected={group === g} onClick={() => setGroup(g)}>{g}</Chip>)}
				</div>
			</div>
			<Card variant="outlined" style={{ padding: 0, overflowX: 'auto' }}>
				{users.loading && !users.data ? <div style={{ padding: 24 }}><Spinner /></div> : users.error ? <p style={{ padding: 16 }}>{users.error.message}</p> : (
					<table className="settings-table">
						<thead><tr><th>Account</th><th>Groups</th><th>Storage</th><th>Last login</th><th /></tr></thead>
						<tbody>
							{users.data!.map((u) => (
								<tr key={u.id} style={{ opacity: u.enabled ? 1 : 0.55 }}>
									<td>
										<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
											<Avatar name={u.displayname || u.id} src={avatarUrl(u.id, 64)} size={36} />
											<div><div style={{ fontWeight: 500 }}>{u.displayname || u.id}{!u.enabled && <span className="at-muted"> (disabled)</span>}</div><div className="at-muted" style={{ fontSize: 13 }}>{u.email || u.id}</div></div>
										</div>
									</td>
									<td>{u.groups.join(', ') || <span className="at-muted">none</span>}</td>
									<td className="at-muted">{formatBytes(u.quota?.used ?? 0)}{u.quota?.quota > 0 ? ` / ${formatBytes(u.quota.quota)}` : ''}</td>
									<td className="at-muted">{u.lastLogin ? new Date(u.lastLogin).toLocaleDateString() : 'never'}</td>
									<td style={{ textAlign: 'right' }}>
										{u.id !== session.user.id && (
											<Menu trigger={(open) => <IconButton icon="moreVert" label={`Actions for ${u.id}`} onClick={open} />} items={[
												u.enabled
													? { label: 'Disable', icon: 'lock', onClick: () => act('Account disabled', (auth) => ocs(`cloud/users/${encodeURIComponent(u.id)}/disable`, { method: 'PUT', headers: auth })) }
													: { label: 'Enable', icon: 'check', onClick: () => act('Account enabled', (auth) => ocs(`cloud/users/${encodeURIComponent(u.id)}/enable`, { method: 'PUT', headers: auth })) },
												{ label: 'Delete', icon: 'delete', danger: true, onClick: async () => { if (await confirmDialog(`Delete ${u.id} and all their files?`, { confirm: 'Delete', danger: true })) void act('Account deleted', (auth) => ocs(`cloud/users/${encodeURIComponent(u.id)}`, { method: 'DELETE', headers: auth })) } },
											]} />
										)}
									</td>
								</tr>
							))}
							{users.data!.length === 0 && <tr><td colSpan={5} className="at-muted" style={{ textAlign: 'center', padding: 24 }}><Icon name="person" /> No accounts found</td></tr>}
						</tbody>
					</table>
				)}
			</Card>
			<NewAccount open={creating} groups={groups.data ?? []} onClose={() => setCreating(false)} onCreate={(body) => act('Account created', (auth) => ocs('cloud/users', { body, headers: auth })).then(() => setCreating(false))} />
		</section>
	)
}

function NewAccount({ open, groups, onClose, onCreate }: { open: boolean, groups: string[], onClose: () => void, onCreate: (body: Record<string, unknown>) => Promise<void> }) {
	const [userid, setId] = useState('')
	const [displayName, setName] = useState('')
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [sel, setSel] = useState<string[]>([])
	const [busy, setBusy] = useState(false)
	return (
		<Dialog open={open} title="New account" onClose={onClose} actions={<>
			<Button variant="text" onClick={onClose}>Cancel</Button>
			<Button type="submit" form="atrium-new-account" busy={busy} disabled={!userid || (!password && !email)}>Create</Button>
		</>}>
			<form id="atrium-new-account" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={async (e) => {
				e.preventDefault()
				setBusy(true)
				await onCreate({ userid, displayName, email, password, groups: sel })
				setBusy(false)
				setId(''); setName(''); setEmail(''); setPassword(''); setSel([])
			}}>
				<TextField label="Account name" value={userid} onChange={(e) => setId(e.target.value)} required autoFocus autoCapitalize="none" />
				<TextField label="Display name" value={displayName} onChange={(e) => setName(e.target.value)} />
				<TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} hint="Without a password, a welcome link is sent here" />
				<TextField label="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
				{groups.length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
					{groups.map((g) => <Chip key={g} selected={sel.includes(g)} onClick={() => setSel((s) => (s.includes(g) ? s.filter((x) => x !== g) : [...s, g]))}>{g}</Chip>)}
				</div>}
			</form>
		</Dialog>
	)
}
