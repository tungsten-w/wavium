// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Assisted unsubscribe (PLAN P5-5): a banner on mailing-list mail. Nothing
// happens without a confirmation: one-click lists are told through Mail's own
// route; a web page opens in a new tab; a mailto becomes a mail in the composer
// for the user to send.
import { useEffect, useState } from 'react'
import { Button, Dialog, Icon, toast } from '@atrium/ui'
import { parseMailto, unsubscribeList, type MessageBody } from './api'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const webLink = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null)
const hostOf = (u: string) => { try { return new URL(u).host } catch { return u } }

export function UnsubscribeBanner({ body, onMailto }: { body: MessageBody, onMailto: (m: { to: string, subject: string, body: string }) => void }) {
	const [open, setOpen] = useState(false)
	const [busy, setBusy] = useState(false)
	const [done, setDone] = useState(false)
	useEffect(() => { setDone(false); setOpen(false) }, [body.databaseId])
	const url = webLink(body.unsubscribeUrl)
	const oneClick = !!url && !!body.isOneClickUnsubscribe
	const mailto = parseMailto(body.unsubscribeMailto)
	if (!url && !mailto) return null
	if (done) return <p className="ml-unsub ml-unsub--done"><Icon name="check" /> Unsubscribed. Mail already on its way may still arrive.</p>

	async function confirm() {
		if (oneClick) {
			setBusy(true)
			try {
				await unsubscribeList(body.databaseId)
				setDone(true)
				setOpen(false)
			} catch (e) {
				toast.error(`Could not unsubscribe: ${errText(e)}`)
			} finally { setBusy(false) }
		} else if (url) {
			window.open(url, '_blank', 'noopener,noreferrer')
			setOpen(false)
		} else if (mailto) {
			onMailto(mailto)
			setOpen(false)
		}
	}

	const what = oneClick
		? `Wavium will ask ${hostOf(url!)} to remove you from this list. You do not need to visit any page.`
		: url
			? `The list's unsubscribe page (${hostOf(url)}) opens in a new tab; finish there.`
			: `A mail to ${mailto!.to} is prepared in the composer; check it and send it.`
	const action = oneClick ? 'Unsubscribe' : url ? 'Open the page' : 'Prepare the mail'
	return (
		<>
			<p className="ml-unsub"><Icon name="mail" /> This mail comes from a mailing list.<Button variant="text" size="s" onClick={() => setOpen(true)}>Unsubscribe…</Button></p>
			<Dialog open={open} title="Unsubscribe from this list?" onClose={() => setOpen(false)} actions={<>
				<Button variant="text" onClick={() => setOpen(false)}>Cancel</Button>
				<Button busy={busy} onClick={() => void confirm()}>{action}</Button>
			</>}>
				<p>{what}</p>
				<p className="ml-st__muted">This mail stays where it is. To file the next ones automatically, add a rule in Mail &gt; Rules.</p>
			</Dialog>
		</>
	)
}
