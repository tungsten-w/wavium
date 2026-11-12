// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Apps (admin): Atrium's decentralized app store. Every app in the apps
// directories can be enabled or disabled; more apps come from a git URL.
import { useState } from 'react'
import { confirmPassword, HttpError, ocs, useAsync, type Session } from '@atrium/sdk'
import { Button, Card, Chip, Icon, IconButton, SearchBar, Spinner, Switch, TextField, confirmDialog, toast } from '@atrium/ui'

interface LocalApp {
	id: string
	name: string
	summary: string
	version: string
	active: boolean
	shipped: boolean
	internal: boolean
	removable: boolean
	icon: string | null
	groups: string[]
	git: { url: string, commit: string } | null
	updatable: boolean
}

type Filter = 'all' | 'enabled' | 'disabled' | 'git'

export function Apps({ session }: { session: Session }) {
	const list = useAsync(() => ocs<LocalApp[]>('apps/appstore/api/v1/local'), [])
	const [search, setSearch] = useState('')
	const [filter, setFilter] = useState<Filter>('all')
	const [busy, setBusy] = useState<string | null>(null)
	const [gitUrl, setGitUrl] = useState('')
	const [gitRef, setGitRef] = useState('')

	async function run(id: string, done: string, fn: (auth: Record<string, string>) => Promise<unknown>) {
		setBusy(id)
		try {
			const auth = await confirmPassword(session.user.id, 'Confirm your password to change apps.')
			await fn(auth)
			toast(done)
			list.reload()
		} catch (e) {
			if (!(e instanceof HttpError && e.status === 0)) toast.error(e instanceof Error ? e.message : String(e))
		}
		setBusy(null)
	}

	const toggle = (a: LocalApp) => run(a.id, a.active ? `${a.name} disabled` : `${a.name} enabled`, (auth) =>
		ocs(`apps/appstore/api/v1/apps/${a.active ? 'disable' : 'enable'}`, { body: { appId: a.id }, headers: auth }))
	const remove = async (a: LocalApp) => {
		if (await confirmDialog(`Remove ${a.name}? Its folder is deleted; its data stays in the database.`, { confirm: 'Remove', danger: true })) {
			void run(a.id, `${a.name} removed`, (auth) => ocs('apps/appstore/api/v1/apps/uninstall', { body: { appId: a.id }, headers: auth }))
		}
	}
	const update = (a: LocalApp) => run(a.id, `${a.name} updated`, (auth) => ocs('apps/appstore/api/v1/local/git/update', { body: { appId: a.id }, headers: auth }))
	const install = (e: React.FormEvent) => {
		e.preventDefault()
		void run('git', 'App installed', async (auth) => {
			const r = await ocs<{ id: string, name: string }>('apps/appstore/api/v1/local/git', { body: { url: gitUrl, ref: gitRef }, headers: auth })
			setGitUrl(''); setGitRef('')
			toast(`${r.name} installed and enabled. Reload to see it in the header.`)
		})
	}

	const q = search.toLowerCase()
	const apps = (list.data ?? []).filter((a) =>
		(filter === 'all' || (filter === 'enabled' && a.active) || (filter === 'disabled' && !a.active) || (filter === 'git' && a.git))
		&& (!q || a.name.toLowerCase().includes(q) || a.id.includes(q) || a.summary.toLowerCase().includes(q)))

	return (
		<section className="settings-section settings-section--wide">
			<h2 className="at-headline">Apps</h2>
			<p className="at-muted">Every app in the apps folder can be turned on or off. Add more from a git repository.</p>

			<Card className="settings-block">
				<h3>Install from git</h3>
				<form onSubmit={install} className="settings-row">
					<TextField label="Repository URL" type="url" placeholder="https://git.example.com/me/my_app.git" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} required icon="download" />
					<TextField label="Branch or tag (optional)" value={gitRef} onChange={(e) => setGitRef(e.target.value)} style={{ maxWidth: 220 }} />
					<Button type="submit" icon="add" busy={busy === 'git'} disabled={!gitUrl}>Install</Button>
				</form>
				<p className="at-muted" style={{ margin: '8px 0 0', fontSize: 13 }}>The repository needs <code>appinfo/info.xml</code> at its root and its built files (a release branch or tag).</p>
			</Card>

			<div style={{ display: 'flex', flexDirection: 'column', gap: 12, margin: '8px 0 12px' }}>
				<SearchBar value={search} onChange={setSearch} placeholder="Search apps" />
				<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
					{(['all', 'enabled', 'disabled', 'git'] as Filter[]).map((f) => (
						<Chip key={f} selected={filter === f} onClick={() => setFilter(f)}>{{ all: 'All', enabled: 'Enabled', disabled: 'Disabled', git: 'From git' }[f]}</Chip>
					))}
				</div>
			</div>

			{list.loading && !list.data ? <Spinner /> : list.error ? <p>{list.error.message}</p> : (
				<div className="apps-grid">
					{apps.map((a) => (
						<Card key={a.id} variant="outlined" className="app-card">
							<div className="app-card__head">
								<span className="app-card__icon">{a.icon ? <img src={a.icon} alt="" /> : <Icon name="extension" />}</span>
								<div style={{ flex: 1, minWidth: 0 }}>
									<div className="at-title-s" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
									<div className="at-muted" style={{ fontSize: 12 }}>{a.id} · {a.version}{a.git ? ` · ${a.git.commit}` : ''}</div>
								</div>
								{a.internal
									? <span className="at-label at-muted" title="Always enabled">Core</span>
									: busy === a.id ? <Spinner small /> : <Switch checked={a.active} onChange={() => toggle(a)} aria-label={`${a.active ? 'Disable' : 'Enable'} ${a.name}`} />}
							</div>
							<p className="app-card__summary">{a.summary}</p>
							{(a.git || a.removable || a.updatable) && (
								<div className="app-card__actions">
									{a.git && <a className="at-muted" href={a.git.url.replace(/\.git$/, '')} target="_blank" rel="noreferrer" style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.git.url}</a>}
									{a.git && <IconButton icon="refresh" label={`Update ${a.name}`} onClick={() => update(a)} />}
									{a.removable && <IconButton icon="delete" label={`Remove ${a.name}`} onClick={() => remove(a)} />}
								</div>
							)}
						</Card>
					))}
					{apps.length === 0 && <p className="at-muted">No apps match.</p>}
				</div>
			)}
		</section>
	)
}
