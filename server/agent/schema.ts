// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The JSON Schema subset the tool inputs use, and a validator for it. The same
// schemas go out in MCP tools/list and the OpenAPI document.

export interface Schema {
	type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'null' | Array<'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'null'>
	description?: string
	properties?: Record<string, Schema>
	required?: string[]
	additionalProperties?: boolean
	enum?: Array<string | number | boolean | null>
	items?: Schema
	maxItems?: number
	minLength?: number
	maxLength?: number
	minimum?: number
	maximum?: number
	format?: 'date-time' | 'email'
	anyOf?: Schema[]
	default?: unknown
}

const typeOf = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? 'array'
	: typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v

/** Errors as "path: message"; empty when valid. */
export function validate(schema: Schema, value: unknown, path = 'input'): string[] {
	if (schema.anyOf) {
		const all = schema.anyOf.map((s) => validate(s, value, path))
		if (all.some((e) => e.length === 0)) return []
		return [`${path}: does not match any allowed shape (${all.map((e) => e[0]).join('; ')})`]
	}
	if (schema.type) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type]
		const t = typeOf(value)
		if (!types.includes(t as never) && !(t === 'integer' && types.includes('number'))) {
			return [`${path}: expected ${types.join(' or ')}, got ${t}`]
		}
	}
	if (schema.enum && !schema.enum.includes(value as never)) {
		return [`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`]
	}
	const errors: string[] = []
	if (typeof value === 'string') {
		if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short (min ${schema.minLength})`)
		if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: too long (max ${schema.maxLength})`)
		if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${path}: not an ISO date`)
	}
	if (typeof value === 'number') {
		if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`)
		if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`)
	}
	if (Array.isArray(value)) {
		if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items (max ${schema.maxItems})`)
		if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items!, v, `${path}[${i}]`)))
	}
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>
		for (const key of schema.required ?? []) {
			if (obj[key] === undefined) errors.push(`${path}.${key}: required`)
		}
		for (const [key, v] of Object.entries(obj)) {
			const sub = schema.properties?.[key]
			if (sub) errors.push(...validate(sub, v, `${path}.${key}`))
			else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unknown field`)
		}
	}
	return errors
}

// Shorthands for tool definitions.
export const obj = (properties: Record<string, Schema>, required: string[] = []): Schema =>
	({ type: 'object', properties, required, additionalProperties: false })
export const str = (description?: string, extra: Partial<Schema> = {}): Schema => ({ type: 'string', ...(description ? { description } : {}), ...extra })
export const int = (description?: string, extra: Partial<Schema> = {}): Schema => ({ type: 'integer', ...(description ? { description } : {}), ...extra })
export const boolean = (description?: string): Schema => ({ type: 'boolean', ...(description ? { description } : {}) })
export const arr = (items: Schema, description?: string, extra: Partial<Schema> = {}): Schema => ({ type: 'array', items, ...(description ? { description } : {}), ...extra })
