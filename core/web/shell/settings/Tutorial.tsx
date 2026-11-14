// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Tutorial (v2.1): a short illustrated tour of Wavium. The images are
// real screenshots of the demo instance (core/img/tutorial, regenerated with
// Playwright when the UI changes).
import { useEffect, useState } from 'react'
import { linkHandler, type Session } from '@atrium/sdk'
import { Button, Icon, WaviumMark } from '@atrium/ui'

export interface TourStep { id: string, title: string, image: string, points: string[], link: { label: string, href: string } }

export const TOUR: TourStep[] = [
	{
		id: 'today', title: 'Your day at a glance', image: '01-today',
		points: ['The Today card on the Dashboard lists the mail that waits for a reply or an action, today\'s events and your list for the day.', 'With an AI set up, one sentence tells you what matters first. Turn on the morning digest with the gear icon.'],
		link: { label: 'Open the Dashboard', href: '/apps/dashboard/' },
	},
	{
		id: 'mail', title: 'Mail that sorts itself', image: '02-mail',
		points: ['Every new mail is classified: personal, work, bills, orders, newsletters, ads, spam... and whether it needs a reply or an action.', '"Curated" hides the noise; suspicious mail is flagged in red. Wavium keeps its own copy of every mail.'],
		link: { label: 'Open Mail', href: '/apps/mail/' },
	},
	{
		id: 'reply', title: 'Replies written for you', image: '03-reply',
		points: ['Open a mail and press "Suggest a reply": your AI drafts it in the composer.', 'You read, change and send it yourself: nothing ever leaves without your click.'],
		link: { label: 'Try it in Mail', href: '/apps/mail/' },
	},
	{
		id: 'rules', title: 'Filing rules in your own words', image: '04-rules',
		points: ['Write what you want ("invoices from my energy company go to Archive"), and the AI turns it into a rule.', 'You see which mails it would move before you save it; then it runs on every new mail, without AI.'],
		link: { label: 'Open Rules', href: '/apps/mail/rules' },
	},
	{
		id: 'calendar', title: 'Calendar and tasks', image: '05-calendar',
		points: ['Invite people and answer invitations, subscribe to other calendars, publish a booking page.', 'Tasks can repeat, be ordered by hand and shared. "Find dates…" in a mail turns an appointment into an event.'],
		link: { label: 'Open Calendar', href: '/apps/calendar/' },
	},
	{
		id: 'agents', title: 'Your own AI agents', image: '06-agents',
		points: ['Connect Claude, ChatGPT, Codex or any MCP client to your data, one agent at a time.', 'For each app you choose what an agent may read, change, send or delete, and what waits for your OK.'],
		link: { label: 'Open Agents', href: '/settings/user/agents' },
	},
	{
		id: 'ai', title: 'Choose your AI', image: '07-ai',
		points: ['Wavium works with Anthropic, OpenAI, Mistral, any OpenAI-compatible service or a local Ollama.', 'Keys are stored encrypted; a budget keeps the costs in check, and a small model does the sorting.'],
		link: { label: 'Open AI providers', href: '/settings/user/ai' },
	},
	{
		id: 'assistant', title: 'The assistant', image: '08-assistant',
		points: ['The robot button at the top right opens a chat that uses your mail, calendar, tasks, notes and files.', 'It follows the same rules as your agents: changes that need your OK wait for it in the panel.'],
		link: { label: 'Back to the Dashboard', href: '/apps/dashboard/' },
	},
	{
		id: 'google', title: 'Move from Google', image: '09-google',
		points: ['Bring Gmail, Google Calendar, Contacts and Drive into Wavium in about 15 minutes, step by step.', 'Nothing is deleted at Google: take your time, and keep following your Google calendar if you like.'],
		link: { label: 'Open Move from Google', href: '/settings/user/move-from-google' },
	},
]

const KEY = 'wavium.tour'
const readStep = () => { try { return Math.max(0, Math.min(TOUR.length - 1, Number(localStorage.getItem(KEY) ?? 0) || 0)) } catch { return 0 } }

export function Tutorial(_: { session: Session }) {
	const [i, setI] = useState(readStep)
	useEffect(() => { try { localStorage.setItem(KEY, String(i)) } catch { /* private mode */ } }, [i])
	const s = TOUR[i]
	return (
		<div className="tour">
			<header className="tour__head">
				<WaviumMark size={22} />
				<div><h2 className="at-headline">Welcome to Wavium</h2><p className="at-muted">A two-minute tour of what Wavium does for you.</p></div>
			</header>
			<div className="tour__body">
				<ol className="tour__list" aria-label="Steps">
					{TOUR.map((t, n) => (
						<li key={t.id}><button type="button" className={n === i ? 'is-on' : n < i ? 'is-done' : ''} aria-current={n === i ? 'step' : undefined} onClick={() => setI(n)}>
							<span className="tour__n">{n < i ? <Icon name="check" /> : n + 1}</span>{t.title}
						</button></li>
					))}
				</ol>
				<article className="tour__step" aria-label={s.title}>
					<div className="tour__frame">
						<div className="tour__window">
							<div className="tour__bar"><i /><i /><i /></div>
							<img src={`/core/img/tutorial/${s.image}.jpg`} alt={s.title} loading="lazy" />
						</div>
					</div>
					<p className="tour__count">Step {i + 1} of {TOUR.length}</p>
					<h3>{s.title}</h3>
					<ul>{s.points.map((p) => <li key={p}>{p}</li>)}</ul>
					<div className="tour__actions">
						<a className="at-btn at-btn--tonal" href={s.link.href} onClick={linkHandler}>{s.link.label}</a>
						<span className="tour__spacer" />
						<Button variant="text" disabled={i === 0} onClick={() => setI(i - 1)}>Previous</Button>
						{i < TOUR.length - 1 ? <Button onClick={() => setI(i + 1)}>Next</Button> : <Button onClick={() => setI(0)}>Start again</Button>}
					</div>
				</article>
			</div>
		</div>
	)
}
