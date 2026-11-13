// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { appUrl, defineApp, formatBytes, formatDate, navigate, relativeTime, useApp, useAppPath, useLocation } from '@atrium/sdk'
import { AppLayout, Avatar, Button, Dialog, EmptyState, Icon, IconButton, Menu, NavItem, NavSection, NavToggle, SearchBar, Select, Spinner, TextField, confirmDialog, toast } from '@atrium/ui'
import { AccountSettings, AccountSetup } from './Account'
import { ComposeDialog, blankComposer, type ComposerState } from './Compose'
import { MailRules } from './Rules'
import { ExtractDialog } from './Extract'
import { UnsubscribeBanner } from './Unsubscribe'
import { MailStatus } from './Status'
import { mismatchText, senderMismatch } from './spoof'
import { archiveTarget, kindBoxes, labelQuery, sortBoxes, type ViewKind } from './labels'
import { addressText, deleteMailbox, deleteMessage, displayAddress, folderLabel, formatAddress, getMessageBody, listAccounts, listMailboxes, listMerged, listByLabel, filterCategories, noLabel, defaultLabel, type LabelFilter, curatedHides, curatedTitle, loadCuratedHides, listOutbox, mailboxIcon, markAllRead, moveMessage, renameMailbox, createMailbox, deleteOutbox, searchFilter, setFlags, specialMailbox, syncMailbox, triageFor, reclassify, suggestReply, undoDelete, categoryLabels, urgencyLabels, type Triage, type Account, type Mailbox, type Message, type MessageBody, type LocalMessage } from './api'
import './style.css'

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
const messageDate = (timestamp: number) => formatDate(timestamp * 1000, { dateStyle: 'medium', timeStyle: 'short' })
/** Plain text of a message body (sanitized HTML or escaped plain text), keeping line breaks. */
function bodyText(body: MessageBody) {
	const doc = new DOMParser().parseFromString(body.body, 'text/html')
	if (body.hasHtmlBody) {
		doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'))
		doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, blockquote').forEach((el) => el.append('\n'))
	}
	return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}
const viewTitles: Record<ViewKind, string> = { inbox: 'Inbox', archive: 'Archive', starred: 'Favorites', drafts: 'Drafts' }
const quote = (text: string) => text.split('\n').map((line) => `> ${line}`).join('\n')

function Mail() {
	const { basePath, setTitle } = useApp()
	const path = useAppPath()
	const { hash } = useLocation()
	const seg = path.split('/').filter(Boolean).map(decodeURIComponent)
	const [accounts, setAccounts] = useState<Account[] | null>(null)
	const [boxes, setBoxes] = useState<Mailbox[]>([])
	const [messages, setMessages] = useState<Message[] | null>(null)
	const [outbox, setOutbox] = useState<LocalMessage[]>([])
	const [query, setQuery] = useState('')
	const [filter, setFilter] = useState('')
	const [loadingMore, setLoadingMore] = useState(false)
	// Set once the server has nothing older for this folder/search.
	const [reachedEnd, setReachedEnd] = useState(false)
	const [syncing, setSyncing] = useState(false)
	const [composer, setComposer] = useState<ComposerState | null>(null)
	const [folderDialog, setFolderDialog] = useState<{ box?: Mailbox, name: string } | null>(null)
	const [moveTarget, setMoveTarget] = useState('')
	// "Open draft" in the composer: the list of saved drafts to choose from.
	const [draftPicker, setDraftPicker] = useState<Message[] | null>(null)
	const [triage, setTriage] = useState<Record<number, Triage | null>>({})

	const [label, setLabel] = useState<LabelFilter>(defaultLabel)
	// The user's Curated list (Mail preference); bumped when it loads or changes.
	const [curatedVer, setCuratedVer] = useState(0)
	useEffect(() => { loadCuratedHides().catch(() => {}).finally(() => setCuratedVer((v) => v + 1)) }, [])
	// Inbox and Archive: one list over every account's folder of that kind.
	const view = seg[0] === 'view' && (seg[1] === 'inbox' || seg[1] === 'archive' || seg[1] === 'starred') ? seg[1] : null
	const mailboxId = seg[0] === 'box' ? Number(seg[1]) : null
	const messageId = (seg[0] === 'box' || seg[0] === 'view') && seg[2] === 'thread' ? Number(seg[3]) : null
	const isOutbox = seg[0] === 'outbox'
	const isSetup = seg[0] === 'setup'
	const isStatus = seg[0] === 'status'
	const isRules = seg[0] === 'rules'
	const settingsId = seg[0] === 'settings' ? Number(seg[1]) : null
	const mailbox = boxes.find((b) => b.databaseId === mailboxId) ?? null
	const viewBoxes = useMemo(() => view ? kindBoxes(view, accounts ?? [], boxes) : [], [view, accounts, boxes])
	const listIds = view ? viewBoxes.map((b) => b.databaseId) : mailboxId ? [mailboxId] : []
	const listKey = listIds.join(',')
	const selected = messages?.find((m) => m.databaseId === messageId) ?? null
	const selectedBox = selected ? boxes.find((b) => b.databaseId === selected.mailboxId) : undefined
	const account = accounts?.find((a) => a.id === (selectedBox?.accountId ?? mailbox?.accountId ?? settingsId)) ?? accounts?.[0]
	const accountBoxes = account ? boxes.filter((b) => b.accountId === account.id) : []
	const boxPath = view ? `${basePath}/view/${view}` : mailbox ? `${basePath}/box/${mailbox.databaseId}` : basePath
	const title = isStatus ? 'Status' : isOutbox ? 'Outbox' : view ? viewTitles[view] : mailbox ? folderLabel(mailbox) : 'Mail'
	// Favorites shows every starred mail, whatever its category.
	const labelOn = view !== 'starred' && !!(label.category || label.needsAction || label.curated)
	/** One page of the open list: a label filter, or plain mail / search, over one folder or several. */
	const fetchPage = (cursor?: number) => labelOn ? listByLabel(listIds, label, { cursor }) : listMerged(listIds, { filter, cursor })

	const loadAccounts = useCallback(async () => {
		try {
			const as = await listAccounts()
			setAccounts(as)
			const result = await Promise.all(as.map((a) => listMailboxes(a.id).then((r) => r.mailboxes).catch((e) => { toast.error(errorText(e)); return [] as Mailbox[] })))
			setBoxes(result.flat())
		} catch (e) {
			toast.error(`Could not load mail: ${errorText(e)}`)
			setAccounts([])
		}
	}, [])
	const loadOutbox = useCallback(() => listOutbox().then(setOutbox).catch((e) => toast.error(errorText(e))), [])
	useEffect(() => { void loadAccounts(); void loadOutbox() }, [loadAccounts, loadOutbox])

	useEffect(() => {
		const match = /^#\/(?:accounts\/\d+\/)?box\/(\d+)(?:\/thread\/(\d+))?/.exec(hash)
		if (match) navigate(`${basePath}/box/${match[1]}${match[2] ? `/thread/${match[2]}` : ''}`, { replace: true })
	}, [hash, basePath])
	useEffect(() => {
		if (seg.length === 0 && accounts?.length && boxes.length) {
			navigate(`${basePath}/view/inbox`, { replace: true })
		}
	}, [seg.length, accounts, boxes, basePath])
	useEffect(() => { setTitle(title === 'Mail' ? 'Mail' : `${title} - Mail`) }, [title, setTitle])

	useEffect(() => {
		if (!listIds.length) { setMessages(view && accounts ? [] : null); return }
		if (label.curated && curatedVer === 0) { setMessages(null); return }
		let live = true
		setMessages(null); setReachedEnd(false)
		fetchPage().then((ms) => { if (live) setMessages(ms) }).catch((e) => {
			if (live) { setMessages([]); toast.error(`Could not load messages: ${errorText(e)}`) }
		})
		return () => { live = false }
		// eslint-disable-next-line react-hooks/exhaustive-deps -- fetchPage follows these
	}, [listKey, filter, label, curatedVer])

	// Live sync of the open folder, like upstream Mail. It also records the
	// "ui-heartbeat" that keeps the background sync at 15 minutes (it slows to
	// 6 hours when Mail looks unused). Merges new, changed and vanished messages.
	useEffect(() => {
		if (!mailboxId || filter || labelOn || messages === null) return
		let stopped = false
		const tick = async () => {
			if (stopped || document.hidden) return
			try {
				const ids = (messages ?? []).map((m) => m.databaseId)
				const r = await syncMailbox(mailboxId, false, ids)
				if (stopped || !r || !Array.isArray(r.newMessages)) return
				const gone = new Set(r.vanishedMessages ?? [])
				const changed = new Map((r.changedMessages ?? []).map((m) => [m.databaseId, m]))
				if (gone.size || changed.size || r.newMessages.length) {
					setMessages((ms) => {
						const kept = (ms ?? []).filter((m) => !gone.has(m.databaseId)).map((m) => changed.get(m.databaseId) ?? m)
						const fresh = r.newMessages.filter((m) => !kept.some((k) => k.databaseId === m.databaseId))
						return [...fresh, ...kept].sort((a, b) => b.dateInt - a.dateInt)
					})
				}
				if (r.stats) setBoxes((bs) => bs.map((b) => b.databaseId === mailboxId ? { ...b, unread: r.stats.unread } : b))
			} catch { /* a failed background sync is retried on the next tick */ }
		}
		const timer = window.setInterval(() => { void tick() }, 60_000)
		const onVisible = () => { if (!document.hidden) void tick() }
		document.addEventListener('visibilitychange', onVisible)
		return () => { stopped = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
		// eslint-disable-next-line react-hooks/exhaustive-deps -- restart only when the folder or load state changes
	}, [mailboxId, filter, messages === null])

	// Merged Inbox/Archive: pick up new mail every minute (sync each folder, then merge page one).
	useEffect(() => {
		if (!view || filter || messages === null || !listIds.length) return
		let stopped = false
		const tick = async () => {
			if (stopped || document.hidden) return
			try {
				await Promise.all(listIds.map((id) => syncMailbox(id, false).catch(() => null)))
				const fresh = await fetchPage()
				if (stopped) return
				setMessages((ms) => {
					const have = new Set((ms ?? []).map((m) => m.databaseId))
					const add = fresh.filter((m) => !have.has(m.databaseId))
					return add.length ? [...add, ...(ms ?? [])].sort((a, b) => b.dateInt - a.dateInt) : ms
				})
				void loadAccounts()
			} catch { /* retried on the next tick */ }
		}
		const timer = window.setInterval(() => { void tick() }, 60_000)
		const onVisible = () => { if (!document.hidden) void tick() }
		document.addEventListener('visibilitychange', onVisible)
		return () => { stopped = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
		// eslint-disable-next-line react-hooks/exhaustive-deps -- restart when the list or its filters change
	}, [view, listKey, filter, label, messages === null])

	// Classification chips: fetch for listed messages we have no answer for yet.
	useEffect(() => {
		const missing = (messages ?? []).map((m) => m.databaseId).filter((id) => !(id in triage))
		if (!missing.length) return
		let live = true
		triageFor(missing).then((found) => {
			if (!live) return
			// Remember misses as null so they are not asked again until reload.
			setTriage((t) => ({ ...t, ...Object.fromEntries(missing.map((id) => [id, found[id] ?? null])) }))
		}).catch(() => { /* chips are optional */ })
		return () => { live = false }
		// eslint-disable-next-line react-hooks/exhaustive-deps -- triage is an accumulator
	}, [messages])

	const more = async () => {
		if (!listIds.length || !messages?.length || loadingMore || reachedEnd) return
		setLoadingMore(true)
		try {
			const cursor = Math.min(...messages.map((m) => m.dateInt))
			const older = await fetchPage(cursor)
			if (!older.length) setReachedEnd(true)
			setMessages((ms) => [...(ms ?? []), ...older.filter((m) => !(ms ?? []).some((old) => old.databaseId === m.databaseId))])
		} catch (e) { toast.error(errorText(e)) } finally { setLoadingMore(false) }
	}
	const refresh = async () => {
		if (!listIds.length) { await loadAccounts(); return }
		setSyncing(true)
		try {
			await Promise.all(listIds.map((id) => syncMailbox(id, true)))
			const [ms] = await Promise.all([fetchPage(), loadAccounts()])
			setMessages(ms)
			toast('Mailbox is up to date')
		} catch (e) { toast.error(`Could not sync: ${errorText(e)}`) } finally { setSyncing(false) }
	}
	const openDraftPicker = async () => {
		try {
			const ids = kindBoxes('drafts', accounts ?? [], boxes).map((b) => b.databaseId)
			setDraftPicker(ids.length ? await listMerged(ids, { limit: 50 }) : [])
		} catch (e) { toast.error(errorText(e)) }
	}
	const pickDraft = async (m: Message) => {
		try {
			const body = await getMessageBody(m.databaseId)
			setDraftPicker(null)
			setComposer({ ...blankComposer(body.accountId), to: addressText(body.to), cc: addressText(body.cc), bcc: addressText(body.bcc), subject: body.subject, body: bodyText(body), draftId: body.databaseId, inReplyToMessageId: body.messageId })
		} catch (e) { toast.error(errorText(e)) }
	}
	const startCompose = (value?: Partial<ComposerState>) => {
		if (!account) return
		setComposer({ ...blankComposer(account.id), body: account.signature ? `\n\n${account.signature}` : '', ...value })
	}
	const patchMessage = async (message: Message, flags: Parameters<typeof setFlags>[1]) => {
		try {
			await setFlags(message.databaseId, flags)
			setMessages((ms) => (ms ?? []).map((m) => m.databaseId === message.databaseId ? { ...m, flags: { ...m.flags, ...flags } } : m))
		} catch (e) { toast.error(errorText(e)) }
	}
	const move = async (message: Message, destination: number) => {
		try {
			await moveMessage(message.databaseId, destination)
			setMessages((ms) => (ms ?? []).filter((m) => m.databaseId !== message.databaseId))
			if (messageId === message.databaseId) navigate(boxPath)
			toast(`Moved to ${folderLabel(boxes.find((b) => b.databaseId === destination)!)}`)
		} catch (e) { toast.error(errorText(e)) }
	}
	const remove = async (message: Message) => {
		try {
			await deleteMessage(message.databaseId)
			setMessages((ms) => (ms ?? []).filter((m) => m.databaseId !== message.databaseId))
			if (messageId === message.databaseId) navigate(boxPath)
			const acc = accounts?.find((a) => a.id === boxes.find((b) => b.databaseId === message.mailboxId)?.accountId)
			const trashId = acc?.trashMailboxId ?? null
			// Undo: only for mail moved to Trash (not for a delete inside Trash) with a Message-ID to find it again.
			if (acc && trashId !== null && trashId !== message.mailboxId && message.messageId) {
				toast('Moved to Trash', { action: { label: 'Undo', onClick: () => {
					undoDelete(acc.id, trashId, message.messageId, message.mailboxId)
						.then(() => { toast('Message restored'); setCuratedVer((v) => v + 1) })
						.catch((e) => toast.error(errorText(e)))
				} } })
			} else {
				toast('Message deleted')
			}
		} catch (e) { toast.error(errorText(e)) }
	}
	const saveFolder = async () => {
		if (!folderDialog?.name.trim() || !account) return
		try {
			if (folderDialog.box) await renameMailbox(folderDialog.box.databaseId, folderDialog.name.trim())
			else await createMailbox(account.id, folderDialog.name.trim())
			setFolderDialog(null)
			await loadAccounts()
		} catch (e) { toast.error(errorText(e)) }
	}
	const removeFolder = async (box: Mailbox) => {
		if (!await confirmDialog(`Delete the folder “${folderLabel(box)}” and its messages on the mail server?`, { title: 'Delete folder', confirm: 'Delete', danger: true })) return
		try { await deleteMailbox(box.databaseId); if (mailboxId === box.databaseId) navigate(basePath); await loadAccounts() } catch (e) { toast.error(errorText(e)) }
	}
	const reply = (body: MessageBody, all = false) => startCompose({
		to: addressText(body.replyTo.length ? body.replyTo : body.from), cc: all ? addressText(body.cc) : '',
		subject: /^re:/i.test(body.subject) ? body.subject : `Re: ${body.subject}`,
		body: `\n\nOn ${messageDate(body.dateInt)}, ${displayAddress(body.from[0])} wrote:\n${quote(bodyText(body))}`,
		inReplyToMessageId: body.messageId,
	})
	const [suggesting, setSuggesting] = useState(false)
	/** P5-2: the user's AI writes the reply into the composer; the human edits and sends. */
	const suggest = async (body: MessageBody) => {
		setSuggesting(true)
		try {
			const s = await suggestReply(body.databaseId)
			startCompose({
				to: addressText(body.replyTo.length ? body.replyTo : body.from),
				subject: s.subject,
				body: `${s.body}${account?.signature ? `\n\n${account.signature}` : ''}\n\nOn ${messageDate(body.dateInt)}, ${displayAddress(body.from[0])} wrote:\n${quote(bodyText(body))}`,
				inReplyToMessageId: body.messageId,
			})
		} catch (e) {
			toast.error(errorText(e))
		} finally {
			setSuggesting(false)
		}
	}
	const forward = (body: MessageBody) => startCompose({
		subject: /^fwd:/i.test(body.subject) ? body.subject : `Fwd: ${body.subject}`,
		body: `\n\n---------- Forwarded message ----------\nFrom: ${addressText(body.from)}\nDate: ${messageDate(body.dateInt)}\nSubject: ${body.subject}\nTo: ${addressText(body.to)}\n\n${bodyText(body)}`,
	})

	const inboxGroup = kindBoxes('inbox', accounts ?? [], boxes)
	const archiveTotal = kindBoxes('archive', accounts ?? [], boxes).reduce((n, b) => n + (b.total ?? 0), 0)
	const nav = accounts && accounts.length > 0 ? <>
		<div className="ml-compose"><Button icon="edit" block onClick={() => startCompose()}>New message</Button></div>
		{/* What still needs handling on top, what is handled below: both accounts together. */}
		<NavSection>
			<NavItem icon="inbox" label="Inbox" count={inboxGroup.reduce((n, b) => n + b.unread, 0) || undefined} active={view === 'inbox'} onClick={() => navigate(`${basePath}/view/inbox`)} />
			<NavItem icon="star" label="Favorites" active={view === 'starred'} onClick={() => navigate(`${basePath}/view/starred`)} />
			<NavItem icon="archive" label="Archive" count={archiveTotal || undefined} active={view === 'archive'} onClick={() => navigate(`${basePath}/view/archive`)} />
			<NavItem icon="send" label="Outbox" count={outbox.length || undefined} active={isOutbox} onClick={() => navigate(`${basePath}/outbox`)} />
		</NavSection>
		{accounts.map((a) => <NavSection key={a.id} id={`account-${a.id}`} collapsible title={a.name}
			actions={<IconButton icon="settings" label={`${a.name} settings`} className={settingsId === a.id ? 'ml-gear--on' : ''} onClick={() => navigate(`${basePath}/settings/${a.id}`)} />}>
			{sortBoxes(boxes.filter((b) => b.accountId === a.id)).map((b) => <NavItem key={b.databaseId} icon={mailboxIcon(b)} label={folderLabel(b)} count={(b.specialRole === 'archive' || b.specialRole === 'all' ? b.total : b.unread) || undefined} active={mailboxId === b.databaseId}
				href={`${basePath}/box/${b.databaseId}`} onClick={() => navigate(`${basePath}/box/${b.databaseId}`)}
				actions={<span className="ml-folder-menu" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}><Menu trigger={(open, expanded) => <IconButton icon="moreVert" label={`${folderLabel(b)} actions`} aria-expanded={expanded} onClick={open} />} items={[
					{ label: 'Mark all as read', icon: 'check', onClick: () => { void markAllRead(b.databaseId).then(loadAccounts).catch((e) => toast.error(errorText(e))) } },
					!b.specialRole && { label: 'Rename', icon: 'edit', onClick: () => setFolderDialog({ box: b, name: b.name }) },
					!b.specialRole && { label: 'Delete', icon: 'delete', danger: true, onClick: () => { void removeFolder(b) } },
				]} /></span>} />)}
			<NavItem icon="add" label="New folder" onClick={() => setFolderDialog({ name: '' })} />
		</NavSection>)}
		{/* Status sits at the bottom of the sidebar; each account's settings are the gear on its header. */}
		<div className="ml-nav-foot">
			<NavItem icon="route" label="Rules" active={isRules} onClick={() => navigate(`${basePath}/rules`)} />
			<NavItem icon="barChart" label="Status" active={isStatus} onClick={() => navigate(`${basePath}/status`)} />
		</div>
	</> : null

	if (accounts === null) return <AppLayout nav={nav}><div className="ml-center"><Spinner /></div></AppLayout>
	if (!accounts.length || isSetup) return <AccountSetup onDone={() => { void loadAccounts().then(() => navigate(basePath)) }} />
	if (isRules) return <AppLayout nav={nav}><MailRules /></AppLayout>
	if (isStatus) return <AppLayout nav={nav}><MailStatus onCuratedChange={() => setCuratedVer((v) => v + 1)} /></AppLayout>
	if (settingsId && accounts.some((a) => a.id === settingsId)) return <AppLayout nav={nav}><AccountSettings key={settingsId} account={accounts.find((a) => a.id === settingsId)!} boxes={boxes} onDone={loadAccounts} onClose={() => navigate(basePath)} /></AppLayout>

	return <AppLayout nav={nav}>
		<div className={`ml ${messageId ? 'ml--reading' : ''}`}>
			<section className="ml-list" aria-label="Messages">
				<header className="ml-list__head"><NavToggle /><h1>{title}</h1><IconButton icon="refresh" label="Sync mailbox" disabled={syncing} onClick={() => void refresh()} /></header>
				{!isOutbox && <form className="ml-search" onSubmit={(e) => { e.preventDefault(); const l = labelQuery(query); if (l) { setFilter(''); setLabel(l) } else { setLabel(noLabel); setFilter(searchFilter(query)) } }}><SearchBar value={query} onChange={setQuery} placeholder="Search mail" /><Button type="submit" size="s">Search</Button></form>}
				{!isOutbox && view !== 'starred' && listIds.length > 0 && <div className="ml-labels" role="group" aria-label="Filter by label">
					<button className={`ml-chip ${label.curated && !label.category && !label.needsAction ? 'ml-chip--on' : ''}`} title={curatedTitle(curatedHides)} onClick={() => { setFilter(''); setQuery(''); setLabel(defaultLabel) }}>Curated</button>
					<button className={`ml-chip ${!labelOn ? 'ml-chip--on' : ''}`} onClick={() => { setFilter(''); setQuery(''); setLabel(noLabel) }}>All</button>
					<button className={`ml-chip ml-chip--act ${label.needsAction ? 'ml-chip--on' : ''}`} onClick={() => { setFilter(''); setQuery(''); setLabel((l) => ({ ...l, needsAction: !l.needsAction })) }}>Needs action</button>
					{filterCategories.map((c) => <button key={c} className={`ml-chip ${label.category === c ? 'ml-chip--on' : ''}`} onClick={() => { setFilter(''); setQuery(''); setLabel((l) => ({ ...l, curated: false, category: l.category === c ? '' : c })) }}>{categoryLabels[c]}</button>)}
				</div>}
				{labelOn && query.trim() && <div className="ml-filter"><span>Showing {[label.category && categoryLabels[label.category], label.needsAction && 'needs action'].filter(Boolean).join(' · ')}</span><Button variant="text" size="s" onClick={() => { setLabel(noLabel); setQuery('') }}>Clear</Button></div>}
				{filter && <div className="ml-filter"><span>Results for “{query}”</span><Button variant="text" size="s" onClick={() => { setFilter(''); setQuery('') }}>Clear search</Button></div>}
				{isOutbox ? <Outbox messages={outbox} accounts={accounts} onEdit={(m) => setComposer({ accountId: m.accountId, to: addressText(m.to), cc: addressText(m.cc), bcc: addressText(m.bcc), subject: m.subject, body: m.editorBody ?? m.bodyPlain ?? '', attachments: m.attachments, outboxId: m.id, sendAt: m.sendAt })} onReload={loadOutbox} />
					: messages === null ? <div className="ml-center"><Spinner /></div>
					: messages.length === 0 ? <EmptyState icon="mail" title={filter ? 'No messages match your search' : 'This folder is empty'} />
					: <><ul className="ml-messages">{messages.map((m) => <MessageRow key={m.databaseId} message={m} triage={triage[m.databaseId]} outgoing={mailbox?.specialRole === 'sent' || mailbox?.specialRole === 'drafts'} selected={messageId === m.databaseId} onOpen={() => navigate(`${boxPath}/thread/${m.databaseId}`)} onFlag={() => void patchMessage(m, { flagged: !m.flags.flagged })} onArchive={mailbox?.specialRole === 'sent' || mailbox?.specialRole === 'drafts' ? undefined : (() => { const t = archiveTarget(boxes, m.mailboxId); return t ? () => void move(m, t.databaseId) : undefined })()} />)}</ul>
						{!reachedEnd && <LoadMore busy={loadingMore} onVisible={() => void more()} />}</>}
			</section>
			<section className="ml-reader" aria-label="Message">
				{messageId ? <Reader id={messageId} message={selected} triage={triage[messageId]} onTriage={(t) => setTriage((m) => ({ ...m, [messageId]: t }))} boxes={accountBoxes} moveTarget={moveTarget} setMoveTarget={setMoveTarget}
					onClose={() => navigate(boxPath)} onFlags={(flags) => { if (selected) void patchMessage(selected, flags) }} onMove={(id) => { if (selected) void move(selected, id) }} onDelete={() => { if (selected) void remove(selected) }}
					onReply={reply} onSuggest={suggest} suggesting={suggesting} onMailto={(m) => startCompose({ to: m.to, subject: m.subject, body: m.body })} onForward={forward} onEdit={(body) => startCompose({ to: addressText(body.to), cc: addressText(body.cc), bcc: addressText(body.bcc), subject: body.subject, body: bodyText(body), draftId: body.databaseId, inReplyToMessageId: body.messageId })} />
					: <EmptyState icon="mail" title="Choose a message to read" />}
			</section>
		</div>
		{!messageId && <button className="ml-fab" aria-label="New message" onClick={() => startCompose()}><Icon name="edit" /></button>}
		{composer && <ComposeDialog key={composer.draftId ?? 'new'} onPickDraft={() => void openDraftPicker()} initial={composer} accounts={accounts} onClose={() => setComposer(null)} onDone={() => { setComposer(null); void loadOutbox(); if (mailbox?.specialRole === 'drafts') void refresh() }} />}
		<Dialog open={!!draftPicker} title="Open draft" onClose={() => setDraftPicker(null)} actions={<Button variant="text" onClick={() => setDraftPicker(null)}>Cancel</Button>}>
			{draftPicker?.length ? <ul className="ml-drafts">{draftPicker.map((m) => <li key={m.databaseId}><button onClick={() => void pickDraft(m)}><strong>{m.subject || '(no subject)'}</strong><small>{m.to.length ? `To ${m.to.map((a) => displayAddress(a)).join(', ')}` : 'No recipients'} · {relativeTime(m.dateInt * 1000)}</small></button></li>)}</ul> : <p>You have no saved drafts.</p>}
		</Dialog>
		<Dialog open={!!folderDialog} title={folderDialog?.box ? 'Rename folder' : 'New folder'} onClose={() => setFolderDialog(null)} actions={<><Button variant="text" onClick={() => setFolderDialog(null)}>Cancel</Button><Button onClick={() => void saveFolder()}>Save</Button></>}>
			<TextField label="Folder name" autoFocus value={folderDialog?.name ?? ''} onChange={(e) => setFolderDialog((d) => d ? { ...d, name: e.target.value } : d)} />
		</Dialog>
	</AppLayout>
}

/**
 * The mail itself, in a sandboxed iframe, like upstream Mail. The sandbox allows
 * no scripts and no forms, the policy allows only inline styles and images, and
 * links open in a new tab. So whatever a sender puts in a mail (CSS, markup, or
 * a script the sanitizer missed) cannot touch Atrium, and Atrium's styles do
 * not touch the mail.
 */
function MailBody({ html, plain }: { html: string, plain: boolean }) {
	const frame = useRef<HTMLIFrameElement>(null)
	const [height, setHeight] = useState(120)
	const doc = useMemo(() => {
		const fg = getComputedStyle(document.body).color
		return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'"><base target="_blank">`
			+ `<style>html{color-scheme:normal}body{margin:0;font:15px/1.65 system-ui,sans-serif;color:${fg};overflow-wrap:anywhere;overflow-x:auto}`
			+ `img{max-width:100%;height:auto}pre{max-width:100%;overflow-x:auto}blockquote{margin-left:0;padding-left:16px;border-left:3px solid #8886}a{color:#8a4fb5}${plain ? 'body{white-space:pre-wrap}' : ''}</style>`
			+ `<body>${html}</body>`
	}, [html, plain])
	useEffect(() => {
		const f = frame.current
		if (!f) return
		let ro: ResizeObserver | undefined
		const fit = () => { const d = f.contentDocument; if (d?.documentElement) setHeight(Math.max(60, d.documentElement.scrollHeight)) }
		const onLoad = () => { fit(); const d = f.contentDocument; if (d?.body && typeof ResizeObserver !== 'undefined') { ro?.disconnect(); ro = new ResizeObserver(fit); ro.observe(d.body) } }
		f.addEventListener('load', onLoad)
		return () => { f.removeEventListener('load', onLoad); ro?.disconnect() }
	}, [doc])
	// allow-same-origin only lets Atrium measure the frame; without allow-scripts nothing inside can run.
	return <iframe ref={frame} className="ml-body ml-body--frame" title="Message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} style={{ height }} />
}
/** Loads older mail when it scrolls into view (a little before the end), no button. */
function LoadMore({ busy, onVisible }: { busy: boolean, onVisible: () => void }) {
	const ref = useRef<HTMLDivElement>(null)
	const cb = useRef(onVisible)
	cb.current = onVisible
	useEffect(() => {
		const el = ref.current
		if (!el) return
		const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) cb.current() }, { rootMargin: '0px 0px 600px 0px' })
		io.observe(el)
		return () => io.disconnect()
	}, [])
	// Re-check after each page: a short page can leave the sentinel visible.
	useEffect(() => {
		if (busy || !ref.current) return
		const r = ref.current.getBoundingClientRect()
		if (r.top < window.innerHeight + 600) cb.current()
	}, [busy])
	return <div ref={ref} className="ml-more">{busy && <Spinner small />}</div>
}

/** The sender's name claims a brand, domain or address its own domain does not match (P5-4). */
function SpoofChip({ from }: { from?: Message['from'][number] | null }) {
	const m = senderMismatch(from)
	return m ? <span className="ml-tags"><span className="ml-tag ml-tag--danger" title={mismatchText(m)}>Sender mismatch</span></span> : null
}

function SpoofBanner({ from }: { from?: Message['from'][number] | null }) {
	const m = senderMismatch(from)
	return m ? <p className="ml-spoof" role="alert"><Icon name="warning" /> {mismatchText(m)}</p> : null
}

/** Chips for what the classifier found: category, urgency when it matters, and the strong yes/no signals. */
function TriageChips({ t }: { t?: Triage | null }) {
	if (!t) return null
	const chips: [string, string][] = []
	if (t.suspicious !== null && t.suspicious >= 0.6) chips.push(['Suspicious', 'danger'])
	if (t.urgency === 'now' || t.urgency === 'today') chips.push([urgencyLabels[t.urgency], 'urgent'])
	if (t.needsReply !== null && t.needsReply >= 0.6) chips.push(['Needs reply', 'act'])
	else if (t.needsAction !== null && t.needsAction >= 0.6) chips.push(['Needs action', 'act'])
	if (t.hasDeadline !== null && t.hasDeadline >= 0.6) chips.push(['Deadline', 'act'])
	if (t.category) chips.push([categoryLabels[t.category] ?? t.category, `cat ml-tag--${t.category}`])
	return <span className="ml-tags">{chips.map(([label, kind]) => <span key={label} className={`ml-tag ml-tag--${kind}`}>{label}</span>)}</span>
}

/** Under the sender in the reader: what the classifier said, or where the mail is in the queue. */
function TriageLine({ t, busy }: { t?: Triage | null, busy: boolean }) {
	if (busy) return <p className="ml-triage"><Spinner small /> Classifying…</p>
	if (!t || t.queue === undefined) return null
	if (t.category) {
		const pct = (v: number | null) => v === null ? null : Math.round(v * 100)
		const bits = [categoryLabels[t.category] ?? t.category, t.urgency && `urgency: ${(urgencyLabels[t.urgency] ?? t.urgency).toLowerCase()}`,
			pct(t.needsReply) !== null && `reply ${pct(t.needsReply)}%`, pct(t.needsAction) !== null && `action ${pct(t.needsAction)}%`].filter(Boolean)
		return <p className="ml-triage"><Icon name="label" /> {bits.join(' · ')}{t.classifiedAt && <small> · classified {relativeTime(t.classifiedAt * 1000)}</small>}</p>
	}
	if (t.queue === 'pending') return <p className="ml-triage"><Icon name="schedule" /> Waiting to be classified{t.attempts ? ` (tried ${t.attempts}×: ${t.error ?? 'error'})` : ''}</p>
	if (t.queue === 'parked') return <p className="ml-triage ml-triage--error"><Icon name="warning" /> Classification gave up: {t.error ?? 'unknown error'}. Use ⋮ › Reclassify to try again.</p>
	return <p className="ml-triage"><Icon name="label" /> Not classified (only Inbox and Spam are classified automatically). Use ⋮ › Reclassify.</p>
}

function MessageRow({ message, triage, selected, outgoing, onOpen, onFlag, onArchive }: { message: Message, triage?: Triage | null, selected: boolean, outgoing?: boolean, onOpen: () => void, onFlag: () => void, onArchive?: () => void }) {
	// In Sent and Drafts the interesting party is the recipient, not ourselves.
	const who = outgoing ? (message.to.length ? `To ${message.to.map((a) => displayAddress(a)).join(', ')}` : 'No recipients') : displayAddress(message.from[0])
	const avatar = outgoing ? displayAddress(message.to[0]) : displayAddress(message.from[0])
	return <li className={`ml-message ${selected ? 'ml-message--selected' : ''} ${message.flags.seen ? '' : 'ml-message--unread'}`}>
		<button className="ml-message__main" onClick={onOpen}>
			<Avatar name={avatar} size={40} />
			<span className="ml-message__text"><span className="ml-message__top"><strong>{who}</strong><time>{relativeTime(message.dateInt * 1000)}</time></span>{!outgoing && message.from[0]?.email && <span className="ml-message__from">{message.from[0].email}</span>}<span className="ml-message__subject">{message.subject || '(no subject)'}</span><span className="ml-message__preview">{message.previewText || addressText(message.to)}</span>{message.goneFromServer && <span className="ml-kept" title="No longer on the mail server: Atrium keeps its own copy"><Icon name="archive" /> Only in Atrium</span>}<SpoofChip from={outgoing ? null : message.from[0]} /><TriageChips t={triage} /></span>
		</button>
		<div className="ml-message__actions">
			<IconButton className={`ml-star ${message.flags.flagged ? 'ml-star--on' : ''}`} icon={message.flags.flagged ? 'star' : 'starBorder'} label={message.flags.flagged ? 'Unstar message' : 'Star message'} onClick={onFlag} />
			{onArchive && <IconButton className="ml-archive" icon="archive" label="Archive message" onClick={onArchive} />}
		</div>
	</li>
}

function Reader({ id, message, triage, onTriage, boxes, moveTarget, setMoveTarget, onClose, onFlags, onMove, onDelete, onReply, onSuggest, suggesting, onMailto, onForward, onEdit }: {
	id: number, message: Message | null, triage?: Triage | null, onTriage: (t: Triage | null) => void, boxes: Mailbox[], moveTarget: string, setMoveTarget: (v: string) => void,
	onClose: () => void, onFlags: (f: { seen?: boolean, flagged?: boolean }) => void, onMove: (id: number) => void, onDelete: () => void,
	onReply: (b: MessageBody, all?: boolean) => void, onForward: (b: MessageBody) => void, onEdit: (b: MessageBody) => void,
	onSuggest?: (b: MessageBody) => void, suggesting?: boolean,
	onMailto?: (m: { to: string, subject: string, body: string }) => void,
}) {
	const [body, setBody] = useState<MessageBody | null>(null)
	const [error, setError] = useState('')
	useEffect(() => {
		let live = true
		setBody(null); setError('')
		getMessageBody(id).then((b) => { if (live) { setBody(b); onFlags({ seen: true }) } }).catch((e) => { if (live) setError(errorText(e)) })
		return () => { live = false }
		// The flag callback belongs to the selected message, not to body loading.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id])
	const subject = body?.subject ?? message?.subject ?? '(no subject)'
	const [classifying, setClassifying] = useState(false)
	// Archive = the Archive folder, or Gmail's All Mail (moving there just drops the Inbox label).
	const archiveBox = archiveTarget(boxes, message?.mailboxId ?? body?.mailboxId ?? -1)
	const runReclassify = async () => {
		if (classifying) return
		setClassifying(true)
		try {
			const r = await reclassify(id)
			onTriage(r.triage)
			if (r.classified) toast('Classified again')
			else toast(r.reason ?? 'Queued for classification')
		} catch (e) { toast.error(errorText(e)) } finally { setClassifying(false) }
	}
	const [showImages, setShowImages] = useState(false)
	useEffect(() => setShowImages(false), [id])
	const [extractOpen, setExtractOpen] = useState(false)
	useEffect(() => setExtractOpen(false), [id])
	// Mail's sanitizer swaps remote images for a placeholder and keeps the proxied URL in data-original-src.
	const blocked = !!body?.body.includes('data-original-src')
	const html = useMemo(() => {
		if (!body || !showImages || !blocked) return body?.body ?? ''
		const doc = new DOMParser().parseFromString(body.body, 'text/html')
		doc.querySelectorAll<HTMLElement>('[data-original-src]').forEach((el) => { el.setAttribute('src', el.dataset.originalSrc!); el.style.removeProperty('display') })
		return doc.body.innerHTML
	}, [body, showImages, blocked])
	return <article className="ml-article">
		<header className="ml-reader__tools"><IconButton icon="arrowBack" label="Back to messages" onClick={onClose} /><span className="ml-reader__spacer" />
			{message && <><IconButton icon={message.flags.flagged ? 'star' : 'starBorder'} label={message.flags.flagged ? 'Unstar message' : 'Star message'} onClick={() => onFlags({ flagged: !message.flags.flagged })} />
			<IconButton icon={message.flags.seen ? 'mail' : 'check'} label={message.flags.seen ? 'Mark as unread' : 'Mark as read'} onClick={() => onFlags({ seen: !message.flags.seen })} /></>}
			{archiveBox && archiveBox.databaseId !== message?.mailboxId && <IconButton icon="archive" label="Archive message" onClick={() => onMove(archiveBox.databaseId)} />}
			<Select className="ml-move" label="Move to" value={moveTarget} onChange={(e) => { setMoveTarget(e.target.value); if (e.target.value) onMove(Number(e.target.value)) }}><option value="">Move to…</option>{boxes.filter((b) => b.databaseId !== body?.mailboxId).map((b) => <option key={b.databaseId} value={b.databaseId}>{folderLabel(b)}</option>)}</Select>
			<IconButton icon="delete" label="Delete message" onClick={onDelete} />
			<Menu trigger={(open, expanded) => <IconButton icon="moreVert" label="More actions" aria-expanded={expanded} onClick={open} />} items={[
				{ label: classifying ? 'Classifying…' : 'Reclassify', icon: 'refresh', onClick: () => void runReclassify() },
				{ label: 'Find dates…', icon: 'calendar', onClick: () => setExtractOpen(true) },
			]} />
		</header>
		{!body && !error && <div className="ml-center"><Spinner /></div>}
		{error && <EmptyState icon="warning" title="This message could not be loaded"><p>{error}</p><Button icon="refresh" onClick={() => { setError(''); setBody(null); getMessageBody(id).then((b) => { setBody(b); onFlags({ seen: true }) }).catch((e) => setError(errorText(e))) }}>Try again</Button></EmptyState>}
		{body && <div className="ml-article__content">
			<h1>{subject}</h1>
			<div className="ml-sender"><Avatar name={displayAddress(body.from[0])} size={44} /><div><strong>{displayAddress(body.from[0])}</strong>{body.from[0]?.email && <span className="ml-from" title="The address this mail really came from">{body.from[0].email}</span>}<span>to {body.to.map((a) => a.label || a.email).join(', ') || 'me'}</span></div><time>{messageDate(body.dateInt)}</time></div>
			<TriageLine t={triage} busy={classifying} />
			<SpoofBanner from={body.from[0]} />
			<ExtractDialog dbId={body.databaseId} open={extractOpen} onClose={() => setExtractOpen(false)} />
			{onMailto && <UnsubscribeBanner body={body} onMailto={onMailto} />}
			{(body.atriumCopy?.goneFromServer || message?.goneFromServer) && <p className="ml-kept ml-kept--reader"><Icon name="archive" /> Only in Atrium: no longer on the mail server.{' '}{body.atriumCopy?.text === false ? 'Its text was never copied before it left the server, so only the sender, subject and date are kept.' : body.atriumCopy?.full === false ? 'Shown from the text Atrium kept (formatting and attachments are not kept).' : 'Attachments are not kept.'}</p>}
			{!body.atriumCopy?.goneFromServer && !message?.goneFromServer && body.atriumCopy?.source === 'atrium' && body.atriumCopy.full === false && <p className="ml-kept ml-kept--reader"><Icon name="archive" /> The mail server could not be reached: shown from the text Atrium kept.</p>}
			{blocked && !showImages && <div className="ml-images"><Icon name="image" /><span>Remote images are hidden to protect your privacy.</span><Button variant="text" size="s" onClick={() => setShowImages(true)}>Show images</Button></div>}
			<MailBody html={html} plain={!body.hasHtmlBody} />
			{body.signature && <details className="ml-signature"><summary>Signature</summary><div className="ml-body ml-body--plain">{body.signature}</div></details>}
			{body.attachments.length > 0 && (body.atriumCopy?.goneFromServer || message?.goneFromServer) && <section className="ml-files"><h2>Attachments</h2><p className="ml-kept">Not kept in Atrium: {body.attachments.map((a) => a.fileName).join(', ')}</p></section>}
			{body.attachments.length > 0 && <section className="ml-files"><h2>Attachments</h2><div className="ml-attachments">{body.attachments.map((a) => <a className="ml-attachment" key={a.id} href={a.downloadUrl ?? appUrl('mail', `/api/messages/${body.databaseId}/attachment/${encodeURIComponent(a.id)}`)}><Icon name="attachment" /><span>{a.fileName}<small>{a.size ? formatBytes(a.size) : a.mimeType ?? a.mime}</small></span><Icon name="download" /></a>)}</div><a className="at-btn at-btn--text" href={appUrl('mail', `/api/messages/${body.databaseId}/attachments`)}><Icon name="download" />Download all</a></section>}
			<footer className="ml-reader__actions"><Button variant="tonal" icon="arrowBack" onClick={() => onReply(body)}>Reply</Button><Button variant="outlined" onClick={() => onReply(body, true)}>Reply all</Button>{onSuggest && !message?.flags.draft && <Button variant="text" icon="robot" busy={suggesting} onClick={() => onSuggest(body)}>Suggest a reply</Button>}<Button variant="text" icon="send" onClick={() => onForward(body)}>Forward</Button>{message?.flags.draft && <Button icon="edit" onClick={() => onEdit(body)}>Edit draft</Button>}</footer>
		</div>}
	</article>
}

function Outbox({ messages, accounts, onEdit, onReload }: { messages: LocalMessage[], accounts: Account[], onEdit: (m: LocalMessage) => void, onReload: () => void }) {
	if (!messages.length) return <EmptyState icon="send" title="No outgoing messages"><p>Scheduled and sending messages appear here.</p></EmptyState>
	return <ul className="ml-outbox">{messages.map((m) => <li key={m.id}><button onClick={() => onEdit(m)}><span><strong>{m.subject || '(no subject)'}</strong><small>To {m.to.map(formatAddress).join(', ')}</small><small>{accounts.find((a) => a.id === m.accountId)?.emailAddress}</small></span><time>{m.failed ? 'Failed' : m.sendAt ? `Scheduled ${relativeTime(m.sendAt * 1000)}` : 'Sending'}</time></button><IconButton icon="delete" label="Delete outgoing message" onClick={() => { void confirmDialog('Delete this outgoing message? It will not be sent.', { title: 'Delete message', confirm: 'Delete', danger: true }).then(async (ok) => { if (ok) { await deleteOutbox(m.id); onReload() } }).catch((e) => toast.error(errorText(e))) }} /></li>)}</ul>
}

export default defineApp({ Component: Mail })
