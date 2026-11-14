// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// More Settings sections in React: notifications (personal) and Activity (admin)
// settings, Groupware, Quick presets and admin Security (two-factor enforcement).
// Data comes from core/atrium/settings/<kind>/<section>; saving uses the classic
// endpoints of the owning apps.
import { useState } from 'react'
import { confirmPassword, request, useAsync, type Session } from '@atrium/sdk'
import { Button, Card, Checkbox, Chip, Select, Switch, TextField } from '@atrium/ui'
import { Loading, Section, loadSection, saving, setAppConfig } from './Admin'

// ---------------------------------------------------------------- Notifications / Activity

interface Entry { desc: string, email: boolean, notification: boolean, methods: string[] }
interface Group { name: string, activities: Record<string, Entry> }
interface NotifState {
	activity_groups: Record<string, Group> | []
	email_enabled: boolean
	is_email_set: boolean
	setting_batchtime: number
	methods: Record<string, string> | []
	notify_setting_self: boolean
	notify_setting_selfemail: boolean
	activity_digest_enabled?: boolean
}
/** Event names carry <strong> markup; render only that tag. */
const bold = (s: string) => s.split(/(<strong>.*?<\/strong>)/g).map((p, i) => (p.startsWith('<strong>') ? <strong key={i}>{p.slice(8, -9)}</strong> : p.replace(/<[^>]+>/g, '')))
const BATCH = [{ v: 3, t: 'As soon as possible' }, { v: 0, t: 'Hourly' }, { v: 1, t: 'Daily' }, { v: 2, t: 'Weekly' }]

/** Which events are shown in the Activity stream and which send a push or an email. Personal: your own; admin: the server defaults. */
export function Notifications({ admin }: { session: Session, admin?: boolean }) {
	const st = useAsync(() => loadSection(admin ? 'admin' : 'personal', admin ? 'activity' : 'notifications'), [admin])
	return (
		<Section title={admin ? 'Activity' : 'Notifications'} intro={admin ? 'Default notification settings for new accounts. Everyone can change their own.' : 'Choose which events notify you, by push or by email.'}>
			<Loading data={st.data} error={st.error}>{(d) => <NotifForm admin={!!admin} s={d.activity as unknown as NotifState} />}</Loading>
		</Section>
	)
}

function NotifForm({ admin, s }: { admin: boolean, s: NotifState }) {
	const groups = Array.isArray(s.activity_groups) ? {} : s.activity_groups
	const methods = Array.isArray(s.methods) ? {} : s.methods
	const [rows, setRows] = useState(groups)
	const [batch, setBatch] = useState(s.setting_batchtime)
	const [self, setSelf] = useState(!!s.notify_setting_self)
	const [selfMail, setSelfMail] = useState(!!s.notify_setting_selfemail)
	const [digest, setDigest] = useState(!!s.activity_digest_enabled)

	const save = (r: Record<string, Group>, o: { batch: number, self: boolean, selfMail: boolean, digest: boolean }) => {
		const body: Record<string, unknown> = { notify_setting_batchtime: o.batch, notify_setting_self: o.self, notify_setting_selfemail: o.selfMail, activity_digest: o.digest }
		for (const g of Object.values(r)) for (const [id, e] of Object.entries(g.activities)) { body[`${id}_notification`] = e.notification; body[`${id}_email`] = e.email }
		return saving(request(admin ? '/apps/activity/settings/admin' : '/apps/activity/settings', { method: 'POST', body }))
	}
	const opts = { batch, self, selfMail, digest }
	const toggle = (gid: string, id: string, m: 'email' | 'notification', v: boolean) => {
		const next = { ...rows, [gid]: { ...rows[gid], activities: { ...rows[gid].activities, [id]: { ...rows[gid].activities[id], [m]: v } } } }
		setRows(next)
		void save(next, opts)
	}
	const mailOn = s.email_enabled
	return (
		<>
			{mailOn && !admin && !s.is_email_set && <Card className="settings-block"><p className="at-muted">Set an email address in your Profile to get notifications by email.</p></Card>}
			{Object.entries(rows).map(([gid, g]) => (
				<Card key={gid} className="settings-block">
					<h3>{g.name}</h3>
					<table className="settings-table notif-table">
						<thead><tr><th>Event</th>{Object.entries(methods).map(([m, label]) => <th key={m} className="notif-col">{label}</th>)}</tr></thead>
						<tbody>
							{Object.entries(g.activities).map(([id, e]) => (
								<tr key={id}>
									<td>{bold(e.desc)}</td>
									{Object.keys(methods).map((m) => (
										<td key={m} className="notif-col">
											{e.methods.includes(m) && <Checkbox aria-label={`${e.desc.replace(/<[^>]+>/g, '')}: ${methods[m as keyof typeof methods]}`} checked={!!e[m as 'email' | 'notification']} onChange={(ev) => toggle(gid, id, m as 'email' | 'notification', ev.target.checked)} />}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</Card>
			))}
			<Card className="settings-block">
				<h3>Options</h3>
				<div className="settings-switch"><Switch label="Show my own actions in the Activity stream" checked={self} onChange={(e) => { setSelf(e.target.checked); void save(rows, { ...opts, self: e.target.checked }) }} /></div>
				{mailOn && <div className="settings-switch"><Switch label="Send emails for my own actions" checked={selfMail} onChange={(e) => { setSelfMail(e.target.checked); void save(rows, { ...opts, selfMail: e.target.checked }) }} /></div>}
				{mailOn && (
					<Select label="Send emails" value={String(batch)} onChange={(e) => { const v = Number(e.target.value); setBatch(v); void save(rows, { ...opts, batch: v }) }}>
						{BATCH.map((b) => <option key={b.v} value={b.v}>{b.t}</option>)}
					</Select>
				)}
				{mailOn && !admin && <div className="settings-switch"><Switch label="Daily summary of activity" checked={digest} onChange={(e) => { setDigest(e.target.checked); void save(rows, { ...opts, digest: e.target.checked }) }} /></div>}
			</Card>
		</>
	)
}

// ---------------------------------------------------------------- Groupware

const GROUPWARE: { key: string, label: string, hint?: string }[] = [
	{ key: 'sendInvitations', label: 'Send invitations to attendees by email', hint: 'For events with attendees outside this server.' },
	{ key: 'generateBirthdayCalendar', label: 'Generate a birthday calendar for everyone', hint: 'From the birthdays in contacts.' },
	{ key: 'sendEventReminders', label: 'Send notifications for event reminders' },
	{ key: 'sendEventRemindersToSharedUsers', label: 'Also remind people a calendar is shared with' },
	{ key: 'sendEventRemindersPush', label: 'Send event reminders as push notifications' },
]

export function Groupware({ session }: { session: Session }) {
	const st = useAsync(() => loadSection('admin', 'groupware'), [])
	return (
		<Section title="Groupware" intro="Calendar behaviour for everyone on this server.">
			<Loading data={st.data} error={st.error}>{(d) => <GroupwareForm user={session.user.id} initial={(d.dav ?? {}) as Record<string, boolean>} />}</Loading>
		</Section>
	)
}
function GroupwareForm({ user, initial }: { user: string, initial: Record<string, boolean> }) {
	const [s, setS] = useState(initial)
	const set = async (key: string, v: boolean) => {
		setS((x) => ({ ...x, [key]: v }))
		if (!await saving(setAppConfig(user, 'dav', key, v ? 'yes' : 'no'))) setS((x) => ({ ...x, [key]: !v }))
	}
	return (
		<Card className="settings-block">
			{GROUPWARE.map((g) => (
				<div key={g.key} className="settings-switch">
					<Switch label={g.label} checked={!!s[g.key]} onChange={(e) => set(g.key, e.target.checked)} />
					{g.hint && <small className="at-muted">{g.hint}</small>}
				</div>
			))}
		</Card>
	)
}

// ---------------------------------------------------------------- Quick presets

interface PresetEntry { key: string, definition: string, type: string }
interface PresetConfig { config: string, entry: PresetEntry, defaults: Record<string, string>, value?: unknown }
const PRESETS: [string, string, string][] = [
	['NONE', 'Default', 'The stock Nextcloud settings.'], ['PRIVATE', 'Personal use', 'Just you, or you and a few others.'], ['FAMILY', 'Family', 'A household.'],
	['CLUB', 'Club or association', 'A few dozen members.'], ['SMALL', 'Small organization', 'Up to a few hundred accounts.'], ['MEDIUM', 'Big organization', 'Thousands of accounts.'],
	['LARGE', 'Large organization', 'Tens of thousands of accounts.'], ['SCHOOL', 'School', 'Teachers and students.'], ['UNIVERSITY', 'University', 'Staff and students.'], ['SHARED', 'Hosting company', 'Many independent customers.'],
]
const show = (v: unknown) => (v === undefined || v === null || v === '' ? 'not set' : typeof v === 'string' ? v : JSON.stringify(v))

/** Preset that fills in the server's defaults for a kind of installation. */
export function Presets({ session: _ }: { session: Session }) {
	const st = useAsync(() => loadSection('admin', 'presets'), [])
	return (
		<Section title="Quick presets" intro="Pick the kind of installation this is and Nextcloud will use matching defaults for settings you have not changed yourself.">
			<Loading data={st.data} error={st.error}>{(d) => <PresetForm current={String(d.settings?.['settings-selected-preset'] ?? 'NONE')} configs={(d.settings?.['settings-presets'] ?? {}) as Record<string, PresetConfig[]>} />}</Loading>
		</Section>
	)
}
function PresetForm({ current, configs }: { current: string, configs: Record<string, PresetConfig[]> }) {
	const [saved, setSaved] = useState(current)
	const [sel, setSel] = useState(current)
	const [busy, setBusy] = useState(false)
	const diffs = Object.entries(configs).flatMap(([app, list]) => list.map((c) => ({ app, c })))
		.filter(({ c }) => c.defaults?.[sel] !== undefined && c.defaults[sel] !== c.defaults.NONE)
	const save = async () => {
		setBusy(true)
		if (await saving(request('/settings/preset/current', { method: 'POST', body: { presetName: sel } }))) setSaved(sel)
		setBusy(false)
	}
	return (
		<>
			<Card className="settings-block">
				<div className="settings-radios">
					{PRESETS.map(([id, name, hint]) => (
						<label key={id} className={'settings-radio' + (sel === id ? ' settings-radio--on' : '')}>
							<input type="radio" name="preset" checked={sel === id} onChange={() => setSel(id)} />
							<span><strong>{name}</strong><small>{hint}{id === saved ? ' (in use)' : ''}</small></span>
						</label>
					))}
				</div>
				<div className="settings-actions"><Button busy={busy} disabled={sel === saved} onClick={save}>Apply preset</Button></div>
			</Card>
			{diffs.length > 0 && (
				<Card className="settings-block">
					<h3>What this preset changes</h3>
					<table className="settings-table">
						<thead><tr><th>Setting</th><th>Default</th><th>This preset</th></tr></thead>
						<tbody>{diffs.map(({ app, c }) => <tr key={app + c.entry.key}><td><strong>{c.entry.key}</strong><br /><small className="at-muted">{app}{c.entry.definition ? ` · ${c.entry.definition}` : ''}</small></td><td>{show(c.defaults.NONE)}</td><td>{show(c.defaults[sel])}</td></tr>)}</tbody>
					</table>
				</Card>
			)}
		</>
	)
}

// ---------------------------------------------------------------- Admin security

interface TwoFactorState { enforced: boolean, enforcedGroups: string[], excludedGroups: string[] }
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

/** Two-factor enforcement for the whole server. */
export function AdminSecurity({ session }: { session: Session }) {
	const st = useAsync(() => loadSection('admin', 'security'), [])
	return (
		<Section title="Security" intro="Sign-in requirements for everyone on this server.">
			<Loading data={st.data} error={st.error}>{(d) => <SecurityForm user={session.user.id} s={(d.settings?.mandatory2FAState ?? { enforced: false, enforcedGroups: [], excludedGroups: [] }) as TwoFactorState} enc={d.settings?.['encryption-enabled'] === true} />}</Loading>
		</Section>
	)
}
function SecurityForm({ user, s, enc }: { user: string, s: TwoFactorState, enc: boolean }) {
	const [on, setOn] = useState(s.enforced)
	const [inc, setInc] = useState((s.enforcedGroups ?? []).join(', '))
	const [exc, setExc] = useState((s.excludedGroups ?? []).join(', '))
	const [busy, setBusy] = useState(false)
	const save = async (enforced = on) => {
		setBusy(true)
		const ok = await saving(confirmPassword(user, 'Confirm your password to change the sign-in policy.').then((auth) => request('/settings/api/admin/twofactorauth', { method: 'PUT', body: { enforced, enforcedGroups: list(inc), excludedGroups: list(exc) }, headers: auth })), 'Two-factor policy saved')
		setBusy(false)
		return ok
	}
	return (
		<>
			<Card className="settings-block">
				<h3>Two-factor authentication</h3>
				<div className="settings-switch">
					<Switch label="Require two-factor authentication" checked={on} onChange={(e) => { const v = e.target.checked; setOn(v); void save(v).then((ok) => { if (!ok) setOn(!v) }) }} />
					<small className="at-muted">Accounts without a second factor are asked to set one up at the next sign-in.</small>
				</div>
				{on && (
					<div className="settings-form">
						<TextField label="Only for these groups (comma separated, empty = everyone)" value={inc} onChange={(e) => setInc(e.target.value)} />
						<TextField label="Except these groups (comma separated)" value={exc} onChange={(e) => setExc(e.target.value)} />
						<div className="settings-actions"><Button busy={busy} onClick={() => save()}>Save groups</Button></div>
					</div>
				)}
			</Card>
			<Card className="settings-block">
				<h3>Server-side encryption</h3>
				<p className="at-muted">{enc ? 'Server-side encryption is on.' : 'Server-side encryption is off.'} Turning it on or off changes how every file is stored, so Wavium leaves that to the command line (occ encryption).</p>
			</Card>
		</>
	)
}

// ---------------------------------------------------------------- Administration privileges (delegation)

interface Delegable { class: string, sectionName: string, id: string }
interface Authorized { id: number, group_id: string, class: string }
interface GroupInfo { gid: string, displayName: string }

/** Which groups (besides admin) may open which admin settings. */
export function Delegation({ session }: { session: Session }) {
	const st = useAsync(() => loadSection('admin', 'admindelegation'), [])
	return (
		<Section title="Administration privileges" intro="Let members of a group manage selected admin settings without being full administrators.">
			<Loading data={st.data} error={st.error}>{(d) => {
				const s = d.settings ?? {}
				return <DelegationForm user={session.user.id} settings={(s['available-settings'] ?? []) as Delegable[]} groups={(s['available-groups'] ?? []) as GroupInfo[]} initial={(s['authorized-groups'] ?? []) as Authorized[]} />
			}}</Loading>
		</Section>
	)
}
function DelegationForm({ user, settings, groups, initial }: { user: string, settings: Delegable[], groups: GroupInfo[], initial: Authorized[] }) {
	const [granted, setGranted] = useState<Record<string, string[]>>(() => {
		const m: Record<string, string[]> = {}
		for (const a of initial) (m[a.class] ??= []).push(a.group_id)
		return m
	})
	const toggle = async (cls: string, gid: string) => {
		const old = granted[cls] ?? []
		const next = old.includes(gid) ? old.filter((g) => g !== gid) : [...old, gid]
		setGranted((g) => ({ ...g, [cls]: next }))
		const p = confirmPassword(user, 'Confirm your password to change who can administer this server.')
			.then((auth) => request('/apps/settings/settings/authorizedgroups/saveSettings', { method: 'POST', body: { newGroups: next.map((g) => ({ gid: g })), class: cls }, headers: auth }))
		if (!await saving(p)) setGranted((g) => ({ ...g, [cls]: old }))
	}
	if (groups.length === 0) return <Card className="settings-block"><p className="at-muted">There are no groups yet. Create a group in Accounts first.</p></Card>
	return (
		<>
			{settings.map((s) => (
				<Card key={s.class + s.id} className="settings-block">
					<h3>{s.sectionName}</h3>
					<div className="settings-chips">
						{groups.map((g) => <Chip key={g.gid} selected={(granted[s.class] ?? []).includes(g.gid)} onClick={() => toggle(s.class, g.gid)}>{g.displayName}</Chip>)}
					</div>
				</Card>
			))}
		</>
	)
}
