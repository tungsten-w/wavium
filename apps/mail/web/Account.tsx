// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react'
import { Button, Card, Icon, Select, TextArea, TextField, confirmDialog, toast } from '@atrium/ui'
import { createAccount, deleteAccount, listMailboxes, patchAccount, specialMailbox, updateAccount, updateSignature, type Account, type AccountInput, type Mailbox } from './api'

const empty: AccountInput = {
	accountName: '', emailAddress: '', imapHost: '', imapPort: 993, imapSslMode: 'ssl', imapUser: '', imapPassword: '',
	smtpHost: '', smtpPort: 465, smtpSslMode: 'ssl', smtpUser: '', smtpPassword: '', authMethod: 'password',
}
const fromAccount = (a: Account): AccountInput => ({
	accountName: a.name, emailAddress: a.emailAddress, imapHost: a.imapHost, imapPort: a.imapPort, imapSslMode: a.imapSslMode, imapUser: a.imapUser,
	smtpHost: a.smtpHost, smtpPort: a.smtpPort, smtpSslMode: a.smtpSslMode, smtpUser: a.smtpUser, authMethod: 'password',
})

export function AccountSetup({ onDone }: { onDone: () => void }) {
	return (
		<div className="ml-setup">
			<Card className="ml-setup__card">
				<div className="ml-setup__hero"><Icon name="mail" /><h1>Connect your mail</h1><p>Read and send mail without leaving Wavium. Your credentials stay on your server.</p></div>
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

function AccountForm({ account, onDone, submitLabel = 'Connect account' }: { account?: Account, onDone: () => void, submitLabel?: string }) {
	const [input, setInput] = useState<FormInput>(() => toForm(account ? fromAccount(account) : empty))
	const [busy, setBusy] = useState(false)
	const patch = (p: Partial<FormInput>) => setInput((v) => ({ ...v, ...p }))

	async function submit() {
		setBusy(true)
		try {
			const value: AccountInput = { ...input, imapPort: Number(input.imapPort), smtpPort: Number(input.smtpPort) }
			const saved = account ? await updateAccount(account.id, value) : await createAccount(value)
			if (!account) {
				const result = await listMailboxes(saved.id, true)
				const roles: Record<string, number> = {}
				for (const role of ['drafts', 'sent', 'trash', 'archive', 'junk']) {
					const box = specialMailbox(result.mailboxes, role)
					if (box) roles[`${role}MailboxId`] = box.databaseId
				}
				if (Object.keys(roles).length) await patchAccount(saved.id, roles)
			}
			toast(account ? 'Connection saved' : 'Mail account connected')
			onDone()
		} catch (e) { toast.error(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
	}

	return (
		<form className="ml-account-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
			<div className="ml-account-form__two"><TextField label="Account name" required value={input.accountName} onChange={(e) => patch({ accountName: e.target.value })} placeholder="Personal" /><TextField label="Email address" required type="email" value={input.emailAddress} onChange={(e) => patch({ emailAddress: e.target.value, ...(!account && !input.imapUser && !input.smtpUser ? { imapUser: e.target.value, smtpUser: e.target.value } : {}) })} /></div>
			<fieldset><legend>IMAP · incoming mail</legend><div className="ml-account-form__server"><TextField label="Server" required value={input.imapHost} onChange={(e) => patch({ imapHost: e.target.value })} placeholder="imap.example.org" /><TextField label="Port" required type="number" min={1} max={65535} value={input.imapPort} onChange={(e) => patch({ imapPort: e.target.value })} /><Select label="Encryption" value={input.imapSslMode} onChange={(e) => patch({ imapSslMode: e.target.value })}><option value="ssl">SSL</option><option value="tls">STARTTLS</option><option value="none">None</option></Select></div><div className="ml-account-form__two"><TextField label="Username" required value={input.imapUser} onChange={(e) => patch({ imapUser: e.target.value })} /><TextField label={account ? 'New password (leave blank to keep)' : 'Password'} type="password" required={!account} value={input.imapPassword} onChange={(e) => patch({ imapPassword: e.target.value })} autoComplete="current-password" /></div></fieldset>
			<fieldset><legend>SMTP · outgoing mail</legend><div className="ml-account-form__server"><TextField label="Server" required value={input.smtpHost} onChange={(e) => patch({ smtpHost: e.target.value })} placeholder="smtp.example.org" /><TextField label="Port" required type="number" min={1} max={65535} value={input.smtpPort} onChange={(e) => patch({ smtpPort: e.target.value })} /><Select label="Encryption" value={input.smtpSslMode} onChange={(e) => patch({ smtpSslMode: e.target.value })}><option value="ssl">SSL</option><option value="tls">STARTTLS</option><option value="none">None</option></Select></div><div className="ml-account-form__two"><TextField label="Username" required value={input.smtpUser} onChange={(e) => patch({ smtpUser: e.target.value })} /><TextField label={account ? 'New password (leave blank to keep)' : 'Password'} type="password" required={!account} value={input.smtpPassword} onChange={(e) => patch({ smtpPassword: e.target.value })} autoComplete="current-password" /></div></fieldset>
			<Button type="submit" busy={busy} icon={account ? 'check' : 'add'}>{submitLabel}</Button>
		</form>
	)
}
