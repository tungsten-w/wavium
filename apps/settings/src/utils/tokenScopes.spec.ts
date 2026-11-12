/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest'
import * as mod from './tokenScopes.ts'

vi.mock('@nextcloud/initial-state', () => ({
	loadState: () => ({
		files: ['read', 'write', 'delete', 'share'],
		mail: ['share', 'delete', 'send', 'write', 'read'],
		security: ['read', 'write'],
		admin: ['read', 'write'],
	}),
}))

describe('tokenScopes', () => {
	it('reads the atrium entry and treats anything else as legacy', () => {
		expect(mod.atriumScope({ filesystem: true })).toBeNull()
		expect(mod.atriumScope({ atrium: { v: 1, scopes: ['mail:read'], agent: true } })).toEqual({ v: 1, scopes: ['mail:read'], agent: true })
	})

	it('hides admin and security from agents and orders actions', () => {
		expect(Object.keys(mod.areasFor(true))).toEqual(['files', 'mail'])
		expect(Object.keys(mod.areasFor(false))).toEqual(['files', 'mail', 'security', 'admin'])
		expect(mod.areasFor(true).mail).toEqual(['read', 'write', 'send', 'delete', 'share'])
	})

	it('expands human wildcards and write to read', () => {
		expect(mod.expandScopes(['mail:*'], false).sort()).toEqual(['mail:delete', 'mail:read', 'mail:send', 'mail:share', 'mail:write'])
		expect(mod.expandScopes(['files:write'], false).sort()).toEqual(['files:read', 'files:write'])
		expect(mod.expandScopes(['*'], false)).toHaveLength(13)
	})

	it('gives agents nothing from wildcards or forbidden areas', () => {
		expect(mod.expandScopes(['mail:*', '*', 'security:read'], true)).toEqual([])
		expect(mod.expandScopes(['mail:send'], true)).toEqual(['mail:send'])
	})

	it('compacts read under write', () => {
		expect(mod.compactScopes(['mail:read', 'mail:write', 'files:read', 'mail:send'])).toEqual(['files:read', 'mail:send', 'mail:write'])
	})

	it('summarizes per area', () => {
		expect(mod.summarize(['mail:write', 'mail:send'], true)).toEqual([['Mail', 'read, write, send']])
	})
})
