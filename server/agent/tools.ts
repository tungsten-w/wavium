// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tool registry and the one call path every tool goes through (MCP and REST):
// input validation, grant check per action (off / allowed / approval), and the
// approval queue for gated actions.
import { type AccessMap, type Action, getAccess, getSettings, modeOf } from './access'
import type { Db } from './db'
import type { PhpCaller } from './phpcall'
import { recordAction } from './journal'
import { type Schema, validate } from './schema'
import { AgentError } from './util'

export interface AgentIdentity { uid: string, displayName: string, owner: string | null }

export interface ToolCtx {
	db: Db
	php: PhpCaller
	agent: AgentIdentity
	/** Whose data this call acts on. */
	grantor: string
	access: AccessMap
	/** Public base URL, e.g. https://atrium.example.com */
	baseUrl: string
	approvals: ApprovalsApi
}

export interface Prepared {
	/** Frozen payload; executed exactly as stored after approval. */
	payload: unknown
	/** One line for the owner ("Send 'Lunch?' to jane@example.org"). */
	summary: string
	/** What the request is about (e.g. a draft key), to void it when that changes. */
	ref?: string
}

export interface Tool {
	name: string
	description: string
	/** Grant area, or null for base tools anyone may call. */
	area: string | null
	input: Schema
	/** Action checked against the grant; may depend on the input (default read). */
	action?: Action | ((ctx: ToolCtx, input: Record<string, unknown>) => Promise<Action>)
	/** Tools without approval support. */
	run?: (ctx: ToolCtx, input: Record<string, unknown>) => Promise<unknown>
	/** Approval-capable tools: prepare (validate, freeze), then execute the frozen payload. */
	prepare?: (ctx: ToolCtx, input: Record<string, unknown>) => Promise<Prepared>
	execute?: (ctx: ToolCtx, payload: unknown, approval: { request_id: string } | null) => Promise<unknown>
	/** Checked before executing an approved request; false = the request is void. */
	stillValid?: (ctx: ToolCtx, payload: unknown) => Promise<boolean>
}

export interface ApprovalsApi {
	request(ctx: ToolCtx, tool: Tool, input: Record<string, unknown>, prepared: Prepared): Promise<{ status: 'pending_approval', request_id: string, expires_at: string | null }>
	voidRef(agent: string, ref: string, why: string): Promise<void>
}

export const toolName = (name: string): string => name.replace(/\./g, '_')

export class Registry {
	private tools = new Map<string, Tool>()

	add(...tools: Tool[]): void {
		for (const t of tools) this.tools.set(t.name, t)
	}

	get(name: string): Tool | undefined {
		return this.tools.get(toolName(name))
	}

	all(): Tool[] {
		return [...this.tools.values()]
	}

	/** Tools an agent can see: base tools plus the areas it can read on some grantor. */
	visible(areasReadable: Set<string>): Tool[] {
		return this.all().filter((t) => t.area === null || areasReadable.has(t.area))
	}
}

/** The input schema as published: every tool also takes an optional grantor. */
export function publishedSchema(t: Tool): Schema {
	const props = { ...(t.input.properties ?? {}) }
	props.grantor = { type: 'string', description: 'User whose data to act on (default: the agent\'s owner)' }
	return { ...t.input, type: 'object', properties: props }
}

export async function buildCtx(base: Omit<ToolCtx, 'grantor' | 'access'>, grantor?: string): Promise<ToolCtx> {
	const g = grantor ?? base.agent.owner
	if (!g) throw new AgentError('forbidden', 'This agent has no owner')
	return { ...base, grantor: g, access: await getAccess(base.db, base.agent.uid, g) }
}

export async function callTool(registry: Registry, base: Omit<ToolCtx, 'grantor' | 'access'>, name: string, rawInput: unknown): Promise<unknown> {
	const tool = registry.get(name)
	if (!tool) throw new AgentError('not_found', `Unknown tool ${name}`)
	const input = (rawInput ?? {}) as Record<string, unknown>
	if (typeof input !== 'object' || Array.isArray(input)) throw new AgentError('invalid_input', 'The input must be a JSON object')
	const { grantor, ...rest } = input
	if (grantor !== undefined && typeof grantor !== 'string') throw new AgentError('invalid_input', 'input.grantor: expected string')
	const errors = validate(tool.input, rest)
	if (errors.length) throw new AgentError('invalid_input', errors.slice(0, 5).join('; '))
	if ((await getSettings(base.db, base.agent.uid)).paused) {
		throw new AgentError('forbidden', 'This agent is paused by its owner', 'paused')
	}
	const ctx = await buildCtx(base, grantor as string | undefined)
	if (tool.area !== null) {
		if (modeOf(ctx.access[tool.area], 'read') !== 'allowed') {
			throw new AgentError('forbidden', `No access to ${tool.area} for ${ctx.grantor}`)
		}
		const action = typeof tool.action === 'function' ? await tool.action(ctx, rest) : (tool.action ?? 'read')
		const mode = modeOf(ctx.access[tool.area], action)
		if (mode === 'off') throw new AgentError('forbidden', `${tool.area}:${action} is off for this agent`)
		if (mode === 'approval') {
			if (!tool.prepare) throw new AgentError('forbidden', `${tool.area}:${action} needs approval, which ${tool.name} does not support`)
			return ctx.approvals.request(ctx, tool, rest, await tool.prepare(ctx, rest))
		}
	}
	// Changes go to the owner's journal (journal.ts), with how to undo them.
	const changes = tool.area !== null && (typeof tool.action === 'function' ? await tool.action(ctx, rest) : (tool.action ?? 'read')) !== 'read'
	if (tool.run) {
		const result = await tool.run(ctx, rest)
		if (changes) await recordAction(ctx, tool, rest, result)
		return result
	}
	if (tool.prepare && tool.execute) {
		const prepared = await tool.prepare(ctx, rest)
		const result = await tool.execute(ctx, prepared.payload, null)
		if (changes) await recordAction(ctx, tool, rest, result, { summary: prepared.summary })
		return result
	}
	throw new AgentError('unavailable', `${tool.name} has no implementation`)
}

