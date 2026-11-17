// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Messages: the phone's SMS and RCS in Wavium (ADR 0010). Routes below /apps/messages:
//   /                 conversations (?unread=1)
//   /<conversation>   a conversation
//   /link             link a phone (QR code or Google account)
//   /settings         linked phone, unlink, agents and one-time codes
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defineApp, navigate, useApp, useAppPath, useQuery } from '@atrium/sdk'
import { AppLayout, Button, Dialog, EmptyState, Icon, IconButton, NavItem, NavSection, NavToggle, SearchBar, Spinner, Switch, Tabs, TextArea, TextField, confirmDialog, cx, toast, useDebounced } from '@atrium/ui'
import {
	agentPrefs, getStatus, linkGoogle, linkQr, listConversations, listMessages, markRead, mediaUrl, openConversation, search, send, setAgentPref, unlink,
	type AgentPref, type Conversation, type Message, type Status,
} from './api'
import { groupMessages, hue, linkParts, qrPath, shortTime, smsSegments, statusLabel } from './util'
import './style.css'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const LIVE = ['connected', 'connecting', 'phone_offline', 'demo']

function Avatar({ name, size = 40 }: { name: string, size?: number }) {
	const initials = /^[+\d\s().-]+$/.test(name) ? '#' : name.trim().split(/\s+/).slice(0, 2).map((p) => [...p][0]?.toUpperCase() ?? '').join('') || '?'
	return <span className="ms-avatar" style={{ width: size, height: size, ['--h' as string]: hue(name) }} aria-hidden="true">{initials}</span>
}

function Messages() {
	const { basePath: appBase, setTitle } = useApp()
	const basePath = appBase.replace(/\/$/, '') + '/'
	const path = useAppPath()
	const query = useQuery()
	const seg = path.split('/').filter(Boolean)
	const page = seg[0] === 'link' ? 'link' : seg[0] === 'settings' ? 'settings' : 'list'
	const openId = page === 'list' && seg[0] ? decodeURIComponent(seg[0]) : null
	const unreadOnly = query.get('unread') === '1'

	const [status, setStatus] = useState<Status | null>(null)
	const [convs, setConvs] = useState<Conversation[] | null>(null)
	const [filter, setFilter] = useState('')
	const q = useDebounced(filter.trim(), 200)
	const [hits, setHits] = useState<Array<Message & { conversation_name: string }> | null>(null)
	const [newOpen, setNewOpen] = useState(false)
	const live = status !== null && LIVE.includes(status.state)

	const loadStatus = useCallback(async () => {
		try { setStatus(await getStatus()) } catch (e) { toast.error(`Messages: ${errText(e)}`) }
	}, [])
	const loadConvs = useCallback(async () => {
		try { setConvs(await listConversations('', false)) } catch { setConvs((c) => c ?? []) }
	}, [])

	useEffect(() => { void loadStatus() }, [loadStatus])
	useEffect(() => { if (live) void loadConvs() }, [live, loadConvs])
	// New texts arrive through the server; the page asks every few seconds while visible.
	useEffect(() => {
		const pairing = status?.state === 'pairing'
		const t = setInterval(() => {
			if (document.hidden) return
			void loadStatus()
			if (live) void loadConvs()
		}, pairing ? 2000 : 6000)
		return () => clearInterval(t)
	}, [status?.state, live, loadStatus, loadConvs])
	useEffect(() => {
		if (q.length < 2) { setHits(null); return }
		let gone = false
		search(q).then((r) => { if (!gone) setHits(r) }, () => {})
		return () => { gone = true }
	}, [q])

	const unread = (convs ?? []).filter((c) => c.unread).length
	useEffect(() => { setTitle(unread ? `(${unread}) Messages` : 'Messages') }, [unread, setTitle])

	const visible = useMemo(() => {
		let list = convs ?? []
		if (unreadOnly) list = list.filter((c) => c.unread)
		if (q) {
			const l = q.toLowerCase()
			list = list.filter((c) => c.name.toLowerCase().includes(l) || c.participants.some((p) => p.number.includes(q)) || (c.last_text ?? '').toLowerCase().includes(l))
		}
		return list
	}, [convs, unreadOnly, q])

	const go = (to: string) => navigate(basePath + to)

	const nav = (
		<>
			<div className="ms-nav-new"><Button icon="add" block disabled={!live} onClick={() => setNewOpen(true)}>New conversation</Button></div>
			<NavSection>
				<NavItem icon="message" label="All conversations" active={page === 'list' && !unreadOnly} href={basePath} onClick={() => go('')} />
				<NavItem icon="message-circle" label="Unread" count={unread} active={page === 'list' && unreadOnly} href={`${basePath}?unread=1`} onClick={() => go('?unread=1')} />
			</NavSection>
			<NavSection>
				<NavItem icon="device-mobile" label={live ? 'Phone & agents' : 'Link my phone'} active={page === 'settings' || page === 'link'} href={`${basePath}${live ? 'settings' : 'link'}`} onClick={() => go(live ? 'settings' : 'link')} />
			</NavSection>
		</>
	)

	let main
	if (status === null) main = <div className="ms-center"><Spinner /></div>
	else if (!status.available) main = <NotSetUp />
	else if (page === 'settings') main = <SettingsPage status={status} onChange={loadStatus} />
	else if (!live || page === 'link') main = <LinkPhone status={status} onChange={loadStatus} />
	else {
		main = (
			<div className={cx('ms', openId && 'ms--open')}>
				<section className="ms-list" aria-label="Conversations">
					<header className="ms-head">
						<NavToggle />
						<h1 className="ms-title">{unreadOnly ? 'Unread' : 'Messages'}</h1>
						<IconButton icon="add" label="New conversation" onClick={() => setNewOpen(true)} />
					</header>
					<Banner status={status} />
					<div className="ms-search"><SearchBar value={filter} onChange={setFilter} placeholder="Search texts and people" /></div>
					{convs === null ? <div className="ms-center"><Spinner /></div>
						: visible.length === 0 && !hits?.length ? (
							<EmptyState icon={q ? 'search' : 'message'} title={q ? 'Nothing matches' : unreadOnly ? 'All caught up' : 'No conversations yet'}>
								{!q && !unreadOnly && <p className="ms-muted">Texts from your phone show up here as they arrive.</p>}
							</EmptyState>
						) : (
							<>
								<ul className="ms-convs at-list" role="list">
									{visible.map((c) => (
										<li key={c.id}>
											<a className={cx('ms-conv', c.unread && 'ms-conv--unread', c.id === openId && 'ms-conv--active')} href={basePath + encodeURIComponent(c.id)}
												onClick={(e) => { e.preventDefault(); go(encodeURIComponent(c.id)) }}>
												<Avatar name={c.name} />
												<span className="ms-conv__body">
													<span className="ms-conv__top"><span className="ms-conv__name">{c.name}</span><time className="ms-conv__time">{c.last_at ? shortTime(c.last_at) : ''}</time></span>
													<span className="ms-conv__last">{c.last_from_me && <span className="ms-muted">You: </span>}{c.last_text ?? ''}</span>
												</span>
												{c.unread && <span className="ms-dot" aria-label="unread" />}
											</a>
										</li>
									))}
								</ul>
								{hits && hits.length > 0 && (
									<>
										<h2 className="ms-sub">In messages</h2>
										<ul className="ms-hits at-list" role="list">
											{hits.slice(0, 20).map((m) => (
												<li key={m.id}><a className="ms-hit" href={basePath + encodeURIComponent(m.conversation_id)} onClick={(e) => { e.preventDefault(); go(encodeURIComponent(m.conversation_id)) }}>
													<strong>{m.conversation_name || m.sender_name || m.sender_number}</strong>
													<span>{m.one_time_code ? 'One-time code' : m.text}</span>
													<time>{shortTime(m.at)}</time>
												</a></li>
											))}
										</ul>
									</>
								)}
							</>
						)}
				</section>
				<section className="ms-thread-pane" aria-label="Conversation">
					{openId ? <Thread key={openId} id={openId} demo={status.state === 'demo'} onBack={() => go(unreadOnly ? '?unread=1' : '')} onChanged={loadConvs} />
						: <div className="ms-center ms-pick"><Icon name="messages" /><p>Pick a conversation</p></div>}
				</section>
			</div>
		)
	}

	return (
		<AppLayout nav={nav}>
			{main}
			<NewConversation open={newOpen} onClose={() => setNewOpen(false)} onOpened={(c) => { setNewOpen(false); void loadConvs(); go(encodeURIComponent(c.id)) }} />
		</AppLayout>
	)
}

function Banner({ status }: { status: Status }) {
	if (status.state === 'demo') return <p className="ms-banner ms-banner--demo"><Icon name="info" /> Demo: these texts are made up and nothing is really sent.</p>
	if (status.state === 'phone_offline') {
		const since = status.offline_since ? new Date(status.offline_since).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : ''
		return <p className="ms-banner ms-banner--warn" role="status"><Icon name="device-mobile-off" /> Phone offline{since ? ` since ${since}` : ''}. Texts arrive when it is back online.</p>
	}
	if (status.state === 'connecting') return <p className="ms-banner" role="status"><Spinner small /> Connecting to your phone…</p>
	return null
}

function NotSetUp() {
	return (
		<div className="ms-center ms-setup">
			<EmptyState icon="message" title="Messages is not set up on this server">
				<p className="ms-muted">Whoever runs this Wavium can turn it on: start the <code>gmessages</code> service (profile <code>messages</code>) and set <code>ATRIUM_GMESSAGES_SECRET</code>. See the install guide.</p>
			</EmptyState>
		</div>
	)
}

// --- linking ------------------------------------------------------------------

function Qr({ data }: { data: string }) {
	const { size, d } = useMemo(() => qrPath(data), [data])
	return (
		<div className="ms-qr" role="img" aria-label="QR code to scan with Google Messages">
			<svg viewBox={`-2 -2 ${size + 4} ${size + 4}`} shapeRendering="crispEdges"><rect x="-2" y="-2" width={size + 4} height={size + 4} fill="#fff" /><path d={d} fill="#000" /></svg>
			<span className="ms-qr__scan" aria-hidden="true" />
		</div>
	)
}

function LinkPhone({ status, onChange }: { status: Status, onChange: () => void }) {
	const [tab, setTab] = useState<'qr' | 'google'>('qr')
	const [busy, setBusy] = useState(false)
	const [cookies, setCookies] = useState('')
	const pairing = status.state === 'pairing'
	const done = LIVE.includes(status.state)

	const start = async () => {
		setBusy(true)
		try {
			if (tab === 'qr') await linkQr()
			else await linkGoogle(cookies)
			setCookies('')
			// Stay on /link: when the phone answers, the page says so.
			if (!location.pathname.endsWith('/link')) navigate('/apps/messages/link', { replace: true })
			onChange()
		} catch (e) {
			toast.error(errText(e))
		} finally {
			setBusy(false)
		}
	}

	if (done) {
		return (
			<div className="ms-link ms-center">
				<div className="ms-linked"><Icon name="circle-check" /></div>
				<h1>Your phone is linked</h1>
				<p className="ms-muted">{status.phone ?? 'Your phone'} sends its texts to Wavium now.</p>
				<Button onClick={() => navigate('/apps/messages/')}>Open my texts</Button>
			</div>
		)
	}

	return (
		<div className="ms-link">
			<header className="ms-head"><NavToggle /><h1 className="ms-title">Link my phone</h1></header>
			<div className="ms-link__body at-stagger">
				<p className="ms-lead">Read and answer your phone's SMS and RCS here. Wavium links to <strong>Google Messages</strong> on your Android phone, like messages.google.com does.</p>
				<Tabs value={tab} onChange={(t) => setTab(t)} tabs={[{ id: 'qr' as const, label: 'QR code' }, { id: 'google' as const, label: 'Google account' }]} />
				{tab === 'qr' ? (
					<div className="ms-steps">
						<ol>
							<li>On your phone, open <strong>Google Messages</strong>.</li>
							<li>Tap your profile picture, then <strong>Device pairing</strong> › <strong>QR code scanner</strong>.</li>
							<li>Point the phone at the code below.</li>
						</ol>
						{pairing && status.qr ? <><Qr data={status.qr} /><p className="ms-muted ms-small">The code renews itself every 30 seconds. Waiting for your phone…</p></>
							: <Button icon="qrcode" busy={busy} onClick={start}>Show the QR code</Button>}
					</div>
				) : (
					<div className="ms-steps">
						{pairing && status.emoji ? (
							<div className="ms-emoji-step">
								<span className="ms-emoji" aria-label={`Emoji ${status.emoji}`}>{status.emoji}</span>
								<p>On your phone, Google Messages shows a few emoji: <strong>tap this one</strong>.</p>
							</div>
						) : (
							<>
								<p>Pair with the Google account your phone uses for Google Messages. Wavium needs that account's cookies from <strong>messages.google.com</strong> (open it while logged in, then your browser's developer tools › Storage › Cookies, and copy them).</p>
								<TextArea label="Cookies (SID, HSID, SSID, APISID, SAPISID…)" value={cookies} onChange={(e) => setCookies(e.target.value)} rows={4} spellCheck={false} autoComplete="off" />
								<p className="ms-muted ms-small"><Icon name="lock" /> They are used once to pair, sealed with this server's key, and never shown again.</p>
								<Button icon="brand-google" busy={busy} disabled={cookies.trim().length < 20} onClick={start}>Pair with my Google account</Button>
							</>
						)}
					</div>
				)}
				{status.error && <p className="ms-error" role="alert">{status.error}</p>}
				<details className="ms-limits">
					<summary>Good to know</summary>
					<ul>
						<li>Your phone must stay on and online: texts go through it.</li>
						<li>The link is not an official Google API. A Google update can break it for a while, until Wavium is updated.</li>
						<li>On some phones only one web session works at a time: linking Wavium may log out messages.google.com in another browser.</li>
						<li>Wavium keeps a copy of every text, even those you delete on the phone.</li>
						<li>Agents never see one-time codes unless you allow it, and every text they write waits for your OK.</li>
					</ul>
				</details>
			</div>
		</div>
	)
}

// --- settings ----------------------------------------------------------------

function SettingsPage({ status, onChange }: { status: Status, onChange: () => void }) {
	const [agents, setAgents] = useState<AgentPref[] | null>(null)
	useEffect(() => { agentPrefs().then(setAgents, () => setAgents([])) }, [])
	const off = async () => {
		if (!(await confirmDialog('New texts stop arriving. The texts already in Wavium stay here.', { title: 'Unlink your phone?', confirm: 'Unlink', danger: true }))) return
		try { await unlink(); toast('Phone unlinked'); onChange(); navigate('/apps/messages/link') } catch (e) { toast.error(errText(e)) }
	}
	return (
		<div className="ms-settings">
			<header className="ms-head"><NavToggle /><h1 className="ms-title">Phone &amp; agents</h1></header>
			<div className="ms-settings__body at-stagger">
				<section className="ms-card">
					<h2><Icon name="device-mobile" /> Linked phone</h2>
					<p><strong>{status.phone ?? '—'}</strong>{status.linked_at && <span className="ms-muted"> · linked {new Date(status.linked_at).toLocaleDateString()}</span>}</p>
					<p className="ms-muted">{status.counts.conversations} conversations, {status.counts.messages} texts kept in Wavium.</p>
					<Banner status={status} />
					{status.state !== 'demo' && <Button variant="tonal" icon="unlink" onClick={off}>Unlink this phone</Button>}
				</section>
				<section className="ms-card">
					<h2><Icon name="robot" /> Agents and one-time codes</h2>
					<p className="ms-muted">Codes sent by banks and sites to log in are hidden from agents: one that reads them could get into your accounts. Turn this on only for an agent you trust with that.</p>
					{agents === null ? <Spinner /> : agents.length === 0 ? <p className="ms-muted">No agents yet (Settings › Agents).</p> : (
						<ul className="ms-agents">
							{agents.map((a) => (
								<li key={a.uid}>
									<span>{a.name}</span>
									<Switch checked={a.show_codes} aria-label={`${a.name} may see one-time codes`} onChange={async (e) => {
										const v = e.target.checked
										try { await setAgentPref(a.uid, v); setAgents((l) => l!.map((x) => (x.uid === a.uid ? { ...x, show_codes: v } : x))) } catch (err) { toast.error(errText(err)) }
									}} />
								</li>
							))}
						</ul>
					)}
				</section>
			</div>
		</div>
	)
}

// --- a conversation -------------------------------------------------------------

function Thread({ id, demo, onBack, onChanged }: { id: string, demo: boolean, onBack: () => void, onChanged: () => void }) {
	const [conv, setConv] = useState<Conversation | null>(null)
	const [msgs, setMsgs] = useState<Message[] | null>(null)
	const [text, setText] = useState('')
	const [sending, setSending] = useState(false)
	const seen = useRef(new Set<string>())
	const end = useRef<HTMLDivElement>(null)
	const box = useRef<HTMLTextAreaElement>(null)

	const load = useCallback(async () => {
		try {
			const r = await listMessages(id)
			setConv(r.conversation)
			setMsgs(r.messages)
		} catch (e) {
			toast.error(errText(e))
			setMsgs((m) => m ?? [])
		}
	}, [id])
	useEffect(() => { void load(); void markRead(id).then(onChanged, () => {}) }, [id, load, onChanged])
	useEffect(() => {
		const t = setInterval(() => { if (!document.hidden) void load() }, 4000)
		return () => clearInterval(t)
	}, [load])
	const count = msgs?.length ?? 0
	useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: seen.current.size ? 'smooth' : 'auto' }) }, [count])
	// Only bubbles that arrive while the page is open animate in.
	const fresh = (m: Message) => {
		const isNew = seen.current.size > 0 && !seen.current.has(m.id)
		return isNew
	}
	useEffect(() => {
		// A text that arrives while the conversation is open is read.
		const last = msgs?.[msgs.length - 1]
		if (last && !last.from_me && seen.current.size > 0 && !seen.current.has(last.id)) void markRead(id).then(onChanged, () => {})
		for (const m of msgs ?? []) seen.current.add(m.id)
	}, [msgs, id, onChanged])

	const submit = async () => {
		const t = text.trim()
		if (!t || sending) return
		setSending(true)
		try {
			await send(id, t)
			setText('')
			await load()
			onChanged()
			box.current?.focus()
		} catch (e) {
			toast.error(`Not sent: ${errText(e)}`)
		} finally {
			setSending(false)
		}
	}

	const groups = useMemo(() => groupMessages(msgs ?? []), [msgs])
	const seg = smsSegments(text)
	const others = conv?.participants.filter((p) => !p.is_me) ?? []

	return (
		<div className="ms-thread">
			<header className="ms-thread__head">
				<IconButton className="ms-back" icon="arrowBack" label="Back" onClick={onBack} />
				{conv && <Avatar name={conv.name} size={36} />}
				<div className="ms-thread__who">
					<strong>{conv?.name ?? '…'}</strong>
					<span className="ms-muted">{others.map((p) => p.number).filter(Boolean).join(', ')}{conv && <span className={cx('ms-kind', conv.kind === 'rcs' && 'ms-kind--rcs')}>{conv.kind.toUpperCase()}</span>}</span>
				</div>
			</header>
			<div className="ms-bubbles" aria-live="polite">
				{msgs === null ? <div className="ms-center"><Spinner /></div> : groups.map((g) => (
					<div key={g.day} className="ms-day">
						<div className="ms-day__label"><span>{g.label}</span></div>
						{g.bubbles.map(({ m, first, last }) => (
							<div key={m.id} className={cx('ms-bubble', m.from_me ? 'ms-bubble--me' : 'ms-bubble--them', first && 'ms-bubble--first', last && 'ms-bubble--last', fresh(m) && 'ms-bubble--new', m.status === 'failed' && 'ms-bubble--failed', m.status === 'sending' && 'ms-bubble--sending')}>
								{!m.from_me && conv?.is_group && first && <span className="ms-bubble__who">{m.sender_name || m.sender_number}</span>}
								{m.media.map((x) => x.mime.startsWith('image/')
									? <a key={x.index} href={mediaUrl(m.id, x.index)} target="_blank" rel="noopener"><img className="ms-bubble__img" src={mediaUrl(m.id, x.index)} alt={x.name || 'Picture'} loading="lazy" /></a>
									: <a key={x.index} className="ms-bubble__file" href={mediaUrl(m.id, x.index)} download={x.name || 'file'}><Icon name="paperclip" /> {x.name || x.mime}</a>)}
								{m.text && <p className="ms-bubble__text">{linkParts(m.text).map((p, i) => p.href ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">{p.text}</a> : <span key={i}>{p.text}</span>)}</p>}
								{m.one_time_code && <span className="ms-code-tag" title="Hidden from your agents"><Icon name="lock" /> code</span>}
								{last && <span className="ms-bubble__meta">{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{m.from_me && statusLabel(m.status) && <> · {statusLabel(m.status)}</>}</span>}
							</div>
						))}
					</div>
				))}
				<div ref={end} />
			</div>
			{conv?.read_only ? <p className="ms-readonly">This sender does not take answers.</p> : (
				<form className="ms-compose" onSubmit={(e) => { e.preventDefault(); void submit() }}>
					<textarea ref={box} className="ms-compose__box" rows={1} value={text} placeholder={demo ? 'Text (demo: nothing is really sent)' : conv?.kind === 'rcs' ? 'RCS message' : 'Text message'} aria-label="Message"
						maxLength={2000} onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() } }} />
					{conv?.kind !== 'rcs' && text.length > 100 && <span className="ms-compose__count" aria-live="polite">{seg.left}/{seg.segments}</span>}
					<IconButton className={cx('ms-send', text.trim() && 'ms-send--ready')} icon="send" label="Send" type="submit" disabled={!text.trim() || sending} />
				</form>
			)}
		</div>
	)
}

function NewConversation({ open, onClose, onOpened }: { open: boolean, onClose: () => void, onOpened: (c: Conversation) => void }) {
	const [number, setNumber] = useState('')
	const [busy, setBusy] = useState(false)
	const ok = /^\+?[0-9 ().-]{3,24}$/.test(number.trim())
	const go = async () => {
		setBusy(true)
		try { onOpened(await openConversation(number.trim())); setNumber('') } catch (e) { toast.error(errText(e)) } finally { setBusy(false) }
	}
	return (
		<Dialog open={open} onClose={onClose} title="New conversation" actions={<><Button variant="text" onClick={onClose}>Cancel</Button><Button busy={busy} disabled={!ok} onClick={go}>Open</Button></>}>
			<TextField label="Phone number" type="tel" inputMode="tel" autoComplete="tel" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+33 6 12 34 56 78"
				onKeyDown={(e) => { if (e.key === 'Enter' && ok) void go() }} />
		</Dialog>
	)
}

export default defineApp({ Component: Messages })
