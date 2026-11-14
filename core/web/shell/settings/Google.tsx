// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// v2.1, connectivity:
//   Settings > Move from Google: Gmail, Google Calendar, Contacts and Drive into
//     Wavium, one card each, with the exports Google offers (no API key needed).
//   Settings > Administration > Google sign-in: the OAuth client that lets Gmail
//     users sign in with Google instead of an app password.
import { useEffect, useRef, useState } from 'react'
import { appUrl, HttpError, linkHandler, request, type Session } from '@atrium/sdk'
import { Button, Card, Icon, Select, TextField, toast } from '@atrium/ui'
import { Section } from './Admin'
import { importIcs, importVcf, subscribe, type ImportResult, type Target, writableBooks, writableCalendars } from './importers'

export interface GoogleInfo { configured: boolean, clientId: string | null, redirectUrl: string, scope: string }

async function mailApi<T>(path: string, opts: { method?: string, body?: unknown } = {}): Promise<T> {
	try {
		const r = await request<T | { status: string, data: T }>(appUrl('mail', `/api${path}`), opts)
		return (r && typeof r === 'object' && 'data' in r && 'status' in r ? r.data : r) as T
	} catch (e) {
		if (e instanceof HttpError) {
			const b = e.body as { data?: { message?: string }, message?: string } | null
			throw new Error(b?.data?.message ?? b?.message ?? `HTTP ${e.status}`)
		}
		throw e
	}
}
export const googleApi = {
	info: () => mailApi<GoogleInfo>('/integration/google'),
	configure: (clientId: string, clientSecret: string) => mailApi('/integration/google', { method: 'POST', body: { clientId, clientSecret } }),
	unlink: () => mailApi('/integration/google', { method: 'DELETE' }),
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const summary = (r: ImportResult, what: string) =>
	`${r.added} ${what} added${r.skipped ? `, ${r.skipped} already there` : ''}${r.failed ? `, ${r.failed} could not be read` : ''}.`

function Step({ n, children }: { n: number, children: React.ReactNode }) {
	return <li className="gmove__step"><span className="gmove__n">{n}</span><div>{children}</div></li>
}
const ext = (href: string, label: string) => <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>

/** Where imports can go. A prop so DOM tests can skip CalDAV listings (happy-dom cannot parse them). */
export type TargetLoader = (user: string) => Promise<{ cals: Target[], books: Target[] }>
const loadTargets: TargetLoader = async (user) => {
	const [cals, books] = await Promise.all([writableCalendars(user).catch(() => []), writableBooks(user).catch(() => [])])
	return { cals, books }
}

export function MoveFromGoogle({ session, targets = loadTargets }: { session: Session, targets?: TargetLoader }) {
	const user = session.user.id
	const [info, setInfo] = useState<GoogleInfo | null>(null)
	const [cals, setCals] = useState<Target[]>([])
	const [books, setBooks] = useState<Target[]>([])
	const [cal, setCal] = useState('')
	const [book, setBook] = useState('')
	const [secret, setSecret] = useState('')
	const [busy, setBusy] = useState<string | null>(null)
	const [result, setResult] = useState<Record<string, string>>({})
	const icsInput = useRef<HTMLInputElement>(null)
	const vcfInput = useRef<HTMLInputElement>(null)

	useEffect(() => {
		googleApi.info().then(setInfo, () => setInfo(null))
		targets(user).then(({ cals: c, books: b }) => {
			setCals(c); setCal((x) => x || c[0]?.url || '')
			setBooks(b); setBook((x) => x || b[0]?.url || '')
		}, () => {})
	}, [user, targets])

	async function run(key: string, f: () => Promise<string>) {
		setBusy(key)
		try { setResult((r) => ({ ...r, [key]: '' })); const msg = await f(); setResult((r) => ({ ...r, [key]: msg })); toast(msg) } catch (e) { toast.error(errText(e)) } finally { setBusy(null) }
	}
	const readFiles = async (files: FileList | null) => (files ? Promise.all(Array.from(files).map((f) => f.text())) : [])

	return (
		<Section title="Move from Google" intro="Bring your Gmail, Google Calendar, Contacts and Drive into Wavium. About 15 minutes; nothing is deleted at Google, so you can take your time.">
			<Card className="settings-block gmove" aria-label="Gmail">
				<h3><Icon name="mail" /> Gmail</h3>
				<ol className="gmove__steps">
					{info?.configured
						? <Step n={1}>Your server is set up for <strong>Sign in with Google</strong>: no app password needed.</Step>
						: <>
							<Step n={1}>Turn on {ext('https://myaccount.google.com/signinoptions/twosv', '2-Step Verification')} in your Google account (Google requires it for the next step).</Step>
							<Step n={2}>Create an {ext('https://myaccount.google.com/apppasswords', 'app password')} named "Wavium" and copy the 16 letters.</Step>
						</>}
					<Step n={info?.configured ? 2 : 3}>In Mail, add your Gmail address: Wavium fills in Google's servers{info?.configured ? ' and opens Google\'s sign-in.' : ' and asks for the app password.'}</Step>
				</ol>
				<a className="at-btn" href="/apps/mail/setup" onClick={linkHandler}><Icon name="add" />Add my Gmail</a>
				<p className="at-muted gmove__note">Wavium keeps its own copy of every mail, so it stays readable even if you later close the Gmail account.</p>
			</Card>

			<Card className="settings-block gmove" aria-label="Google Calendar">
				<h3><Icon name="calendar" /> Google Calendar</h3>
				<p><strong>Keep following it</strong> (read-only, refreshed by Wavium): in {ext('https://calendar.google.com/calendar/r/settings', 'Google Calendar settings')}, open your calendar, copy its <em>Secret address in iCal format</em>, and paste it here.</p>
				<div className="gmove__row">
					<TextField label="Secret address in iCal format" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" />
					<Button busy={busy === 'sub'} disabled={!secret.trim()} onClick={() => void run('sub', async () => { await subscribe(user, secret, 'Google Calendar'); setSecret(''); return 'Subscribed: "Google Calendar" is in your calendar list.' })}>Subscribe</Button>
				</div>
				<p><strong>Or move it for good</strong>: {ext('https://calendar.google.com/calendar/r/settings/export', 'Export')} from Google Calendar (a .zip), unzip it, and import the .ics files here.</p>
				<div className="gmove__row">
					<Select label="Into" value={cal} onChange={(e) => setCal(e.target.value)}>{cals.map((c) => <option key={c.url} value={c.url}>{c.name}</option>)}</Select>
					<Button variant="tonal" icon="upload" busy={busy === 'ics'} disabled={!cal} onClick={() => icsInput.current?.click()}>Import .ics files</Button>
					<input ref={icsInput} type="file" accept=".ics,text/calendar" multiple hidden aria-label="ics files" onChange={(e) => { const files = e.target.files; void run('ics', async () => {
						let total: ImportResult = { added: 0, skipped: 0, failed: 0 }
						for (const text of await readFiles(files)) { const r = await importIcs(cal, text); total = { added: total.added + r.added, skipped: total.skipped + r.skipped, failed: total.failed + r.failed } }
						return summary(total, 'events')
					}); e.target.value = '' }} />
				</div>
				{result.sub && <p className="gmove__done"><Icon name="check" /> {result.sub}</p>}
				{result.ics && <p className="gmove__done"><Icon name="check" /> {result.ics}</p>}
			</Card>

			<Card className="settings-block gmove" aria-label="Google Contacts">
				<h3><Icon name="contacts" /> Google Contacts</h3>
				<p>In {ext('https://contacts.google.com', 'Google Contacts')}, choose <em>Export</em> &gt; <em>vCard (for iOS Contacts)</em>, then import the file here.</p>
				<div className="gmove__row">
					<Select label="Into" value={book} onChange={(e) => setBook(e.target.value)}>{books.map((b) => <option key={b.url} value={b.url}>{b.name}</option>)}</Select>
					<Button variant="tonal" icon="upload" busy={busy === 'vcf'} disabled={!book} onClick={() => vcfInput.current?.click()}>Import .vcf</Button>
					<input ref={vcfInput} type="file" accept=".vcf,text/vcard,text/x-vcard" hidden aria-label="vcf file" onChange={(e) => { const files = e.target.files; void run('vcf', async () => {
						let total: ImportResult = { added: 0, skipped: 0, failed: 0 }
						for (const text of await readFiles(files)) { const r = await importVcf(book, text); total = { added: total.added + r.added, skipped: total.skipped + r.skipped, failed: total.failed + r.failed } }
						return summary(total, 'contacts')
					}); e.target.value = '' }} />
				</div>
				{result.vcf && <p className="gmove__done"><Icon name="check" /> {result.vcf}</p>}
			</Card>

			<Card className="settings-block gmove" aria-label="Google Drive and Photos">
				<h3><Icon name="folder" /> Drive and Photos</h3>
				<ol className="gmove__steps">
					<Step n={1}>Ask Google for your files with {ext('https://takeout.google.com', 'Google Takeout')} (choose Drive and/or Google Photos). Google sends a download link by mail, sometimes after a few hours.</Step>
					<Step n={2}>Unzip the download, then drop the folders into Files. For many gigabytes, the desktop app is faster (Settings &gt; Mobile &amp; desktop).</Step>
				</ol>
				<a className="at-btn at-btn--tonal" href="/apps/files/" onClick={linkHandler}><Icon name="folder" />Open Files</a>
			</Card>
		</Section>
	)
}

export function AdminGoogle(_: { session: Session }) {
	const [info, setInfo] = useState<GoogleInfo | null>(null)
	const [clientId, setClientId] = useState('')
	const [secret, setSecret] = useState('')
	const [busy, setBusy] = useState(false)
	const load = () => googleApi.info().then((i) => { setInfo(i); setClientId(i.clientId ?? '') }, (e) => toast.error(errText(e)))
	useEffect(() => { void load() }, [])

	async function save() {
		setBusy(true)
		try { await googleApi.configure(clientId.trim(), secret.trim()); setSecret(''); toast('Google sign-in is on'); await load() } catch (e) { toast.error(errText(e)) } finally { setBusy(false) }
	}
	async function turnOff() {
		setBusy(true)
		try { await googleApi.unlink(); toast('Google sign-in is off'); await load() } catch (e) { toast.error(errText(e)) } finally { setBusy(false) }
	}

	return (
		<Section title="Google sign-in" intro="Optional: lets Gmail users connect with Google's sign-in page instead of an app password. You need a free Google Cloud project; it takes about 10 minutes.">
			<Card className="settings-block gmove">
				<p className="gmove__status">{info?.configured ? <><Icon name="check" /> On: Gmail users see "Sign in with Google".</> : 'Off: Gmail users connect with an app password (the Move from Google page explains how).'}</p>
				<ol className="gmove__steps">
					<Step n={1}>In {ext('https://console.cloud.google.com/projectcreate', 'Google Cloud')}, create a project (any name, e.g. "Wavium").</Step>
					<Step n={2}>{ext('https://console.cloud.google.com/apis/credentials/consent', 'OAuth consent screen')}: user type <em>External</em>, app name "Wavium", your email; add the scope <code>https://mail.google.com/</code>; while the app is in <em>Testing</em>, add each Gmail address that will use it as a test user.</Step>
					<Step n={3}>{ext('https://console.cloud.google.com/apis/credentials', 'Credentials')} &gt; <em>Create credentials</em> &gt; <em>OAuth client ID</em> &gt; <em>Web application</em>, with this authorized redirect URI:
						<div className="gmove__row"><code className="gmove__uri">{info?.redirectUrl ?? '…'}</code><Button variant="text" size="s" icon="copy" disabled={!info} onClick={() => { void navigator.clipboard?.writeText(info!.redirectUrl); toast('Copied') }}>Copy</Button></div>
					</Step>
					<Step n={4}>Paste the client ID and secret below.</Step>
				</ol>
				<TextField label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" />
				<TextField label="Client secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={info?.configured ? 'Saved (type to replace)' : ''} />
				<div className="gmove__row">
					<Button busy={busy} disabled={!clientId.trim() || !secret.trim()} onClick={() => void save()}>Save</Button>
					{info?.configured && <Button variant="text" disabled={busy} onClick={() => void turnOff()}>Turn off</Button>}
				</div>
				<p className="at-muted gmove__note">Google reviews apps that read mail before they can be used by everyone; for your own server, Testing mode with your users as test users is enough.</p>
			</Card>
		</Section>
	)
}
