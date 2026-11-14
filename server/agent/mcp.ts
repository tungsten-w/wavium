// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MCP over Streamable HTTP, JSON responses only (no SSE): POST /agent/mcp with
// JSON-RPC. initialize, ping, tools/list, tools/call; notifications get 202.
import { publishedSchema, type Tool } from './tools'
import { AgentError } from './util'

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

interface RpcRequest { jsonrpc: '2.0', id?: string | number | null, method: string, params?: Record<string, unknown> }

export interface McpBackend {
	/** Tools this caller may see. */
	list(): Promise<Tool[]>
	call(name: string, input: unknown): Promise<unknown>
}

const rpcError = (id: RpcRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

export function toolResult(value: unknown) {
	const structured = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { result: value }
	return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: structured }
}

export function toolErrorResult(e: AgentError) {
	const body = e.toJSON()
	return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true }
}

async function one(msg: RpcRequest, backend: McpBackend): Promise<unknown | null> {
	if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid request')
	const isNotification = msg.id === undefined
	if (isNotification) return null
	switch (msg.method) {
		case 'initialize': {
			const asked = String(msg.params?.protocolVersion ?? '')
			return {
				jsonrpc: '2.0',
				id: msg.id,
				result: {
					protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'atrium', version: '1' },
					instructions: 'Wavium agent tools. Every call acts on one grantor\'s data (default: your owner). Gated actions return {status:"pending_approval", request_id}; the answer arrives as an approval.* event. Poll events_since with your last next_cursor.',
				},
			}
		}
		case 'ping':
			return { jsonrpc: '2.0', id: msg.id, result: {} }
		case 'tools/list': {
			const tools = await backend.list()
			return {
				jsonrpc: '2.0',
				id: msg.id,
				result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: publishedSchema(t) })) },
			}
		}
		case 'tools/call': {
			const name = String(msg.params?.name ?? '')
			try {
				return { jsonrpc: '2.0', id: msg.id, result: toolResult(await backend.call(name, msg.params?.arguments ?? {})) }
			} catch (e) {
				if (e instanceof AgentError) {
					if (e.code === 'auth') return rpcError(msg.id, -32001, e.message)
					return { jsonrpc: '2.0', id: msg.id, result: toolErrorResult(e) }
				}
				console.error(`agent tool ${name}:`, e)
				return { jsonrpc: '2.0', id: msg.id, result: toolErrorResult(new AgentError('unavailable', 'Internal error')) }
			}
		}
		default:
			return rpcError(msg.id, -32601, `Method not found: ${msg.method}`)
	}
}

export async function handleMcp(req: Request, backend: McpBackend): Promise<Response> {
	if (req.method !== 'POST') {
		return new Response(null, { status: 405, headers: { Allow: 'POST' } })
	}
	let body: unknown
	try {
		body = await req.json()
	} catch {
		return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 })
	}
	if (Array.isArray(body)) {
		const out = (await Promise.all(body.map((m) => one(m as RpcRequest, backend)))).filter((r) => r !== null)
		return out.length ? Response.json(out) : new Response(null, { status: 202 })
	}
	const res = await one(body as RpcRequest, backend)
	return res === null ? new Response(null, { status: 202 }) : Response.json(res)
}
