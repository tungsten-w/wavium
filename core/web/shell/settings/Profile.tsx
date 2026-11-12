// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Profile: provisioning API (cloud/users/<id>) + avatar endpoints.
import { useRef, useState } from 'react'
import { avatarUrl, confirmPassword, formatBytes, HttpError, ocs, request, useAsync, type Session } from '@atrium/sdk'
import { Avatar, Button, Card, Progress, Spinner, TextArea, TextField, toast } from '@atrium/ui'

interface UserData {
	id: string
	displayname: string
	email: string | null
	phone: string
	address: string
	website: string
	twitter: string
	fediverse?: string
	organisation?: string
	role?: string
	headline?: string
	biography?: string
	quota: { used: number, total: number, relative: number, quota: number }
	language: string
	locale: string
}

const FIELDS: { key: keyof UserData, api: string, label: string, type?: string, long?: boolean }[] = [
	{ key: 'displayname', api: 'displayname', label: 'Full name' },
	{ key: 'email', api: 'email', label: 'Email', type: 'email' },
	{ key: 'phone', api: 'phone', label: 'Phone number', type: 'tel' },
	{ key: 'address', api: 'address', label: 'Location' },
	{ key: 'website', api: 'website', label: 'Website', type: 'url' },
	{ key: 'organisation', api: 'organisation', label: 'Organisation' },
	{ key: 'role', api: 'role', label: 'Role' },
	{ key: 'headline', api: 'headline', label: 'Headline' },
	{ key: 'biography', api: 'biography', label: 'About', long: true },
]

export function Profile({ session }: { session: Session }) {
	const uid = session.user.id
	const { data, error, loading, setData } = useAsync(() => ocs<UserData>(`cloud/users/${encodeURIComponent(uid)}`), [uid])
	const [draft, setDraft] = useState<Record<string, string>>({})
	const [saving, setSaving] = useState(false)
	const [avatarV, setAvatarV] = useState(Date.now())
	const file = useRef<HTMLInputElement>(null)

	if (loading && !data) return <Spinner />
	if (error || !data) return <p>Could not load your profile: {error?.message}</p>

	const changed = Object.entries(draft).filter(([k, v]) => String(data[k as keyof UserData] ?? '') !== v)

	async function save() {
		setSaving(true)
		try {
			const auth = await confirmPassword(uid, 'Confirm your password to change your profile.')
			for (const [key, value] of changed) {
				const f = FIELDS.find((x) => x.key === key)!
				await ocs(`cloud/users/${encodeURIComponent(uid)}`, { method: 'PUT', body: { key: f.api, value }, headers: auth })
			}
			setData({ ...data!, ...draft })
			setDraft({})
			toast('Profile saved')
		} catch (e) {
			if (!(e instanceof HttpError && e.status === 0)) toast.error(e instanceof Error ? e.message : String(e))
		}
		setSaving(false)
	}

	async function upload(f: File) {
		try {
			const square = await squareImage(f, 512)
			const fd = new FormData()
			fd.append('files[]', square, 'avatar.png')
			await request('/avatar/', { body: fd })
			setAvatarV(Date.now())
			toast('Picture updated')
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e))
		}
	}
	async function removeAvatar() {
		try {
			await request('/avatar/', { method: 'DELETE' })
			setAvatarV(Date.now())
		} catch (e) {
			toast.error(String(e))
		}
	}

	const q = data.quota
	return (
		<section className="settings-section">
			<h2 className="at-headline">Profile</h2>
			<p className="at-muted">How you appear to others on this server.</p>

			<Card className="settings-block profile-head">
				<Avatar name={data.displayname} src={`${avatarUrl(uid, 256)}?v=${avatarV}`} size={96} />
				<div style={{ flex: 1, minWidth: 0 }}>
					<div className="at-title">{data.displayname}</div>
					<div className="at-muted">{uid}</div>
					<div className="settings-row" style={{ marginTop: 12 }}>
						<Button variant="tonal" icon="upload" onClick={() => file.current?.click()}>Upload picture</Button>
						<Button variant="text" onClick={removeAvatar}>Remove</Button>
						<input ref={file} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = '' }} />
					</div>
				</div>
			</Card>

			{q && q.total > 0 && (
				<Card className="settings-block">
					<h3>Storage</h3>
					<Progress value={q.relative / 100} />
					<p className="at-muted" style={{ margin: '8px 0 0' }}>
						{formatBytes(q.used)} used{q.quota > 0 ? ` of ${formatBytes(q.quota)}` : ` (${formatBytes(q.total)} available)`}
					</p>
				</Card>
			)}

			<Card className="settings-block">
				<h3>Details</h3>
				<div className="profile-fields">
					{FIELDS.map((f) => {
						const value = draft[f.key] ?? String(data[f.key] ?? '')
						const set = (v: string) => setDraft((d) => ({ ...d, [f.key]: v }))
						return f.long
							? <TextArea key={f.key} label={f.label} value={value} onChange={(e) => set(e.target.value)} rows={3} className="profile-wide" />
							: <TextField key={f.key} label={f.label} type={f.type} value={value} onChange={(e) => set(e.target.value)} />
					})}
				</div>
				<div className="settings-row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
					{changed.length > 0 && <Button variant="text" onClick={() => setDraft({})}>Discard</Button>}
					<Button icon="check" busy={saving} disabled={changed.length === 0} onClick={save}>Save</Button>
				</div>
			</Card>
		</section>
	)
}

/** Center-crop to a square PNG so the server takes it without a crop step. */
async function squareImage(f: File, size: number): Promise<Blob> {
	const img = await createImageBitmap(f)
	const s = Math.min(img.width, img.height)
	const c = document.createElement('canvas')
	c.width = c.height = Math.min(size, s)
	c.getContext('2d')!.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, c.width, c.height)
	return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the image'))), 'image/png'))
}
