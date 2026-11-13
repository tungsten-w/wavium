// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Provider-neutral types for Atrium calling an AI itself (PLAN "Sens 2").
// Every provider maps these to and from its own wire format, so the rest of
// Atrium (triage, summaries, drafts, assistant) never sees a vendor shape.

export type ProviderKind = 'anthropic' | 'openai' | 'mistral' | 'openai-compatible' | 'ollama' | 'mock'

export interface ProviderConfig {
	kind: ProviderKind
	/** Stable id of this configured provider (defaults to the kind). */
	id?: string
	baseUrl?: string
	apiKey?: string
	/** Used when a request has no model. */
	defaultModel?: string
	/** Per request; for streams it is an idle timeout between chunks. */
	timeoutMs?: number
	/** Extra headers, e.g. OpenRouter's HTTP-Referer / X-Title. */
	headers?: Record<string, string>
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface ProviderDeps {
	/** Injected in tests: no test ever hits the network. */
	fetch?: FetchFn
}

export interface TextBlock { type: 'text', text: string }
export interface ToolCall { id: string, name: string, input: unknown }
export interface ToolCallBlock extends ToolCall { type: 'tool_call' }
export interface ToolResultBlock { type: 'tool_result', toolCallId: string, content: string, isError?: boolean }
export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock

export interface AiMessage {
	/** Tool results go in a user message, like Anthropic; OpenAI-style providers split them out. */
	role: 'user' | 'assistant'
	content: string | ContentBlock[]
}

export interface ToolDef {
	name: string
	description: string
	/** JSON Schema of the input object. */
	inputSchema: Record<string, unknown>
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string }

export interface AiRequest {
	/** Falls back to the provider's defaultModel. */
	model?: string
	system?: string
	messages: AiMessage[]
	tools?: ToolDef[]
	/** Ignored without tools. 'required' = must call some tool; {name} = must call that one (e.g. a forced classification). */
	toolChoice?: ToolChoice
	maxTokens?: number
	temperature?: number
	stop?: string[]
	signal?: AbortSignal
}

/**
 * 'stop' = stopped for another reason than the other four: a stop sequence,
 * Anthropic's pause_turn, or a reason this layer does not know yet (the raw
 * value is in AiResult.providerStopReason).
 */
export type StopReason = 'end' | 'max_tokens' | 'tool_use' | 'stop' | 'error'

export interface Usage {
	/** All input tokens, cached ones included. */
	inputTokens: number
	outputTokens: number
	/** Part of inputTokens read from the prompt cache (Anthropic cache_read, OpenAI cached_tokens). */
	cacheReadTokens?: number
	/** Part of inputTokens written to the prompt cache (Anthropic cache_creation). */
	cacheWriteTokens?: number
	/** False when the server sent no usage (some OpenAI-compatible ones): budgets must estimate. */
	reported: boolean
}

export interface AiResult {
	text: string
	toolCalls: ToolCall[]
	stopReason: StopReason
	usage: Usage
	model: string
	/** The provider's own stop reason, as sent. */
	providerStopReason?: string
	/** Provider's own response (or last stream event), for debugging. */
	raw?: unknown
}

export type AiStreamEvent =
	| { type: 'text', text: string }
	| { type: 'tool_call', call: ToolCall }
	| { type: 'done', result: AiResult }

export interface ConnectionTest {
	ok: boolean
	error?: { code: string, message: string }
	models?: string[]
}

export interface AiProvider {
	readonly id: string
	readonly kind: ProviderKind
	complete(req: AiRequest): Promise<AiResult>
	/** Yields text and tool calls as they come, then exactly one `done`. */
	stream(req: AiRequest): AsyncIterable<AiStreamEvent>
	listModels(): Promise<string[]>
	/** For the "test connection" button: lists models, never spends tokens. */
	testConnection(): Promise<ConnectionTest>
}
