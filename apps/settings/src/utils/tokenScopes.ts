/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { loadState } from '@nextcloud/initial-state'
import { translate as t } from '@nextcloud/l10n'

/** area => actions, from IScopeRegistry (without "core"; admin only for admins) */
export type ScopeAreas = Record<string, string[]>

/** Stored token scope: legacy keys plus the Atrium entry. */
export interface AtriumScope {
	v: number
	scopes: string[]
	agent: boolean
}

/** Agents can never hold these (ScopeSet::AGENT_FORBIDDEN). */
export const AGENT_FORBIDDEN = ['admin', 'security']

/** Areas shown first in the UI; every other app is folded under "Other apps". */
export const MAIN_AREAS = ['mail', 'files', 'calendar', 'contacts', 'tasks', 'notes', 'daily_todo', 'search', 'account', 'security', 'admin']

/** Outward-facing or destructive: always ticked one by one, never implied. */
export const SENSITIVE_ACTIONS = ['send', 'delete', 'share']

const ACTION_ORDER = ['read', 'write', 'send', 'delete', 'share']

let cachedAreas: ScopeAreas | null = null

/**
 * Scope areas offered in the UI.
 */
export function scopeAreas(): ScopeAreas {
	if (cachedAreas === null) {
		cachedAreas = loadState<ScopeAreas>('settings', 'token_scope_areas', {})
	}
	return cachedAreas
}

/**
 * Areas for a token kind (agents never see admin or security).
 *
 * @param agent whether the token is an agent token
 */
export function areasFor(agent: boolean): ScopeAreas {
	const result: ScopeAreas = {}
	for (const [area, actions] of Object.entries(scopeAreas())) {
		if (agent && AGENT_FORBIDDEN.includes(area)) {
			continue
		}
		result[area] = [...actions].sort((a, b) => order(a) - order(b))
	}
	return result
}

/**
 * Sort key: read, write, send, delete, share, then anything else.
 *
 * @param action the action id
 */
function order(action: string): number {
	const i = ACTION_ORDER.indexOf(action)
	return i === -1 ? ACTION_ORDER.length : i
}

/**
 * The Atrium part of a token scope, or null for a legacy (full access) token.
 *
 * @param scope the token's stored scope
 */
export function atriumScope(scope: Record<string, unknown> | undefined): AtriumScope | null {
	const value = scope?.atrium as AtriumScope | undefined
	if (!value || typeof value !== 'object' || !Array.isArray(value.scopes)) {
		return null
	}
	return { v: value.v, scopes: value.scopes.map(String), agent: value.agent === true }
}

/**
 * Explicit "area:action" list: wildcards expanded with the known areas, and
 * read added where write is held (write implies read). Agents never get
 * anything from a wildcard.
 *
 * @param scopes stored scopes
 * @param agent whether the token is an agent token
 */
export function expandScopes(scopes: string[], agent: boolean): string[] {
	const areas = areasFor(agent)
	const result = new Set<string>()
	for (const scope of scopes) {
		const [area, action] = scope === '*' ? ['*', '*'] : scope.split(':', 2)
		if (agent && (action === '*' || AGENT_FORBIDDEN.includes(area))) {
			continue
		}
		if (area === '*') {
			for (const [a, actions] of Object.entries(areas)) {
				actions.forEach((x) => result.add(`${a}:${x}`))
			}
		} else if (action === '*') {
			(areas[area] ?? []).forEach((x) => result.add(`${area}:${x}`))
		} else {
			result.add(`${area}:${action}`)
			if (action === 'write') {
				result.add(`${area}:read`)
			}
		}
	}
	return [...result]
}

/**
 * Minimal list to store: read is dropped where write is held.
 *
 * @param scopes explicit scopes
 */
export function compactScopes(scopes: string[]): string[] {
	const set = new Set(scopes)
	return [...set]
		.filter((s) => !(s.endsWith(':read') && set.has(s.replace(/:read$/, ':write'))))
		.sort()
}

/**
 * Human readable label for an area.
 *
 * @param area the area id
 */
export function areaLabel(area: string): string {
	const labels: Record<string, string> = {
		files: t('settings', 'Files'),
		calendar: t('settings', 'Calendar'),
		contacts: t('settings', 'Contacts'),
		tasks: t('settings', 'Tasks'),
		mail: t('settings', 'Mail'),
		notes: t('settings', 'Notes'),
		daily_todo: t('settings', 'Daily Todo'),
		search: t('settings', 'Search'),
		account: t('settings', 'Account (profile and settings)'),
		security: t('settings', 'Security (app passwords, 2FA, sessions, email and password)'),
		admin: t('settings', 'Administration'),
	}
	return labels[area] ?? area
}

/**
 * Human readable label for an action.
 *
 * @param action the action id
 */
export function actionLabel(action: string): string {
	const labels: Record<string, string> = {
		read: t('settings', 'read'),
		write: t('settings', 'write'),
		send: t('settings', 'send'),
		delete: t('settings', 'delete'),
		share: t('settings', 'share'),
	}
	return labels[action] ?? action
}

/**
 * Summary per area, e.g. [["Mail", "read, write, send"]].
 *
 * @param scopes stored scopes
 * @param agent whether the token is an agent token
 */
export function summarize(scopes: string[], agent: boolean): [string, string][] {
	const byArea = new Map<string, string[]>()
	for (const scope of expandScopes(scopes, agent)) {
		const [area, action] = scope.split(':', 2)
		byArea.set(area, [...(byArea.get(area) ?? []), action])
	}
	return [...byArea.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([area, actions]) => [areaLabel(area), actions.sort((a, b) => order(a) - order(b)).map(actionLabel).join(', ')])
}
