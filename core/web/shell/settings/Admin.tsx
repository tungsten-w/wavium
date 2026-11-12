// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Admin settings in React: Overview (setup checks), Basic settings (background
// jobs, email), Sharing and Theming, plus the personal Sharing section. Data comes
// from core/atrium/settings/<kind>/<section> (the state the classic forms
// provide); saving goes through the same endpoints the classic pages use.
import { useEffect, useState, type ReactNode } from 'react'
import { confirmPassword, HttpError, ocs, relativeTime, request, useAsync, type Session } from '@atrium/sdk'
import { Button, Card, Icon, Select, Spinner, Switch, TextArea, TextField, toast } from '@atrium/ui'

type State = Record<string, Record<string, unknown>>
/** Server message from an OCS or ajax error body, else the error text. */
export const errText = (e: unknown) => {
	const b = (e as HttpError)?.body as { data?: { message?: string }, message?: string } | undefined
	return b?.data?.message || b?.message || (e instanceof Error ? e.message : String(e))
}
export const loadSection = (kind: 'personal' | 'admin', id: string) => ocs<State>(`core/atrium/settings/${kind}/${id}`)

/** AppConfig write (provisioning API), behind password confirmation. */
export async function setAppConfig(user: string, app: string, key: string, value: string) {
	const auth = await confirmPassword(user, 'Confirm your password to change server settings.')
	await ocs(`apps/provisioning_api/api/v1/config/apps/${app}/${key}`, { method: 'POST', body: { value }, headers: auth })
}
export async function saving(p: Promise<unknown>, ok = 'Saved'): Promise<boolean> {
	try { await p; toast(ok); return true } catch (e) {
		if (!(e instanceof HttpError && e.status === 0)) toast.error(`Could not save: ${errText(e)}`)
		return false
	}
}

export function Section({ title, intro, children, wide }: { title: string, intro?: ReactNode, children: ReactNode, wide?: boolean }) {
	return (
		<section className={'settings-section' + (wide ? ' settings-section--wide' : '')}>
			<h2 className="at-headline">{title}</h2>
			{intro && <p className="at-muted">{intro}</p>}
			{children}
		</section>
	)
}
export function Loading<T>({ data, error, children }: { data: T | undefined, error: unknown, children: (d: T) => ReactNode }) {
	if (error) return <Card className="settings-block"><p className="at-muted">Could not load: {errText(error)}</p></Card>
	if (data === undefined) return <div className="settings-center"><Spinner /></div>
	return <>{children(data)}</>
}

// ---------------------------------------------------------------- Overview

interface Check { name: string, severity: 'success' | 'info' | 'warning' | 'error', description: string | null, descriptionParameters: Record<string, { name?: string }> | null, linkToDoc: string | null }
const SEVERITY: Record<Check['severity'], { icon: string, rank: number }> = { error: { icon: 'warning', rank: 0 }, warning: { icon: 'warning', rank: 1 }, info: { icon: 'info', rank: 2 }, success: { icon: 'check', rank: 3 } }
const describe = (c: Check) => (c.description ?? '').replace(/\{(\w+)\}/g, (m, k) => c.descriptionParameters?.[k]?.name ?? m)

export function Overview({ session: _ }: { session: Session }) {
	const status = useAsync(() => request<{ versionstring: string, productname: string }>('/status.php'), [])
	const checks = useAsync(() => request<Record<string, Record<string, Check>>>('/settings/setupcheck'), [])
	const [showOk, setShowOk] = useState(false)
	const all = Object.entries(checks.data ?? {}).flatMap(([cat, cs]) => Object.values(cs).map((c) => ({ ...c, cat })))
		.sort((a, b) => SEVERITY[a.severity].rank - SEVERITY[b.severity].rank || a.name.localeCompare(b.name))
	const issues = all.filter((c) => c.severity !== 'success')
	return (
		<Section title="Overview" intro={status.data ? `${status.data.productname} ${status.data.versionstring}` : ' '}>
			<Card className="settings-block">
				<div className="settings-head">
					<h3>Security and setup checks</h3>
					<Button variant="text" icon="refresh" busy={checks.loading} onClick={checks.reload}>Check again</Button>
				</div>
				<Loading data={checks.data} error={checks.error}>{() => (
					<>
						<p className={'settings-summary' + (issues.some((c) => c.severity === 'error') ? ' settings-summary--bad' : issues.some((c) => c.severity === 'warning') ? ' settings-summary--warn' : ' settings-summary--ok')}>
							<Icon name={issues.length ? 'warning' : 'check'} />
							{issues.length ? `${issues.filter((c) => c.severity === 'error' || c.severity === 'warning').length} warnings, ${issues.filter((c) => c.severity === 'info').length} notes` : 'All checks passed'}
						</p>
						<ul className="settings-checks">
							{(showOk ? all : issues).map((c) => (
								<li key={c.cat + c.name} className={`settings-check settings-check--${c.severity}`}>
									<Icon name={SEVERITY[c.severity].icon} />
									<div>
										<strong>{c.name}</strong>
										{c.description && <p>{describe(c)}</p>}
										{c.linkToDoc && <a href={c.linkToDoc} target="_blank" rel="noreferrer">Documentation <Icon name="openInNew" size="s" /></a>}
									</div>
								</li>
							))}
						</ul>
						<Button variant="text" onClick={() => setShowOk(!showOk)}>{showOk ? 'Hide passed checks' : `Show ${all.length - issues.length} passed checks`}</Button>
					</>
				)}</Loading>
			</Card>
		</Section>
	)
}

// ---------------------------------------------------------------- Basic settings

interface MailConfig { mail_domain: string, mail_from_address: string, mail_smtpmode: string, mail_smtpsecure: string, mail_smtphost: string, mail_smtpport: string, mail_smtpauth: boolean, mail_smtpname: string, mail_smtppassword: string, mail_sendmailmode: string, mail_noverify: boolean }
interface Opt { label: string, id: string }

export function Server({ session }: { session: Session }) {
	const st = useAsync(() => loadSection('admin', 'server'), [])
	return (
		<Section title="Basic settings">
			<Loading data={st.data} error={st.error}>{(d) => <ServerForm user={session.user.id} s={d.settings ?? {}} />}</Loading>
		</Section>
	)
}

function ServerForm({ user, s }: { user: string, s: Record<string, unknown> }) {
	const [mode, setMode] = useState(String(s.backgroundJobsMode ?? 'ajax'))
	const lastCron = Number(s.lastCron ?? 0)
	const mailMeta = (s.settingsAdminMail ?? {}) as { configIsReadonly?: boolean, smtpModeOptions?: Opt[], smtpEncryptionOptions?: Opt[], smtpSendmailModeOptions?: Opt[] }
	const [mail, setMail] = useState<MailConfig>(s.settingsAdminMailConfig as MailConfig)
	const [password, setPassword] = useState('')
	const [busy, setBusy] = useState<string | null>(null)
	const m = <K extends keyof MailConfig>(k: K, v: MailConfig[K]) => setMail((x) => ({ ...x, [k]: v }))
	const stale = lastCron > 0 && Date.now() / 1000 - lastCron > 3600 * 2

	async function pickMode(v: string) {
		const old = mode
		setMode(v)
		if (!await saving(setAppConfig(user, 'core', 'backgroundjobs_mode', v))) setMode(old)
	}
	async function saveMail() {
		setBusy('save')
		try {
			const auth = await confirmPassword(user, 'Confirm your password to change the email server.')
			const { mail_smtpname: _n, mail_smtppassword: _p, ...rest } = mail
			await request('/settings/admin/mailsettings', { method: 'POST', body: { ...rest, mail_smtpauth: mail.mail_smtpauth }, headers: auth })
			if (mail.mail_smtpauth) await request('/settings/admin/mailsettings/credentials', { method: 'POST', body: { mail_smtpname: mail.mail_smtpname, mail_smtppassword: password || null }, headers: auth })
			setPassword('')
			toast('Email server saved')
		} catch (e) { if (!(e instanceof HttpError && e.status === 0)) toast.error(`Could not save: ${errText(e)}`) } finally { setBusy(null) }
	}
	async function testMail() {
		setBusy('test')
		try { await request('/settings/admin/mailtest', { method: 'POST' }); toast('Test email sent, check your inbox') } catch (e) {
			toast.error(`Could not send: ${errText(e)}`)
		} finally { setBusy(null) }
	}

	return (
		<>
			<Card className="settings-block">
				<h3>Background jobs</h3>
				<p className="at-muted settings-note">
					{lastCron ? <>Last job ran {relativeTime(lastCron * 1000)}.{stale && <strong className="settings-bad"> That is a long time ago, check the cron container.</strong>}</> : 'No background job has run yet.'}
					{s.cronErrors ? <span className="settings-bad"> Errors: {String(s.cronErrors)}</span> : null}
				</p>
				<div className="settings-radios" role="radiogroup" aria-label="Background jobs">
					{[
						{ id: 'cron', label: 'Cron (recommended)', hint: 'A system cron or the cron container calls cron.php every 5 minutes.' },
						{ id: 'webcron', label: 'Webcron', hint: 'An external service calls cron.php over HTTP.' },
						{ id: 'ajax', label: 'AJAX', hint: 'Runs one job on each page load. Unreliable.' },
					].map((o) => (
						<label key={o.id} className={'settings-radio' + (mode === o.id ? ' settings-radio--on' : '')}>
							<input type="radio" name="bgjobs" checked={mode === o.id} onChange={() => pickMode(o.id)} />
							<span><strong>{o.label}</strong><small>{o.hint}</small></span>
						</label>
					))}
				</div>
			</Card>

			<Card className="settings-block">
				<h3>Email server</h3>
				<p className="at-muted settings-note">Used for password resets, notifications and share emails.{mailMeta.configIsReadonly && ' The config file is read-only, so this cannot be changed here.'}</p>
				<fieldset className="settings-form" disabled={!!mailMeta.configIsReadonly}>
					<div className="settings-row">
						<Select label="Send mode" value={mail.mail_smtpmode} onChange={(e) => m('mail_smtpmode', e.target.value)}>
							{(mailMeta.smtpModeOptions ?? [{ id: 'smtp', label: 'SMTP' }]).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
						</Select>
						{mail.mail_smtpmode === 'smtp' && (
							<Select label="Encryption" value={mail.mail_smtpsecure} onChange={(e) => m('mail_smtpsecure', e.target.value)}>
								{(mailMeta.smtpEncryptionOptions ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
							</Select>
						)}
						{mail.mail_smtpmode === 'sendmail' && (
							<Select label="Sendmail mode" value={mail.mail_sendmailmode} onChange={(e) => m('mail_sendmailmode', e.target.value)}>
								{(mailMeta.smtpSendmailModeOptions ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
							</Select>
						)}
					</div>
					<div className="settings-row">
						<TextField label="From address" value={mail.mail_from_address} onChange={(e) => m('mail_from_address', e.target.value)} placeholder="atrium" />
						<span className="settings-at">@</span>
						<TextField label="Domain" value={mail.mail_domain} onChange={(e) => m('mail_domain', e.target.value)} placeholder="example.com" />
					</div>
					{mail.mail_smtpmode === 'smtp' && (
						<>
							<div className="settings-row">
								<TextField label="Server" value={mail.mail_smtphost} onChange={(e) => m('mail_smtphost', e.target.value)} placeholder="smtp.example.com" />
								<TextField label="Port" className="settings-port" inputMode="numeric" value={mail.mail_smtpport} onChange={(e) => m('mail_smtpport', e.target.value)} placeholder="587" />
							</div>
							<Switch label="Log in to the server" checked={mail.mail_smtpauth} onChange={(e) => m('mail_smtpauth', e.target.checked)} />
							{mail.mail_smtpauth && (
								<div className="settings-row">
									<TextField label="Username" autoComplete="off" value={mail.mail_smtpname} onChange={(e) => m('mail_smtpname', e.target.value)} />
									<TextField label="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mail.mail_smtppassword ? 'Unchanged' : ''} />
								</div>
							)}
							<Switch label="Accept self-signed certificates" checked={mail.mail_noverify} onChange={(e) => m('mail_noverify', e.target.checked)} />
						</>
					)}
					<div className="settings-actions">
						<Button variant="tonal" busy={busy === 'test'} onClick={testMail}>Send test email</Button>
						<Button busy={busy === 'save'} onClick={saveMail}>Save</Button>
					</div>
				</fieldset>
			</Card>
		</>
	)
}

// ---------------------------------------------------------------- Sharing (admin)

type ShareSettings = Record<string, unknown>
const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase()
const asConfig = (v: unknown) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : typeof v === 'string' ? v : JSON.stringify(v))

export function AdminSharing({ session }: { session: Session }) {
	const st = useAsync(() => loadSection('admin', 'sharing'), [])
	return (
		<Section title="Sharing" intro="What people on this server may share, and with whom.">
			<Loading data={st.data} error={st.error}>{(d) => <SharingForm user={session.user.id} initial={(d.settings?.sharingSettings ?? {}) as ShareSettings} />}</Loading>
		</Section>
	)
}

function SharingForm({ user, initial }: { user: string, initial: ShareSettings }) {
	const [s, setS] = useState(initial)
	const [disclaimer, setDisclaimer] = useState(String(initial.publicShareDisclaimerText ?? ''))
	const set = async (key: string, value: unknown) => {
		const old = s[key]
		setS((x) => ({ ...x, [key]: value }))
		if (!await saving(setAppConfig(user, 'core', `shareapi_${snake(key)}`, asConfig(value)))) setS((x) => ({ ...x, [key]: old }))
	}
	const sw = (key: string, label: string, hint?: string) => (
		<div className="settings-switch">
			<Switch label={label} checked={!!s[key]} onChange={(e) => set(key, e.target.checked)} />
			{hint && <small className="at-muted">{hint}</small>}
		</div>
	)
	const days = (key: string, label: string) => (
		<TextField label={label} className="settings-port" inputMode="numeric" defaultValue={String(s[key] ?? '7')} onBlur={(e) => e.target.value !== String(s[key]) && set(key, e.target.value)} />
	)
	const saveDisclaimer = async () => {
		if (disclaimer === (s.publicShareDisclaimerText ?? '')) return
		const p = disclaimer
			? setAppConfig(user, 'core', 'shareapi_public_link_disclaimertext', disclaimer)
			: confirmPassword(user).then((auth) => ocs('apps/provisioning_api/api/v1/config/apps/core/shareapi_public_link_disclaimertext', { method: 'DELETE', headers: auth }))
		if (await saving(p)) setS((x) => ({ ...x, publicShareDisclaimerText: disclaimer }))
	}
	if (!s.enabled) return <Card className="settings-block">{sw('enabled', 'Allow sharing')}</Card>
	return (
		<>
			<Card className="settings-block">
				<h3>General</h3>
				{sw('enabled', 'Allow sharing')}
				{sw('allowResharing', 'Allow resharing')}
				{sw('allowGroupSharing', 'Allow sharing with groups')}
				{sw('onlyShareWithGroupMembers', 'Only share with members of your own groups')}
				{sw('allowShareDialogUserEnumeration', 'Suggest accounts in the share dialog', 'Off: people must type a full name, email or user id.')}
			</Card>
			<Card className="settings-block">
				<h3>Public links</h3>
				{sw('allowLinks', 'Allow public links')}
				{s.allowLinks ? (
					<>
						{sw('allowPublicUpload', 'Allow upload through public links')}
						{sw('enableLinkPasswordByDefault', 'Ask for a password by default')}
						{sw('enforceLinksPassword', 'Require a password')}
						{sw('defaultExpireDate', 'Set an expiration date by default')}
						{s.defaultExpireDate ? <div className="settings-indent">{days('expireAfterNDays', 'Days until links expire')}{sw('enforceExpireDate', 'Make the expiration date mandatory')}</div> : null}
						{sw('allowCustomTokens', 'Allow custom link tokens')}
						<TextArea label="Disclaimer on public pages" rows={3} value={disclaimer} onChange={(e) => setDisclaimer(e.target.value)} onBlur={saveDisclaimer} />
					</>
				) : null}
			</Card>
			<Card className="settings-block">
				<h3>Internal shares</h3>
				{sw('defaultInternalExpireDate', 'Set an expiration date by default')}
				{s.defaultInternalExpireDate ? <div className="settings-indent">{days('internalExpireAfterNDays', 'Days until shares expire')}{sw('enforceInternalExpireDate', 'Make the expiration date mandatory')}</div> : null}
				<div className="settings-switch">
					<Select label="Default permissions for new shares" value={String(s.defaultPermissions ?? 31)} onChange={(e) => set('defaultPermissions', Number(e.target.value))}>
						<option value="17">View only</option>
						<option value="19">View and edit</option>
						<option value="31">Everything (edit, create, delete, reshare)</option>
					</Select>
				</div>
			</Card>
		</>
	)
}

// ---------------------------------------------------------------- Theming (admin)

interface ThemingParams { name: string, url: string, slogan: string, primaryColor: string, backgroundColor: string, legalNoticeUrl: string, privacyPolicyUrl: string, disableUserTheming: boolean, logoMime: string, backgroundMime: string, faviconMime: string }

export function AdminTheming({ session: _ }: { session: Session }) {
	const st = useAsync(() => loadSection('admin', 'theming'), [])
	return (
		<Section title="Theming" intro="Name, colours and images for everyone on this server. People can still pick their own accent and wallpaper unless you turn that off.">
			<Loading data={st.data} error={st.error}>{(d) => <ThemingForm initial={d.theming?.adminThemingParameters as ThemingParams} reload={st.reload} />}</Loading>
		</Section>
	)
}

function ThemingForm({ initial, reload }: { initial: ThemingParams, reload: () => void }) {
	const [p, setP] = useState(initial)
	useEffect(() => setP(initial), [initial])
	const update = async (setting: string, value: string) => {
		try { await request('/apps/theming/ajax/updateStylesheet', { method: 'POST', body: { setting, value } }); toast('Saved') } catch (e) { toast.error(`Could not save: ${errText(e)}`) }
	}
	const undo = async (setting: string) => { try { await request('/apps/theming/ajax/undoChanges', { method: 'POST', body: { setting } }); reload() } catch (e) { toast.error(errText(e)) } }
	const upload = async (key: string, file: File | undefined) => {
		if (!file) return
		const form = new FormData()
		form.append('key', key)
		form.append('image', file)
		try { await request('/apps/theming/ajax/uploadImage', { method: 'POST', body: form }); toast('Uploaded'); reload() } catch (e) { toast.error(`Could not upload: ${errText(e)}`) }
	}
	const text = (k: keyof ThemingParams, label: string, setting = k as string) => (
		<TextField label={label} value={String(p[k] ?? '')} onChange={(e) => setP((x) => ({ ...x, [k]: e.target.value }))} onBlur={(e) => e.target.value !== String(initial[k] ?? '') && update(setting, e.target.value)} />
	)
	const image = (key: string, label: string, mime: string) => (
		<div className="settings-image">
			<span className="settings-image__preview" style={mime ? { backgroundImage: `url(/apps/theming/image/${key}?v=${Date.now() % 1e6})` } : undefined}>{!mime && <Icon name="image" />}</span>
			<span className="settings-image__label">{label}<small className="at-muted">{mime ? 'Custom' : 'Default'}</small></span>
			<label className="at-btn at-btn--tonal at-btn--s">Upload<input type="file" accept="image/*" hidden onChange={(e) => upload(key, e.target.files?.[0])} /></label>
			{mime && <Button variant="text" size="s" onClick={() => undo(key)}>Reset</Button>}
		</div>
	)
	return (
		<>
			<Card className="settings-block">
				<h3>Identity</h3>
				<div className="settings-form">
					{text('name', 'Name')}
					{text('slogan', 'Slogan')}
					{text('url', 'Web link')}
					<div className="settings-row">{text('legalNoticeUrl', 'Legal notice link', 'imprintUrl')}{text('privacyPolicyUrl', 'Privacy policy link', 'privacyUrl')}</div>
				</div>
			</Card>
			<Card className="settings-block">
				<h3>Colours</h3>
				<div className="settings-row settings-colors">
					<label className="settings-color"><input type="color" value={p.primaryColor} onChange={(e) => setP((x) => ({ ...x, primaryColor: e.target.value }))} onBlur={(e) => e.target.value !== initial.primaryColor && update('primary_color', e.target.value)} /><span>Primary colour<small className="at-muted">{p.primaryColor}</small></span></label>
					<label className="settings-color"><input type="color" value={p.backgroundColor} onChange={(e) => setP((x) => ({ ...x, backgroundColor: e.target.value }))} onBlur={(e) => e.target.value !== initial.backgroundColor && update('background_color', e.target.value)} /><span>Background colour<small className="at-muted">{p.backgroundColor}</small></span></label>
				</div>
				<div className="settings-switch">
					<Switch label="Let people choose their own accent and wallpaper" checked={!p.disableUserTheming} onChange={(e) => { setP((x) => ({ ...x, disableUserTheming: !e.target.checked })); update('disable-user-theming', e.target.checked ? 'no' : 'yes') }} />
				</div>
			</Card>
			<Card className="settings-block">
				<h3>Images</h3>
				{image('logo', 'Logo', p.logoMime)}
				{image('background', 'Login and default wallpaper', p.backgroundMime)}
				{image('favicon', 'Favicon', p.faviconMime)}
			</Card>
		</>
	)
}

// ---------------------------------------------------------------- Sharing (personal)

export function PersonalSharing({ session: _ }: { session: Session }) {
	const st = useAsync(() => loadSection('personal', 'sharing'), [])
	return (
		<Section title="Sharing">
			<Loading data={st.data} error={st.error}>{(d) => {
				const fs = (d.files_sharing ?? {}) as { accept_default: boolean, enforce_accept: boolean, allow_custom_share_folder: boolean, default_share_folder: string, share_folder: string }
				const fed = (d.federatedfilesharing ?? {}) as { cloudId?: string }
				return <PersonalSharingForm fs={fs} cloudId={fed.cloudId} />
			}}</Loading>
		</Section>
	)
}

function PersonalSharingForm({ fs, cloudId }: { fs: { accept_default: boolean, enforce_accept: boolean, allow_custom_share_folder: boolean, default_share_folder: string, share_folder: string }, cloudId?: string }) {
	const [accept, setAccept] = useState(fs.accept_default)
	const [folder, setFolder] = useState(fs.share_folder)
	const saveAccept = async (v: boolean) => {
		setAccept(v)
		if (!await saving(request('/apps/files_sharing/settings/defaultAccept', { method: 'PUT', body: { accept: v } }))) setAccept(!v)
	}
	const saveFolder = async (v: string) => {
		const clean = '/' + v.replace(/^\/+|\/+$/g, '')
		setFolder(clean)
		if (clean === fs.share_folder) return
		await saving(clean === fs.default_share_folder
			? request('/apps/files_sharing/settings/shareFolder', { method: 'DELETE' })
			: request('/apps/files_sharing/settings/shareFolder', { method: 'PUT', body: { shareFolder: clean } }))
	}
	return (
		<>
			<Card className="settings-block">
				<h3>Shares you receive</h3>
				{!fs.enforce_accept && <div className="settings-switch"><Switch label="Accept shares from others automatically" checked={accept} onChange={(e) => saveAccept(e.target.checked)} /></div>}
				{fs.allow_custom_share_folder && (
					<div className="settings-switch">
						<TextField label="Folder for new shares" value={folder} onChange={(e) => setFolder(e.target.value)} onBlur={(e) => saveFolder(e.target.value)} hint={`Default: ${fs.default_share_folder}`} />
					</div>
				)}
			</Card>
			{cloudId && (
				<Card className="settings-block">
					<h3>Federated Cloud ID</h3>
					<p className="at-muted settings-note">People on other servers can share with you using this address.</p>
					<div className="settings-row">
						<TextField label="Your Cloud ID" readOnly value={cloudId} onFocus={(e) => e.target.select()} />
						<Button variant="tonal" icon="contentCopy" onClick={() => navigator.clipboard.writeText(cloudId).then(() => toast('Copied'), () => {})}>Copy</Button>
					</div>
				</Card>
			)}
		</>
	)
}
