// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, useState } from 'react'
import { Button, Dialog, Icon, IconButton, Select, TextArea, TextField, confirmDialog, toast } from '@atrium/ui'
import { AddressField } from './AddressField'
import { htmlToText, RichEditor, textToHtml } from './RichText'
import { HttpError } from '@atrium/sdk'
import { createOutbox, deleteOutbox, parseAddresses, saveDraft, sendOutbox, updateOutbox, uploadAttachment, type Account, type Attachment, type ComposeData } from './api'

export interface ComposerState {
	accountId: number
	to: string
	cc: string
	bcc: string
	subject: string
	body: string
	attachments: Attachment[]
	draftId?: number
	outboxId?: number
	inReplyToMessageId?: string
	sendAt?: number | null
	/** P4-1c: set when writing with formatting. */
	html?: string | null
}

export const blankComposer = (accountId: number): ComposerState => ({ accountId, to: '', cc: '', bcc: '', subject: '', body: '', attachments: [] })
const localTime = (timestamp?: number | null) => timestamp ? new Date(timestamp * 1000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''

/** LocalMessage status codes from the Mail backend (lib/Db/LocalMessage.php) as readable reasons. */
const sendStatus: Record<number, string> = {
	1: 'No Sent folder is set for this account. Choose one in Account settings.',
	2: 'S/MIME signing needs a certificate.', 3: 'The S/MIME certificate is missing.', 4: 'Signing the message failed.',
	5: 'S/MIME encryption needs a certificate.', 6: 'The S/MIME certificate is missing.', 7: 'Encrypting the message failed.',
	8: 'Too many recipients.', 9: 'Sending limit reached, try again later.',
	10: 'The mail server (SMTP) refused the message. Check the outgoing server settings.',
	11: 'The message was sent, but could not be copied to the Sent folder.',
}
function sendError(e: unknown) {
	if (e instanceof HttpError) {
		const status = (e.body as { data?: { status?: number }[] } | undefined)?.data?.[0]?.status
		if (status !== undefined && sendStatus[status]) return `Not sent: ${sendStatus[status]} The message stays in the Outbox.`
	}
	return e instanceof Error ? e.message : String(e)
}

export function ComposeDialog({ initial, accounts, onClose, onDone, onPickDraft }: {
	initial: ComposerState
	accounts: Account[]
	onClose: () => void
	/** Choose another saved draft to continue writing instead of this message. */
	onPickDraft?: () => void
	onDone: (kind: 'sent' | 'draft' | 'scheduled') => void
}) {
	const [draft, setDraft] = useState(initial)
	const [showCc, setShowCc] = useState(!!initial.cc || !!initial.bcc)
	const [later, setLater] = useState(!!initial.sendAt)
	const [sendAt, setSendAt] = useState(localTime(initial.sendAt))
	const [busy, setBusy] = useState<'send' | 'draft' | 'delete' | null>(null)
	const [dirty, setDirty] = useState(false)
	const fileInput = useRef<HTMLInputElement>(null)
	const patch = (value: Partial<ComposerState>) => { setDraft((d) => ({ ...d, ...value })); setDirty(true) }
	const data = (): ComposeData => ({
		accountId: draft.accountId,
		subject: draft.subject.trim(),
		body: draft.html ? htmlToText(draft.html) : draft.body,
		html: draft.html || null,
		to: parseAddresses(draft.to),
		cc: parseAddresses(draft.cc),
		bcc: parseAddresses(draft.bcc),
		attachments: draft.attachments,
		draftId: draft.draftId,
		inReplyToMessageId: draft.inReplyToMessageId,
		sendAt: later && sendAt ? Math.floor(new Date(sendAt).getTime() / 1000) : null,
	})

	async function close() {
		if (!dirty || await confirmDialog('Discard this message?', { title: 'Discard draft', confirm: 'Discard', danger: true })) onClose()
	}

	async function pickDraft() {
		if (dirty && !await confirmDialog('Replace what you wrote with another draft? Save it first if you want to keep it.', { title: 'Open draft', confirm: 'Choose a draft' })) return
		onPickDraft?.()
	}

	async function submit(schedule = false) {
		const value = data()
		if (!value.to.length) { toast.error('Add at least one recipient'); return }
		if (schedule && !value.sendAt) { toast.error('Choose when to send the message'); return }
		setBusy('send')
		try {
			const message = draft.outboxId ? await updateOutbox(draft.outboxId, value) : await createOutbox(value)
			// Remember the outbox entry so a retry after a failed send updates it instead of queueing a duplicate.
			if (!draft.outboxId) setDraft((d) => ({ ...d, outboxId: message.id }))
			if (!schedule) await sendOutbox(message.id)
			toast(schedule ? 'Message scheduled' : 'Message sent')
			setDirty(false)
			onDone(schedule ? 'scheduled' : 'sent')
		} catch (e) { toast.error(sendError(e)) } finally { setBusy(null) }
	}

	async function save() {
		setBusy('draft')
		try {
			if (draft.outboxId) await updateOutbox(draft.outboxId, data())
			else await saveDraft(data())
			toast('Draft saved')
			setDirty(false)
			onDone('draft')
		} catch (e) { toast.error(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
	}

	async function removeOutbox() {
		if (!draft.outboxId) return
		setBusy('delete')
		try { await deleteOutbox(draft.outboxId); setDirty(false); onDone('draft') } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
	}

	async function attach(files: FileList | null) {
		if (!files) return
		setBusy('draft')
		try {
			for (const file of Array.from(files)) {
				const attachment = await uploadAttachment(draft.accountId, file)
				setDraft((d) => ({ ...d, attachments: [...d.attachments, attachment] }))
			}
			setDirty(true)
		} catch (e) { toast.error(e instanceof Error ? e.message : String(e)) } finally {
			setBusy(null)
			if (fileInput.current) fileInput.current.value = ''
		}
	}

	return (
		<Dialog open title={draft.outboxId ? 'Edit outgoing message' : 'New message'} onClose={() => { void close() }}>
			<form className="ml-composer" onSubmit={(e) => { e.preventDefault(); void submit(later) }}>
				<div className="ml-composer__account">
					<Select label="From" value={draft.accountId} onChange={(e) => patch({ accountId: Number(e.target.value) })}>
						{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} &lt;{a.emailAddress}&gt;</option>)}
					</Select>
					<Button variant="text" size="s" onClick={() => setShowCc((v) => !v)}>Cc / Bcc</Button>
				</div>
				<AddressField label="To" required autoFocus value={draft.to} onChange={(v) => patch({ to: v })} placeholder="name@example.org" />
				{showCc && <div className="ml-composer__cc"><AddressField label="Cc" value={draft.cc} onChange={(v) => patch({ cc: v })} /><AddressField label="Bcc" value={draft.bcc} onChange={(v) => patch({ bcc: v })} /></div>}
				<TextField label="Subject" value={draft.subject} onChange={(e) => patch({ subject: e.target.value })} />
				{draft.html != null
					? <RichEditor label="Message" value={draft.html} onChange={(html) => patch({ html })} />
					: <TextArea className="ml-composer__body" label="Message" rows={14} value={draft.body} onChange={(e) => patch({ body: e.target.value })} />}
				{draft.attachments.length > 0 && <div className="ml-attachments ml-attachments--compose">
					{draft.attachments.map((a) => <span className="ml-attachment" key={a.id}><Icon name="attachment" /><span>{a.fileName}</span><IconButton icon="close" label={`Remove ${a.fileName}`} onClick={() => patch({ attachments: draft.attachments.filter((x) => x !== a) })} /></span>)}
				</div>}
				{later && <TextField label="Send at" type="datetime-local" min={localTime(Math.floor(Date.now() / 1000))} value={sendAt} onChange={(e) => { setSendAt(e.target.value); setDirty(true) }} required />}
				<div className="ml-composer__footer">
					<div className="ml-composer__tools">
						<IconButton icon="attachment" label="Add attachments" onClick={() => fileInput.current?.click()} />
						<Button variant={draft.html != null ? 'tonal' : 'text'} size="s" onClick={() => {
							// Plain -> rich keeps the text; rich -> plain keeps its text version.
							if (draft.html != null) patch({ body: htmlToText(draft.html), html: null })
							else patch({ html: textToHtml(draft.body) })
						}}>{draft.html != null ? 'Plain text' : 'Formatting'}</Button>
						<input ref={fileInput} hidden type="file" multiple onChange={(e) => void attach(e.target.files)} />
						<IconButton icon="schedule" label={later ? 'Send immediately' : 'Schedule send'} variant={later ? 'tonal' : 'standard'} onClick={() => setLater((v) => !v)} />
						{draft.outboxId && <IconButton icon="delete" label="Delete outgoing message" disabled={busy !== null} onClick={() => void removeOutbox()} />}
					</div>
					<div className="ml-composer__actions">
						{onPickDraft && <Button variant="text" disabled={busy !== null} onClick={() => void pickDraft()}>Open draft</Button>}
						<Button variant="text" busy={busy === 'draft'} disabled={busy !== null} onClick={() => void save()}>Save draft</Button>
						<Button type="submit" icon={later ? 'schedule' : 'send'} busy={busy === 'send'} disabled={busy !== null}>{later ? 'Schedule' : 'Send'}</Button>
					</div>
				</div>
			</form>
		</Dialog>
	)
}
