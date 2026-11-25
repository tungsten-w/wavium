// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The assistant panel (P5-6): a chat on the side of every page, answered by
// the user's AI provider with Atrium's tools, as their "Assistant" agent (its
// permissions are in Settings > Agents). Answers stream in; each tool call
// shows as a line; a sending, deleting or sharing step waits here for
// Approve / Reject. Logic in assistantModel.ts; server: server/agent/assistant.
import { useEffect, useRef, useState } from 'react'
import { linkHandler, requestToken } from '@atrium/sdk'
import { Button, IconButton, Select, TextArea } from '@atrium/ui'
import { AgentChat } from './AgentChat'
import { chatApi, readWho, saveWho, type TalkableAgent } from './chatModel'
import { applyEvent, parseSse, type Step, toMessages, toolLabel, type Turn } from './assistantModel'
import { api } from './settings/agentsApi'

type AssistantTurn = Extract<Turn, { role: 'assistant' }>
const blank = (): AssistantTurn => ({ role: 'assistant', text: '', steps: [], done: false, error: null, note: null })

export function Assistant({ onClose, startWith }: { onClose: () => void, startWith?: string }) {
	// Who the panel is talking to: the built-in assistant, or one of the user's
	// own agents (V4-39). Agents it cannot find are ignored, so an instance
	// with none at all looks exactly as it did before.
	const [agents, setAgents] = useState<TalkableAgent[]>([])
	const [who, setWho] = useState<string>(() => startWith ?? readWho())
	useEffect(() => {
		let gone = false
		void chatApi.agents().then((r) => { if (!gone) setAgents(r.agents) }).catch(() => { /* none to talk to */ })
		return () => { gone = true }
	}, [])
	useEffect(() => { if (startWith) setWho(startWith) }, [startWith])
	const pick = (next: string) => { setWho(next); saveWho(next) }
	const agent = agents.find((a) => a.uid === who) ?? null
	const [turns, setTurns] = useState<Turn[]>([])
	const [draft, setDraft] = useState('')
	const [busy, setBusy] = useState(false)
	const abort = useRef<AbortController | null>(null)
	const end = useRef<HTMLDivElement | null>(null)
	useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }) }, [turns])
	useEffect(() => () => abort.current?.abort(), [])

	const update = (fn: (t: AssistantTurn) => AssistantTurn) => setTurns((list) => {
		const last = list[list.length - 1]
		return last?.role === 'assistant' ? [...list.slice(0, -1), fn(last)] : list
	})

	const send = async () => {
		const text = draft.trim()
		if (!text || busy) return
		const next: Turn[] = [...turns, { role: 'user', text }]
		setTurns([...next, blank()])
		setDraft('')
		setBusy(true)
		const ctl = new AbortController()
		abort.current = ctl
		try {
			const res = await fetch('/agent/v1/assistant/chat', {
				method: 'POST', signal: ctl.signal, credentials: 'same-origin',
				headers: { 'OCS-APIRequest': 'true', 'Content-Type': 'application/json', Accept: 'text/event-stream', requesttoken: await requestToken() },
				body: JSON.stringify({ messages: toMessages(next) }),
			})
			if (!res.ok || !res.body) {
				const body = await res.json().catch(() => null) as { error?: { message?: string } } | null
				throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
			}
			const reader = res.body!.getReader()
			const dec = new TextDecoder()
			let buf = ''
			for (;;) {
				const { value, done } = await reader.read()
				if (done) break
				const { events, rest } = parseSse(buf + dec.decode(value, { stream: true }))
				buf = rest
				for (const ev of events) update((t) => applyEvent(t, ev))
			}
			update((t) => (t.done ? t : { ...t, done: true }))
		} catch (e) {
			if (ctl.signal.aborted) update((t) => ({ ...t, done: true, note: 'Stopped.' }))
			else update((t) => ({ ...t, done: true, error: e instanceof Error ? e.message : String(e) }))
		} finally {
			setBusy(false)
			abort.current = null
		}
	}

	const decide = async (step: Extract<Step, { kind: 'approval' }>, d: 'approve' | 'reject') => {
		const set = (decision: typeof step.decision) => setTurns((list) => list.map((t) => (t.role === 'assistant'
			? { ...t, steps: t.steps.map((s) => (s.kind === 'approval' && s.request_id === step.request_id ? { ...s, decision } : s)) }
			: t)))
		try {
			const r = await api.decide(step.request_id, d)
			set(r.status === 'executed' ? 'approved' : r.status === 'rejected' ? 'rejected' : 'failed')
		} catch {
			set('failed')
		}
	}

	return (
		<aside className="assistant" aria-label="Assistant">
			<div className="assistant__head">
				{agents.length === 0
					? <strong>Assistant</strong>
					: <Select className="assistant__who" label="Talking to" value={agent ? agent.uid : 'assistant'} onChange={(e) => pick(e.target.value)}>
						<option value="assistant">Assistant</option>
						{agents.map((a) => <option key={a.uid} value={a.uid}>{a.name}{a.waiting > 0 ? ` (${a.waiting} waiting)` : ''}</option>)}
					</Select>}
				<span style={{ flex: 1 }} />
				{!agent && turns.length > 0 && !busy && <Button variant="text" size="s" onClick={() => setTurns([])}>New chat</Button>}
				<IconButton icon="close" label="Close the assistant" onClick={onClose} />
			</div>
			{agent && <AgentChat agent={agent} />}
			{!agent && <>
			<div className="assistant__log">
				{turns.length === 0 && <p className="at-muted">Ask about your mail, files, calendar, tasks, contacts or notes, or ask it to do something. It acts as your "Assistant" agent: sending, deleting and sharing wait for your OK here.</p>}
				{turns.map((t, i) => t.role === 'user'
					? <div key={i} className="assistant__msg assistant__msg--user">{t.text}</div>
					: <div key={i} className="assistant__msg assistant__msg--ai">
						{t.steps.map((s) => s.kind === 'tool'
							? <div key={s.id} className="assistant__step at-muted">{s.ok === null ? '…' : s.ok ? '✓' : '✗'} {toolLabel(s.name)}</div>
							: <div key={s.id} className="assistant__approval" data-request={s.request_id}>
								<div>{s.summary}</div>
								{s.decision === 'pending'
									? <div className="assistant__approval-actions">
										<Button size="s" variant="text" onClick={() => void decide(s, 'reject')}>Reject</Button>
										<Button size="s" onClick={() => void decide(s, 'approve')}>Approve</Button>
									</div>
									: <div className="at-muted">{s.decision === 'approved' ? 'Approved and done' : s.decision === 'rejected' ? 'Rejected' : 'Could not be done'}</div>}
							</div>)}
						{t.text && <div className="assistant__text">{t.text}</div>}
						{!t.done && !t.text && t.steps.length === 0 && <div className="at-muted">Thinking…</div>}
						{t.note && <div className="at-muted">{t.note}</div>}
						{t.error && <div className="assistant__error" role="alert">{t.error}{/AI providers/.test(t.error) && <> <a href="/settings/user/ai" onClick={linkHandler}>Open AI providers</a></>}</div>}
					</div>)}
				<div ref={end} />
			</div>
			<form className="assistant__form" onSubmit={(e) => { e.preventDefault(); void send() }}>
				<TextArea label="Message" value={draft} rows={2} onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }} />
				{busy ? <Button type="button" variant="tonal" onClick={() => abort.current?.abort()}>Stop</Button>
					: <Button type="submit" icon="send" disabled={!draft.trim()}>Send</Button>}
			</form>
			</>}
		</aside>
	)
}
