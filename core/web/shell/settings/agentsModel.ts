// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Agents: types and the pure logic of the permission table, kept
// apart from React so it is tested. API calls: agentsApi.ts.

export type Action = 'read' | 'write' | 'delete' | 'send' | 'share'
export type Mode = 'off' | 'allowed' | 'approval'
export type Modes = Partial<Record<Action, Mode>>
export type AccessMap = Record<string, Modes>

export const ACTIONS: Action[] = ['read', 'write', 'send', 'delete', 'share']
export const actionLabels: Record<Action, string> = { read: 'Read', write: 'Write', send: 'Send', delete: 'Delete', share: 'Share' }
export const modeLabels: Record<Mode, string> = { off: 'Off', allowed: 'Allowed', approval: 'Ask me' }

export interface AgentToken { id: number, name: string, lastActivity: number }
export interface Agent {
	uid: string
	displayName: string
	description: string
	owner: string
	createdAt: number
	enabled: boolean
	paused: boolean
	wakes: boolean
	webhookUrl: string | null
	notifyApprovals: boolean
	doorbellError: string | null
	doorbellErrorAt: number | null
	access: AccessMap
	tokens: AgentToken[]
	/** Apps connected through OAuth (P2-7). */
	connectedApps?: ConnectedApp[]
}
export interface ConnectedApp { grantId: string, clientName: string, clientId: string, createdAt: number, lastUsedAt: number }
/** An OAuth connection request waiting for the user (Settings > Connect an agent). */
export interface OAuthFlow { flow_id: string, client_id: string, client_name: string, client_kind: 'cimd' | 'dcr', redirect_uri: string, redirect_host: string, localhost: boolean }
export interface ConnectInfo {
	agent: string
	mcpUrl: string
	restUrl: string
	openapiUrl: string
	token: string
	webhookSecret: string | null
	snippets: { claudeCode: string, mcpJson: string, codex: string, curl: string }
}
export interface Approval {
	request_id: string
	agent: string
	tool: string
	status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'void' | 'expired' | 'cancelled'
	summary: string
	input: unknown
	payload: unknown
	requested_at: string
	expires_at: string
	decided_by: string | null
	decided_at: string | null
	note: string | null
	error: string | null
}
export type Preset = 'mail' | 'todo' | 'everything'

const AREA_LABELS: Record<string, string> = {
	mail: 'Mail', daily_todo: 'Daily Todo', files: 'Files', calendar: 'Calendar', contacts: 'Contacts', notes: 'Notes',
	tasks: 'Tasks', comments: 'Comments', activity: 'Activity', systemtags: 'Tags', deck: 'Deck', talk: 'Talk', spreed: 'Talk',
}
export const areaLabel = (id: string): string => AREA_LABELS[id] ?? id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** Areas with agent tools first (most tools first), then the rest by name. */
export function sortAreas(areas: string[], tools: Record<string, number>): string[] {
	return [...areas].sort((a, b) => (tools[b] ?? 0) - (tools[a] ?? 0) || areaLabel(a).localeCompare(areaLabel(b)))
}

/** Read is on or off; every other action can also wait for the owner's approval. */
export const modesFor = (action: Action): Mode[] => action === 'read' ? ['off', 'allowed'] : ['off', 'allowed', 'approval']

/**
 * One cell changed -> the area's new modes (null = no access at all). Read off
 * removes the area; turning anything on without access grants read too (write
 * implies read). Actions the area lacks are dropped.
 */
export function applyCell(current: Modes | undefined, action: Action, mode: Mode, available: Action[]): Modes | null {
	if (action === 'read' && mode === 'off') return null
	const base: Modes = current ? { ...current } : { read: 'allowed' }
	if (!current && action !== 'read' && mode === 'off') return null
	base[action] = mode
	base.read = 'allowed'
	const out: Modes = {}
	for (const a of available) if (base[a]) out[a] = base[a]
	return out
}

/** "Read, write · send and delete ask you" for one area. */
export function describeModes(modes: Modes | undefined): string {
	if (!modes || modes.read !== 'allowed') return 'No access'
	const allowed = ACTIONS.filter((a) => modes[a] === 'allowed').map((a) => actionLabels[a].toLowerCase())
	const ask = ACTIONS.filter((a) => modes[a] === 'approval').map((a) => actionLabels[a].toLowerCase())
	const list = (xs: string[]) => xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
	const parts = [allowed.length ? allowed.join(', ').replace(/^./, (c) => c.toUpperCase()) : '']
	if (ask.length) parts.push(`${list(ask)} ask${ask.length === 1 ? 's' : ''} you`)
	return parts.filter(Boolean).join(' · ')
}

export interface PayloadView { rows: Array<{ label: string, value: string }>, body: string | null }

const addrList = (v: unknown): string => Array.isArray(v)
	? v.map((a: { name?: string, address?: string }) => a?.name ? `${a.name} <${a.address}>` : String(a?.address ?? '')).join(', ')
	: ''

/** What the owner approves, readable: a mail to send, or the raw frozen payload. */
export function payloadView(tool: string, payload: unknown): PayloadView {
	const p = (payload ?? {}) as Record<string, unknown>
	if (tool === 'mail_send') {
		const rows = [
			{ label: 'From', value: String(p.from ?? '') },
			{ label: 'To', value: addrList(p.to) },
			{ label: 'Cc', value: addrList(p.cc) },
			{ label: 'Bcc', value: addrList(p.bcc) },
			{ label: 'Subject', value: String(p.subject ?? '') || '(no subject)' },
			{ label: 'Attachments', value: Array.isArray(p.attachments) ? p.attachments.map((a: { filename?: string }) => a?.filename ?? '').join(', ') : '' },
		].filter((r) => r.value !== '')
		return { rows, body: typeof p.body === 'string' ? p.body : null }
	}
	const rows = Object.entries(p).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object').map(([k, v]) => ({ label: k, value: String(v) }))
	const complex = Object.entries(p).filter(([, v]) => v !== null && typeof v === 'object')
	return { rows, body: complex.length ? JSON.stringify(Object.fromEntries(complex), null, 2) : null }
}

export const statusLabels: Record<Approval['status'], string> = {
	pending: 'Waiting', approved: 'Approved', rejected: 'Rejected', executed: 'Done', failed: 'Failed',
	void: 'Changed after asking', expired: 'Expired', cancelled: 'Cancelled by the agent',
}

// ---------------------------------------------------------------- connect box

export type ClientId = 'claude-code' | 'claude-desktop' | 'cursor' | 'codex' | 'rest'
export interface ConnectStep {
	label: string
	value: string
	multiline?: boolean
}
export interface ClientGuide {
	id: ClientId
	label: string
	/** One or two sentences: where this goes. */
	intro: string
	steps: ConnectStep[]
	note?: string
}

/** Single quotes for a POSIX shell. */
function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Ready-to-copy instructions per client for the connect box (PLAN.md P2-6).
 * Pure: built from the URLs and the token the server returned once. The
 * server name is "atrium"; MCP clients prefix the tools with it.
 */
export function connectGuides(info: Pick<ConnectInfo, 'mcpUrl' | 'restUrl' | 'openapiUrl' | 'token'>): ClientGuide[] {
	const { mcpUrl, token } = info
	// restUrl reads "<base>/agent/v1/tools/<tool>" (server/agent/owner.ts).
	const base = info.restUrl.replace(/\/agent\/v1(\/.*)?$/, '')
	const bearer = `Bearer ${token}`
	const json = (v: unknown) => JSON.stringify(v, null, 2)
	return [
		{
			id: 'claude-code',
			label: 'Claude Code',
			intro: 'Run this once in a terminal. Add --scope user to use Atrium in every project, or put the JSON in a project\'s .mcp.json instead.',
			steps: [
				{ label: 'Command', value: `claude mcp add --transport http atrium ${shq(mcpUrl)} --header ${shq(`Authorization: ${bearer}`)}` },
				{ label: '.mcp.json (alternative)', value: json({ mcpServers: { atrium: { type: 'http', url: mcpUrl, headers: { Authorization: bearer } } } }), multiline: true },
			],
			note: 'Check with: claude mcp list',
		},
		{
			id: 'claude-desktop',
			label: 'Claude Desktop',
			intro: 'Settings › Developer › Edit Config, add this to claude_desktop_config.json, then restart Claude Desktop. It goes through mcp-remote (needs Node.js), because local config entries cannot send a token header themselves.',
			steps: [
				{
					label: 'claude_desktop_config.json',
					value: json({ mcpServers: { atrium: { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl, '--header', 'Authorization:${ATRIUM_AUTH}'], env: { ATRIUM_AUTH: bearer } } } }),
					multiline: true,
				},
			],
			note: 'Adding Atrium as a custom connector on claude.ai needs OAuth, which comes later (TASKS.md P2-7).',
		},
		{
			id: 'cursor',
			label: 'Cursor',
			intro: 'Put this in ~/.cursor/mcp.json (every project) or .cursor/mcp.json (one project).',
			steps: [{ label: 'mcp.json', value: json({ mcpServers: { atrium: { url: mcpUrl, headers: { Authorization: bearer } } } }), multiline: true }],
		},
		{
			id: 'codex',
			label: 'Codex',
			intro: 'Add this to ~/.codex/config.toml and keep the token in an environment variable, not in the file.',
			steps: [
				{ label: 'config.toml', value: `[mcp_servers.atrium]\nurl = "${mcpUrl}"\nbearer_token_env_var = "ATRIUM_TOKEN"`, multiline: true },
				{ label: 'Shell (e.g. ~/.profile)', value: `export ATRIUM_TOKEN=${shq(token)}` },
			],
		},
		{
			id: 'rest',
			label: 'Script (REST)',
			intro: `Any language can call the tools over HTTP: POST ${base}/agent/v1/tools/<tool> with a JSON body. The list of tools and their inputs: ${info.openapiUrl}.`,
			steps: [
				{
					label: 'atrium.sh',
					value: [
						'#!/bin/sh',
						'# Usage: ./atrium.sh <tool> [json-input]   e.g. ./atrium.sh mail_message_list \'{"limit": 5}\'',
						`ATRIUM_URL=${shq(base)}`,
						`ATRIUM_TOKEN=${shq(token)}`,
						"body=${2:-'{}'}",
						'curl -sS -X POST "$ATRIUM_URL/agent/v1/tools/$1" \\',
						'  -H "Authorization: Bearer $ATRIUM_TOKEN" -H "Content-Type: application/json" \\',
						'  -d "$body"',
					].join('\n'),
					multiline: true,
				},
				{ label: 'First call', value: './atrium.sh agent_whoami' },
			],
			note: 'Events: call events_since with the last next_cursor you got (start without one).',
		},
	]
}

/** One change an agent made (owner journal, server/agent/journal.ts). */
export interface AgentAction {
	action_id: string
	agent: string
	area: string
	tool: string
	summary: string
	request_id: string | null
	at: string | null
	/** What Undo does; null = cannot be undone here (or already undone). */
	undo: string | null
	undone_at: string | null
	undo_error: string | null
}
