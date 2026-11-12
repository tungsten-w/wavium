// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Icon names. The artwork is Tabler Icons (MIT, https://tabler.io/icons), kept in
// tabler/data.ts. Every icon is a 24px outline drawn with a 2px round stroke in
// currentColor. Use either a Tabler name ('shield-lock') or one of the older Atrium
// names below ('lock'), which map to a Tabler icon. To add an icon: add its Tabler
// name to tabler/icons.txt and run `bash core/web/ui/tabler/sync.sh`.
import { filled, outline } from './tabler/data'

/** Older Atrium names -> Tabler names. Keep these working: apps pass them as strings. */
export const aliases = {
	menu: 'menu-2', close: 'x', add: 'plus', delete: 'trash', edit: 'pencil', image: 'photo',
	person: 'user', group: 'users', apps: 'apps', chevronLeft: 'chevron-left', chevronRight: 'chevron-right',
	expandMore: 'chevron-down', chevronDown: 'chevron-down', moreVert: 'dots-vertical', event: 'calendar-event',
	today: 'calendar', contacts: 'address-book', agent: 'robot', starBorder: 'star', star: 'star-filled',
	newFolder: 'folder-plus', task: 'circle-check', info: 'info-circle', warning: 'alert-triangle',
	darkMode: 'moon', openInNew: 'external-link', drag: 'grip-vertical', place: 'map-pin', schedule: 'clock',
	business: 'building', visibility: 'eye', arrowBack: 'arrow-left', arrowUp: 'arrow-up', arrowDown: 'arrow-down',
	barChart: 'chart-bar', swapVert: 'arrows-up-down', indentMore: 'indent-increase', indentLess: 'indent-decrease',
	postpone: 'calendar-time', personAdd: 'user-plus', label: 'tag', work: 'briefcase', notifications: 'bell',
	computer: 'device-desktop', extension: 'puzzle', dashboard: 'layout-dashboard', pdf: 'file-type-pdf',
	description: 'file-text', gridView: 'layout-grid', listView: 'list', contentCopy: 'copy',
	driveFileMove: 'folder-symlink', cloudUpload: 'cloud-upload', draft: 'mail-opened', attachment: 'paperclip',
} as const

const direct = {
	...outline,
	...Object.fromEntries(Object.entries(filled).map(([k, v]) => [k + '-filled', v])),
} as Record<string, string>
const filledNames = new Set(Object.keys(filled).map((k) => k + '-filled'))

/** Path data of an icon (several paths separated by |), or undefined when unknown. */
export function iconPaths(name: string): string | undefined {
	const t = (aliases as Record<string, string>)[name] ?? name
	return direct[t]
}
export const isFilled = (name: string) => filledNames.has((aliases as Record<string, string>)[name] ?? name)

/** Tabler icon for a Settings section (id as sent by the API). */
const SECTION_ICONS: Record<string, string> = {
	'personal-info': 'user-circle', security: 'shield-lock', notifications: 'bell', sharing: 'share', theming: 'palette',
	availability: 'clock', workflow: 'route', overview: 'layout-dashboard', presets: 'adjustments', server: 'settings',
	externalstorages: 'database', groupware: 'users-group', admindelegation: 'user-shield', activity: 'activity',
	encryption: 'lock', federation: 'world', mail: 'mail', calendar: 'calendar', contacts: 'address-book',
	basic: 'settings', additional: 'adjustments', connectivity: 'plug', support: 'lifebuoy', accessibility: 'accessible',
	'connected-accounts': 'plug', 'sync-clients': 'device-desktop', 'mobile-sync': 'device-mobile', ai: 'robot',
}
export const sectionIcon = (id: string) => SECTION_ICONS[id] ?? 'settings'

export type TablerName = keyof typeof outline | `${keyof typeof filled}-filled`
export type IconName = keyof typeof aliases | TablerName
/** Kept for callers that listed names. */
export const icons = direct
