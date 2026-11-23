import { describe, expect, it } from 'vitest'
import { archiveTarget, filterName, kindBoxes, labelQuery, readFilter, sortBoxes, writeFilter } from './labels'
import { curatedTitle, DEFAULT_CURATED_HIDES, defaultLabel, noLabel, parseCuratedHides, searchFilter, type Account, type LabelFilter, type Mailbox } from './api'

const box = (databaseId: number, accountId: number, specialRole: string, name = specialRole): Mailbox =>
	({ databaseId, accountId, specialRole, name, delimiter: '/', displayName: name, id: name, attributes: [], specialUse: [] }) as unknown as Mailbox
const acct = (id: number): Account => ({ id, accountId: id, name: `a${id}`, emailAddress: `a${id}@x` }) as unknown as Account

describe('labelQuery: search words that mean a label', () => {
	it('reads category words in every spelling', () => {
		for (const q of ['category:ads', 'cat:ads', 'tag:ads', 'label:ads', 'CATEGORY:Ads', '  category:ads  ']) {
			expect(labelQuery(q)).toEqual({ ...noLabel, category: 'ads' })
		}
	})
	it('reads needs-action words, alone or with a category', () => {
		for (const q of ['needs:action', 'needs-action', 'is:action', 'action']) {
			expect(labelQuery(q)).toEqual({ ...noLabel, needsAction: true })
		}
		expect(labelQuery('category:orders action')).toEqual({ ...noLabel, category: 'orders', needsAction: true })
	})
	it('is plain text search when anything else is in the query', () => {
		expect(labelQuery('')).toBeNull()
		expect(labelQuery('   ')).toBeNull()
		expect(labelQuery('invoice')).toBeNull()
		expect(labelQuery('category:ads invoice')).toBeNull()
		expect(labelQuery('category:nonsense')).toBeNull()
		expect(labelQuery('category:ads category:work')).toBeNull()
	})
})

describe('kindBoxes: the merged Inbox / Archive / Favorites / Drafts views', () => {
	const accounts = [acct(1), acct(2)]
	const boxes = [
		box(10, 1, 'inbox'), box(11, 1, 'all', '[Gmail]/All Mail'), box(12, 1, 'flagged'), box(13, 1, 'drafts'),
		box(20, 2, 'inbox'), box(21, 2, 'archive'), box(22, 2, 'all', '[Gmail]/All Mail'),
	]
	it('takes one folder per account for the kind', () => {
		expect(kindBoxes('inbox', accounts, boxes).map((b) => b.databaseId)).toEqual([10, 20])
		expect(kindBoxes('starred', accounts, boxes).map((b) => b.databaseId)).toEqual([12])
		expect(kindBoxes('drafts', accounts, boxes).map((b) => b.databaseId)).toEqual([13])
	})
	it('uses All Mail as the archive only when the account has no Archive folder', () => {
		expect(kindBoxes('archive', accounts, boxes).map((b) => b.databaseId)).toEqual([11, 21])
	})
	it('skips accounts without that folder and handles no accounts', () => {
		expect(kindBoxes('starred', [acct(2)], boxes)).toEqual([])
		expect(kindBoxes('inbox', [], boxes)).toEqual([])
	})
})

describe('sortBoxes', () => {
	it('puts special folders first in a fixed order, then the rest alphabetically', () => {
		const list = [box(1, 1, '', 'Zeta'), box(2, 1, 'trash'), box(3, 1, '', 'alpha'), box(4, 1, 'sent'), box(5, 1, 'inbox'), box(6, 1, 'drafts')]
		expect(sortBoxes(list).map((b) => b.databaseId)).toEqual([5, 6, 4, 2, 3, 1])
	})
	it('does not change the list it is given', () => {
		const list = [box(1, 1, 'trash'), box(2, 1, 'inbox')]
		sortBoxes(list)
		expect(list.map((b) => b.databaseId)).toEqual([1, 2])
	})
})

describe('label defaults and search filter', () => {
	it('the default view is curated with no category', () => {
		expect(defaultLabel).toEqual({ category: '', needsAction: false, curated: true })
	})
	it('advanced filters pass through as typed, plain text becomes a multi-field search', () => {
		expect(searchFilter('')).toBe('')
		expect(searchFilter('  ')).toBe('')
		expect(searchFilter('from:anna is:unread')).toBe('from:anna is:unread')
		const plain = searchFilter('invoice')
		expect(plain).toContain('invoice')
		expect(plain).not.toBe('invoice')
	})
})

describe('archiveTarget', () => {
	const boxes = [box(1, 1, 'inbox'), box(2, 1, 'archive'), box(3, 2, 'inbox'), box(4, 2, 'all'), box(5, 3, 'inbox'), box(6, 2, 'archive')]
	it('uses the mail\'s own account, not the first archive folder', () => {
		expect(archiveTarget(boxes, 1)?.databaseId).toBe(2)
		expect(archiveTarget(boxes, 3)?.databaseId).toBe(6)
	})
	it('falls back to All Mail when there is no Archive folder', () => {
		expect(archiveTarget([box(3, 2, 'inbox'), box(4, 2, 'all')], 3)?.databaseId).toBe(4)
	})
	it('is null when already archived, unknown, or the account has neither', () => {
		expect(archiveTarget(boxes, 2)).toBeNull()
		expect(archiveTarget(boxes, 99)).toBeNull()
		expect(archiveTarget(boxes, 5)).toBeNull()
	})
})

describe('Curated setting (Mail preference curated-hides, also read by the agent layer)', () => {
	it('reads the stored list, keeping only known categories in filter order', () => {
		expect(parseCuratedHides('["spam","bogus","ads"]')).toEqual(['ads', 'spam'])
		expect(parseCuratedHides('[]')).toEqual([])
	})
	it('falls back to the default when nothing usable is stored', () => {
		for (const v of [null, undefined, '', 'nope', '{"a":1}', 42]) expect(parseCuratedHides(v)).toEqual(DEFAULT_CURATED_HIDES)
	})
	it('describes what Curated hides', () => {
		expect(curatedTitle(['ads', 'spam', 'social'])).toBe('Hides ads, spam and social')
		expect(curatedTitle(['spam'])).toBe('Hides spam')
		expect(curatedTitle([])).toBe('Shows every category')
	})
})

describe('the filter is remembered per device', () => {
	const fake = () => {
		const kept = new Map<string, string>()
		return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), kept }
	}

	it('comes back where you left it', () => {
		const store = fake()
		const chosen: LabelFilter = { ...noLabel, category: 'orders' }
		writeFilter(chosen, store)
		expect(readFilter(store)).toEqual(chosen)
		writeFilter(noLabel, store)
		expect(readFilter(store), 'All is a choice too, not "nothing stored"').toEqual(noLabel)
	})
	it('starts on Curated, and falls back to it on anything unreadable', () => {
		expect(readFilter(fake())).toEqual(defaultLabel)
		expect(readFilter(null)).toEqual(defaultLabel)
		for (const raw of ['', 'not json', '42', '{"curated":"yes"}']) {
			const store = fake()
			store.setItem('wavium.mail.filter', raw)
			const back = readFilter(store)
			expect(back.category).toBe('')
			expect(typeof back.curated).toBe('boolean')
		}
	})
	it('drops a category the classifier no longer has', () => {
		const store = fake()
		store.setItem('wavium.mail.filter', JSON.stringify({ category: 'receipts-of-1998', needsAction: true, curated: false }))
		expect(readFilter(store)).toEqual({ ...noLabel, needsAction: true })
	})
	it('survives a storage that refuses to write (private mode)', () => {
		const locked = { getItem: () => null, setItem: () => { throw new Error('quota') } }
		expect(() => writeFilter(defaultLabel, locked)).not.toThrow()
	})
})

describe('filterName: what the list says is filtering it', () => {
	it('names the chip in use, category first', () => {
		expect(filterName(defaultLabel)).toBe('Curated')
		expect(filterName({ ...noLabel, category: 'orders' })).toBe('Orders')
		expect(filterName({ ...noLabel, needsAction: true })).toBe('Needs action')
		expect(filterName({ ...defaultLabel, category: 'ads' })).toBe('Ads')
		expect(filterName(noLabel)).toBe('All')
	})
})
