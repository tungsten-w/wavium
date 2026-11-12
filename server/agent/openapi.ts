// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OpenAPI 3.1 for the REST side: one POST per tool, same schemas as MCP.
import { publishedSchema, type Tool } from './tools'

const errorSchema = {
	type: 'object',
	properties: {
		error: {
			type: 'object',
			properties: { code: { type: 'string', enum: ['invalid_input', 'auth', 'forbidden', 'not_found', 'conflict', 'unavailable'] }, reason: { type: 'string' }, message: { type: 'string' } },
			required: ['code', 'message'],
		},
	},
}

export function openapi(tools: Tool[], baseUrl: string) {
	const paths: Record<string, unknown> = {}
	for (const t of tools) {
		paths[`/agent/v1/tools/${t.name}`] = {
			post: {
				operationId: t.name,
				summary: t.description,
				tags: [t.area ?? 'agent'],
				requestBody: { required: false, content: { 'application/json': { schema: publishedSchema(t) } } },
				responses: {
					200: { description: 'Tool result (bare JSON), or {status: "pending_approval", request_id, expires_at} for a gated call', content: { 'application/json': { schema: { type: 'object' } } } },
					400: { description: 'invalid_input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					401: { description: 'auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					403: { description: 'forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					404: { description: 'not_found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					409: { description: 'conflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					503: { description: 'unavailable', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
				},
			},
		}
	}
	paths['/agent/v1/mail/uploads'] = {
		post: {
			operationId: 'mail_upload',
			summary: 'Upload a file for a draft attachment (multipart, field "file", max 25 MB, kept 24 h). Returns {upload_id, filename, content_type, size, expires_at}.',
			tags: ['mail'],
			requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } } } },
			responses: { 200: { description: 'Uploaded' } },
		},
	}
	paths['/agent/v1/mail/attachments/{id}'] = {
		get: {
			operationId: 'mail_attachment_download',
			summary: 'Download an attachment through a link from mail_attachment_get (valid 15 min, same token).',
			tags: ['mail'],
			parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
			responses: { 200: { description: 'The file' } },
		},
	}
	return {
		openapi: '3.1.0',
		info: { title: 'Atrium agent API', version: '1', description: 'Every tool is also available over MCP at /agent/mcp. Dotted names (mail.message.list) are accepted as aliases.' },
		servers: [{ url: baseUrl }],
		components: {
			securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
			schemas: { Error: errorSchema },
		},
		security: [{ bearer: [] }],
		paths,
	}
}
