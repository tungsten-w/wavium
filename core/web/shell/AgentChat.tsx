// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The thread with one of your own agents, inside the assistant panel (V4-39):
// you write, it reads on its own machine and answers. No AI provider of yours
// is involved and nothing streams, so the panel polls and says plainly where
// your message is. Logic and API in chatModel.ts.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Spinner, TextArea } from '@atrium/ui'
import { type ChatMessage, chatApi, lastId, merge, POLL_MS, type TalkableAgent, waitingLine } from './chatModel'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function AgentChat({ agent }: { agent: TalkableAgent }) {
	const [msgs, setMsgs] = useState<ChatMessage[] | null>(null)
	const [paused, setPaused] = useState(agent.paused)
	const [draft, setDraft] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const end = useRef<HTMLDivElement | null>(null)
	const have = useRef<ChatMessage[]>([])
	useEffect(() => { have.current = msgs ?? [] }, [msgs])
	useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }) }, [msgs])

	const refresh = useCallback(async (reset: boolean) => {
		try {
			const r = await chatApi.thread(agent.uid, reset ? 0 : lastId(have.current))
			setPaused(r.agent.paused)
			setMsgs((old) => (reset ? r.messages : merge(old ?? [], r.messages)))
			setError(null)
		} catch (e) {
			setError(errText(e))
		}
	}, [agent.uid])

	// Re-read on a timer: an agent running outside Wavium has no way to push.
	useEffect(() => {
		setMsgs(null)
		void refresh(true)
		const t = setInterval(() => void refresh(false), POLL_MS)
		return () => clearInterval(t)
	}, [refresh])

	const send = async () => {
		const text = draft.trim()
		if (!text || busy) return
		setBusy(true)
		try {
			const r = await chatApi.send(agent.uid, text)
			setMsgs((old) => merge(old ?? [], [r.message]))
			setDraft('')
			setError(null)
		} catch (e) {
			setError(errText(e))
		} finally {
			setBusy(false)
		}
	}

	const waiting = msgs ? waitingLine(msgs, { name: agent.name, paused }) : null

	return (
		<>
			<div className="assistant__log">
				{!msgs ? <div className="settings-center"><Spinner /></div>
					: msgs.length === 0
						? <p className="at-muted">
							Write to {agent.name} like you would to a colleague: a task, a question, something to check.
							It reads its messages when it next checks in, does the work on its own, and answers here.
						</p>
						: msgs.map((m) => (
							<div key={m.id} className={`assistant__msg assistant__msg--${m.from === 'you' ? 'user' : 'ai'}`}>
								{m.from === 'agent' ? <div className="assistant__text">{m.text}</div> : m.text}
							</div>
						))}
				{waiting && <p className="assistant__waiting at-muted">{waiting}</p>}
				{error && <div className="assistant__error" role="alert">{error}</div>}
				<div ref={end} />
			</div>
			<form className="assistant__form" onSubmit={(e) => { e.preventDefault(); void send() }}>
				<TextArea label={`Message to ${agent.name}`} value={draft} rows={2} onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }} />
				<Button type="submit" icon="send" busy={busy} disabled={busy || !draft.trim()}>Send</Button>
			</form>
		</>
	)
}
