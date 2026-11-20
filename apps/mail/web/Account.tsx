// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'react'
import { Button, Card, Icon, Select, TextArea, TextField, confirmDialog, toast } from '@atrium/ui'
import { createAccount, deleteAccount, googleInfo, listMailboxes, oauthState, patchAccount, specialMailbox, updateAccount, updateSignature, type Account, type AccountInput, type GoogleInfo, type Mailbox } from './api'
import { detectProvider, googleAuthUrl, providerFields, type Provider } from './providers'

const empty: AccountInput = {
	accountName: '', emailAddress: '', imapHost: '', imapPort: 993, imapSslMode: 'ssl', imapUser: '', imapPassword: '',
	smtpHost: '', smtpPort: 465, smtpSslMode: 'ssl', smtpUser: '', smtpPassword: '', authMethod: 'password',
}
const fromAccount = (a: Account): AccountInput => ({
	accountName: a.name, emailAddress: a.emailAddress, imapHost: a.imapHost, imapPort: a.imapPort, imapSslMode: a.imapSslMode, imapUser: a.imapUser,
	smtpHost: a.smtpHost, smtpPort: a.smtpPort, smtpSslMode: a.smtpSslMode, smtpUser: a.smtpUser, authMethod: a.authMethod ?? 'password',
})

export function AccountSetup({ onDone, onBack }: { onDone: () => void, onBack?: () => void }) {
	return (
		<div className="ml-setup">
			<Card className="ml-setup__card">
				{onBack && <Button variant="text" size="s" icon="arrowBack" onClick={onBack}>Back to mail</Button>}
				<div className="ml-setup__hero"><Icon name="mail" /><h1>{onBack ? 'Add a mail account' : 'Connect your mail'}</h1><p>Gmail, Orange, Outlook, iCloud, Free, SFR, La Poste or any IMAP server. Read and send mail without leaving Wavium. Your credentials stay on your server.</p></div>
				<AccountForm onDone={onDone} />
			</Card>
		</div>
	)
}

export function AccountSettings({ account, boxes, onDone, onClose }: { account: Account, boxes: Mailbox[], onDone: () => void, onClose: () => void }) {
	const [signature, setSignature] = useState(account.signature ?? '')
	const own = boxes.filter((b) => b.accountId === account.id)
	const [roles, setRoles] = useState<Record<string, number | null>>({ draftsMailboxId: account.draftsMailboxId, sentMailboxId: account.sentMailboxId, trashMailboxId: account.trashMailboxId, archiveMailboxId: account.archiveMailboxId, junkMailboxId: account.junkMailboxId })

	async function saveRoles() {
		try { await patchAccount(account.id, roles); toast('Folder settings saved'); onDone() } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
	}
	async function saveSignature() {
		try { await updateSignature(account.id, signature); toast('Signature saved'); onDone() } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
	}
	async function remove() {
		if (!await confirmDialog(`Remove ${account.emailAddress} from Wavium? This does not delete mail from the mail server.`, { title: 'Remove mail account', confirm: 'Remove', danger: true })) return
		try { await deleteAccount(account.id); toast('Account removed'); onDone(); onClose() } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
	}

	return (
		<div className="ml-settings">
			<header className="ml-settings__head"><Button variant="text" icon="arrowBack" onClick={onClose}>Back to mail</Button><h1>Account settings</h1><p>{account.emailAddress}</p></header>
			<Card className="ml-settings__block"><h2>Connection</h2><AccountForm account={account} onDone={onDone} submitLabel="Save connection" /></Card>
			<Card className="ml-settings__block"><h2>Special folders</h2><div className="ml-settings__roles">
				{([['draftsMailboxId', 'Drafts'], ['sentMailboxId', 'Sent'], ['trashMailboxId', 'Trash'], ['archiveMailboxId', 'Archive'], ['junkMailboxId', 'Spam']] as const).map(([key, label]) => (
					<Select key={key} label={label} value={roles[key] ?? ''} onChange={(e) => setRoles((r) => ({ ...r, [key]: e.target.value ? Number(e.target.value) : null }))}>
						<option value="">Choose automatically</option>{own.map((b) => <option key={b.databaseId} value={b.databaseId}>{b.name}</option>)}
					</Select>
				))}
			</div><Button onClick={() => void saveRoles()}>Save folders</Button></Card>
			<Card className="ml-settings__block"><h2>Signature</h2><TextArea label="Signature" rows={6} value={signature} onChange={(e) => setSignature(e.target.value)} hint="Added to new messages you write from this account." /><Button onClick={() => void saveSignature()}>Save signature</Button></Card>
			{!account.isDelegated && <Card className="ml-settings__block ml-settings__danger"><h2>Remove account</h2><p>Stop syncing this account. Messages remain on the mail server.</p><Button variant="danger" icon="delete" onClick={() => void remove()}>Remove account</Button></Card>}
		</div>
	)
}

/** Ports are edited as text so the field can be emptied while typing; they become numbers on submit. */
type FormInput = Omit<AccountInput, 'imapPort' | 'smtpPort'> & { imapPort: string, smtpPort: string }
const toForm = (a: AccountInput): FormInput => ({ ...a, imapPort: String(a.imapPort), smtpPort: String(a.smtpPort) })

/** Opens Google's consent page in a window and resolves when the person closed it (or it closed itself). */
export function waitForPopup(url: string, open: typeof window.open = window.open.bind(window), every = 500): Promise<'closed' | 'blocked'> {
	const w = open(url, 'wavium-google', 'width=520,height=700')
	if (!w) return Promise.resolve('blocked')
	return new Promise((resolve) => {
		const t = setInterval(() => { if (w.closed) { clearInterval(t); resolve('closed') } }, every)
	})
}

const providerFieldsNum = (p: Provider, email: string) => {
	const f = providerFields(p, email)
	return { ...f, imapPort: Number(f.imapPort), smtpPort: Number(f.smtpPort) }
}

/** After the first connection: remember which folders are Drafts, Sent, Trash... */
async function setRoles(id: number) {
	const result = await listMailboxes(id, true)
	const roles: Record<string, number> = {}
	for (const role of ['drafts', 'sent', 'trash', 'archive', 'junk']) {
		const box = specialMailbox(result.mailboxes, role)
		if (box) roles[`${role}MailboxId`] = box.databaseId
	}
	if (Object.keys(roles).length) await patchAccount(id, roles)
}

function AccountForm({ account, onDone, submitLabel = 'Connect account' }: { account?: Account, onDone: () => void, submitLabel?: string }) {
	const [input, setInput] = useState<FormInput>(() => toForm(account ? fromAccount(account) : empty))
	const [busy, setBusy] = useState(false)
	const [google, setGoogle] = useState<GoogleInfo | null>(null)
	// New accounts at a known provider: servers are filled in and hidden until asked for.
	const [manual, setManual] = useState(!!account)
	const patch = (p: Partial<FormInput>) => setInput((v) => ({ ...v, ...p }))
	const provider: Provider | null = account ? null : detectProvider(input.emailAddress)
	const showServers = manual || !provider
	useEffect(() => { if (!account) googleInfo().then(setGoogle, () => setGoogle(null)) }, [account])

	function setEmail(email: string) {
		const p = account ? null : detectProvider(email)
		// A username the person has not typed yet still follows the address, letter by letter.
		const follows = (user: string) => !account && (user === '' || user.trim() === input.emailAddress.trim())
		patch({
			emailAddress: email,
			...(p && !manual ? providerFields(p, email) : {
				...(follows(input.imapUser) ? { imapUser: email } : {}),
				...(follows(input.smtpUser) ? { smtpUser: email } : {}),
			}),
		})
	}

	async function signInWithGoogle() {
		if (!google?.clientId) return
		setBusy(true)
		let created: Account | null = null
		try {
			const email = input.emailAddress.trim()
			created = await createAccount({
				accountName: input.accountName || email, emailAddress: email, ...providerFieldsNum(detectProvider(email)!, email), authMethod: 'xoauth2',
			})
			const { state } = await oauthState(created.id)
			const r = await waitForPopup(googleAuthUrl({ clientId: google.clientId, redirectUrl: google.redirectUrl, scope: google.scope, state, email }))
			if (r === 'blocked') throw new Error('Your browser blocked the Google window: allow pop-ups for this site and try again')
			await setRoles(created.id)
			toast('Gmail connected')
			onDone()
		} catch (e) {
			// A half-made account (Google refused or the window was closed early) is removed again.
			if (created) await deleteAccount(created.id).catch(() => {})
			toast.error(`Google sign-in did not finish: ${e instanceof Error ? e.message : String(e)}`)
		} finally { setBusy(false) }
	}

	async function submit() {
		setBusy(true)
		try {
			// With a known provider the one password field goes to both servers.
			const pw = !showServers ? { smtpPassword: input.imapPassword } : {}
			const value: AccountInput = { ...input, ...pw, imapPort: Number(input.imapPort), smtpPort: Number(input.smtpPort) }
			// Editing: a blank password means "keep the one saved" (the server would otherwise save an empty one).
			if (account && !value.imapPassword) delete value.imapPassword
			if (account && !value.smtpPassword) delete value.smtpPassword
			const saved = account ? await updateAccount(account.id, value) : await createAccount(value)
			if (!account) await setRoles(saved.id)
			toast(account ? 'Connection saved' : 'Mail account connected')
			onDone()
		} catch (e) { toast.error(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
	}

	return (
		<form className="ml-account-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
			<div className="ml-account-form__two"><TextField label="Account name" required value={input.accountName} onChange={(e) => patch({ accountName: e.target.value })} placeholder="Personal" /><TextField label="Email address" required type="email" value={input.emailAddress} onChange={(e) => setEmail(e.target.value)} /></div>
			{provider && <div className="ml-provider" aria-label="Provider">
				<p><strong>{provider.name}</strong>: server settings are filled in for you.{provider.note ? ` ${provider.note}` : ''}</p>
				<div className="ml-provider__actions">
					{provider.oauth === 'google' && google?.configured && <Button type="button" icon="key" busy={busy} onClick={() => void signInWithGoogle()}>Sign in with Google</Button>}
					{provider.appPasswordUrl && <a className="at-btn at-btn--text" href={provider.appPasswordUrl} target="_blank" rel="noopener noreferrer"><Icon name="openInNew" />Create an app password</a>}
				</div>
				{provider.oauth === 'google' && google?.configured && <p className="ml-provider__or">or connect with an app password:</p>}
			</div>}
			{!showServers && <TextField label={provider?.password === 'app' ? 'App password' : 'Password'} type="password" required value={input.imapPassword} onChange={(e) => patch({ imapPassword: e.target.value })} autoComplete="current-password" />}
			{!showServers && <Button type="button" variant="text" size="s" onClick={() => setManual(true)}>Server settings…</Button>}
			{showServers && <><fieldset><legend>IMAP · incoming mail</legend><div className="ml-account-form__server"><TextField label="Server" required value={input.imapHost} onChange={(e) => patch({ imapHost: e.target.value })} placeholder="imap.example.org" /><TextField label="Port" required type="number" min={1} max={65535} value={input.imapPort} onChange={(e) => patch({ imapPort: e.target.value })} /><Select label="Encryption" value={input.imapSslMode} onChange={(e) => patch({ imapSslMode: e.target.value })}><option value="ssl">SSL</option><option value="tls">STARTTLS</option><option value="none">None</option></Select></div><div className="ml-account-form__two"><TextField label="Username" required value={input.imapUser} onChange={(e) => patch({ imapUser: e.target.value })} /><TextField label={account ? 'New password (leave blank to keep)' : 'Password'} type="password" required={!account} value={input.imapPassword} onChange={(e) => patch({ imapPassword: e.target.value })} autoComplete="current-password" /></div></fieldset>
			<fieldset><legend>SMTP · outgoing mail</legend><div className="ml-account-form__server"><TextField label="Server" required value={input.smtpHost} onChange={(e) => patch({ smtpHost: e.target.value })} placeholder="smtp.example.org" /><TextField label="Port" required type="number" min={1} max={65535} value={input.smtpPort} onChange={(e) => patch({ smtpPort: e.target.value })} /><Select label="Encryption" value={input.smtpSslMode} onChange={(e) => patch({ smtpSslMode: e.target.value })}><option value="ssl">SSL</option><option value="tls">STARTTLS</option><option value="none">None</option></Select></div><div className="ml-account-form__two"><TextField label="Username" required value={input.smtpUser} onChange={(e) => patch({ smtpUser: e.target.value })} /><TextField label={account ? 'New password (leave blank to keep)' : 'Password'} type="password" required={!account} value={input.smtpPassword} onChange={(e) => patch({ smtpPassword: e.target.value })} autoComplete="current-password" /></div></fieldset></>}
			<Button type="submit" busy={busy} icon={account ? 'check' : 'add'}>{submitLabel}</Button>
		</form>
	)
}
