// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure mail-list logic kept out of the React component so it can be tested:
// folder order, label search words (`category:ads`) and the merged Inbox/Archive/Favorites views.
import { categoryLabels, defaultLabel, filterCategories, folderLabel, noLabel, specialMailbox, type Account, type LabelFilter, type Mailbox } from './api'

export const roleOrder = ['inbox', 'flagged', 'drafts', 'sent', 'snoozed', 'archive', 'all', 'junk', 'trash']
/** Special folders first in a fixed order, then the user's folders alphabetically. */
export const sortBoxes = (list: Mailbox[]) => [...list].sort((x, y) => {
	const rx = roleOrder.indexOf(x.specialRole), ry = roleOrder.indexOf(y.specialRole)
	if (rx !== ry) return (rx < 0 ? 99 : rx) - (ry < 0 ? 99 : ry)
	return folderLabel(x).localeCompare(folderLabel(y))
})
/**
 * Search words that mean a label, not text: `category:ads`, `tag:work`, `label:orders`,
 * `needs:action` (also `action`, `is:action`). Only when the whole query is made of them.
 */
export function labelQuery(query: string): LabelFilter | null {
	const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
	if (!tokens.length) return null
	const out: LabelFilter = { ...noLabel }
	for (const t of tokens) {
		const m = /^(?:category|cat|tag|label):(\w+)$/.exec(t)
		if (m && filterCategories.includes(m[1]) && !out.category) out.category = m[1]
		else if (/^(?:needs:action|needs-action|is:action|action)$/.test(t)) out.needsAction = true
		else return null
	}
	return out
}
export type ViewKind = 'inbox' | 'archive' | 'starred' | 'drafts'
/** The folder of that kind in every account: Inbox, Archive (or Gmail's All Mail), Starred. */
export const kindBoxes = (kind: ViewKind, accounts: Account[], boxes: Mailbox[]) => accounts
	.map((a) => kind === 'inbox' ? specialMailbox(boxes, 'inbox', a.id) : kind === 'starred' ? specialMailbox(boxes, 'flagged', a.id) : kind === 'drafts' ? specialMailbox(boxes, 'drafts', a.id) : (specialMailbox(boxes, 'archive', a.id) ?? specialMailbox(boxes, 'all', a.id)))
	.filter((b): b is Mailbox => !!b)

/** Where "archive" sends a mail: its own account's Archive folder, or Gmail's All Mail. Null if it is already there or the account has neither. */
export function archiveTarget(boxes: Mailbox[], mailboxId: number): Mailbox | null {
	const from = boxes.find((b) => b.databaseId === mailboxId)
	if (!from) return null
	const mine = boxes.filter((b) => b.accountId === from.accountId)
	const target = mine.find((b) => b.specialRole === 'archive') ?? mine.find((b) => b.specialRole === 'all')
	return target && target.databaseId !== mailboxId ? target : null
}

/** Name of the filter in use, for the list's empty state ("No message matches Curated here"). */
export function filterName(label: LabelFilter): string {
	if (label.category) return categoryLabels[label.category] ?? label.category
	if (label.curated) return 'Curated'
	if (label.needsAction) return 'Needs action'
	return 'All'
}

const FILTER_KEY = 'wavium.mail.filter'
type Store = Pick<Storage, 'getItem' | 'setItem'>
const store = (): Store | null => {
	try { return globalThis.localStorage ?? null } catch { return null }
}
/**
 * The filter chip last used, per device: coming back to Mail should land where
 * you left it, not always on Curated. Anything unreadable means Curated.
 */
export function readFilter(from: Store | null = store()): LabelFilter {
	try {
		const raw = from?.getItem(FILTER_KEY)
		if (!raw) return { ...defaultLabel }
		const v = JSON.parse(raw) as Partial<LabelFilter>
		return {
			category: typeof v.category === 'string' && filterCategories.includes(v.category) ? v.category : '',
			needsAction: v.needsAction === true,
			curated: v.curated === true,
		}
	} catch {
		return { ...defaultLabel }
	}
}
export function writeFilter(label: LabelFilter, to: Store | null = store()): void {
	try { to?.setItem(FILTER_KEY, JSON.stringify(label)) } catch { /* private mode, full quota: the filter just is not remembered */ }
}
