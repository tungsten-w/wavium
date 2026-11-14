// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Is Wavium safe to install?" (v4): Wavium next to tools people use instead,
// on the questions that decide where your data is safe. Honest on purpose:
// Wavium loses where it is young. Checked 2026-11; the README has the same table.

export type Mark = 'yes' | 'partly' | 'no'

export interface Tool { id: string, name: string, kind: string }
export interface Criterion { id: string, question: string, why: string, marks: Record<string, [Mark, string]> }

export const TOOLS: Tool[] = [
	{ id: 'wavium', name: 'Wavium', kind: 'self-hosted' },
	{ id: 'nextcloud', name: 'Nextcloud', kind: 'self-hosted' },
	{ id: 'proton', name: 'Proton', kind: 'hosted, encrypted' },
	{ id: 'google', name: 'Google', kind: 'Gmail, Drive' },
	{ id: 'microsoft', name: 'Microsoft 365', kind: 'Outlook, OneDrive' },
]

export const CRITERIA: Criterion[] = [
	{
		id: 'place', question: 'Your data stays on a machine you choose', why: 'If it is on your machine, nobody else holds a copy to lose, sell or hand over.',
		marks: {
			wavium: ['yes', 'Your server or PC'], nextcloud: ['yes', 'Your server'], proton: ['no', 'Proton’s servers (Switzerland)'],
			google: ['no', 'Google’s servers'], microsoft: ['no', 'Microsoft’s servers'],
		},
	},
	{
		id: 'read', question: 'Nobody else can read it', why: 'Who can open your mail and files besides you.',
		marks: {
			wavium: ['yes', 'Only whoever runs the server (you)'], nextcloud: ['yes', 'Only whoever runs the server'],
			proton: ['partly', 'Stored encrypted; mail from outside arrives readable'], google: ['no', 'Google can, and scans for its features'], microsoft: ['no', 'Microsoft can'],
		},
	},
	{
		id: 'ai', question: 'You choose which AI sees your data', why: 'AI features send text somewhere. Here you pick where, or a local model.',
		marks: {
			wavium: ['yes', 'Your provider, or local Ollama; off by default'], nextcloud: ['yes', 'Local or chosen provider'],
			proton: ['partly', 'Proton’s own AI'], google: ['no', 'Gemini, Google’s choice'], microsoft: ['no', 'Copilot, Microsoft’s choice'],
		},
	},
	{
		id: 'agents', question: 'AI agents ask before acting', why: 'An agent that sends or deletes on its own can do damage.',
		marks: {
			wavium: ['yes', 'Per-app permissions, approval before send, delete or share, undo'], nextcloud: ['partly', 'Assistant, no per-agent approvals'],
			proton: ['yes', 'No agents that act on their own'], google: ['partly', 'Agent features, few limits per app'], microsoft: ['partly', 'Copilot agents, admin controls'],
		},
	},
	{
		id: 'open', question: 'Open source: anyone can check the code', why: 'Code you can read cannot hide what it does.',
		marks: {
			wavium: ['yes', 'AGPL'], nextcloud: ['yes', 'AGPL'], proton: ['partly', 'Apps open, servers not'],
			google: ['no', 'Closed'], microsoft: ['no', 'Closed'],
		},
	},
	{
		id: 'proven', question: 'Proven: audits, years of use, a security team', why: 'Old, audited software has had its worst bugs found already.',
		marks: {
			wavium: ['no', 'Young project, not audited yet'], nextcloud: ['yes', 'Bug bounty, audits, millions of users'],
			proton: ['yes', 'Audited'], google: ['yes', 'Large security team'], microsoft: ['yes', 'Large security team'],
		},
	},
	{
		id: 'e2e', question: 'End-to-end encryption', why: 'Even a stolen server disk shows nothing readable.',
		marks: {
			wavium: ['no', 'Not yet; encrypt the disk'], nextcloud: ['partly', 'For chosen folders'], proton: ['yes', 'Mail, Drive, Calendar'],
			google: ['no', 'Business plans only'], microsoft: ['partly', 'S/MIME, business plans'],
		},
	},
	{
		id: 'updates', question: 'Security updates happen without you', why: 'A server nobody updates becomes unsafe.',
		marks: {
			wavium: ['partly', 'You update the image (one command)'], nextcloud: ['partly', 'You update'], proton: ['yes', 'Done for you'],
			google: ['yes', 'Done for you'], microsoft: ['yes', 'Done for you'],
		},
	},
	{
		id: 'leave', question: 'You can leave with everything', why: 'No lock-in: your data in standard formats.',
		marks: {
			wavium: ['yes', 'Plain files, IMAP, CalDAV, CardDAV'], nextcloud: ['yes', 'Plain files, standards'], proton: ['partly', 'Export tools'],
			google: ['partly', 'Takeout'], microsoft: ['partly', 'Export per app'],
		},
	},
]

export const markLabel: Record<Mark, string> = { yes: 'Yes', partly: 'Partly', no: 'No' }

/** Count of yes / partly / no for a tool, for the column header. */
export function tally(tool: string): Record<Mark, number> {
	const t: Record<Mark, number> = { yes: 0, partly: 0, no: 0 }
	for (const c of CRITERIA) t[c.marks[tool][0]]++
	return t
}

export const VERDICT = {
	title: 'Safe to install, if you look after it',
	points: [
		'For privacy, Wavium is safer than Google or Microsoft: your data never leaves your machine, and no company reads it or trains on it.',
		'For security, it is younger than Nextcloud, Proton or the big companies: not audited yet. Put it behind HTTPS (the install does), keep it updated, make backups, use a strong password.',
		'The weak point is the machine it runs on: whoever gets into that machine gets the data. Encrypt its disk and do not open more ports than HTTPS.',
	],
}
