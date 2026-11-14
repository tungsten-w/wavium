// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tasks gaps (P4-3), pure parts: repeat rules, next due date, manual order,
// CalDAV sharing bodies and the invite list.
import { expect, test } from 'vitest'
import { nextDue, reorder, repeatOf, sortKey, step } from './recur'
import { parseInvite, shareBody, unshareBody } from './sharing'

test('repeat of an RRULE: simple frequencies, everything else is custom', () => {
	expect(repeatOf(undefined)).toBe('none')
	expect(repeatOf('FREQ=WEEKLY')).toBe('WEEKLY')
	expect(repeatOf('FREQ=MONTHLY;INTERVAL=1')).toBe('MONTHLY')
	expect(repeatOf('FREQ=WEEKLY;BYDAY=MO,WE')).toBe('custom')
	expect(repeatOf('FREQ=DAILY;INTERVAL=2')).toBe('custom')
})

test('steps keep the time and the day of month when they can', () => {
	expect(step(new Date(2026, 0, 31, 9, 30), 'MONTHLY')).toEqual(new Date(2026, 1, 28, 9, 30))
	expect(step(new Date(2028, 1, 29), 'YEARLY')).toEqual(new Date(2029, 1, 28))
	expect(step(new Date(2026, 11, 29), 'WEEKLY')).toEqual(new Date(2027, 0, 5))
	expect(step(new Date(2026, 0, 31), 'MONTHLY', 2)).toEqual(new Date(2026, 2, 31))
})

test('next due: after today, at least one step', () => {
	const now = new Date(2026, 10, 13, 15)
	expect(nextDue(new Date(2026, 10, 13), 'DAILY', now)).toEqual(new Date(2026, 10, 14))
	expect(nextDue(new Date(2026, 10, 1), 'WEEKLY', now)).toEqual(new Date(2026, 10, 15))
	// A step landing on today is today's occurrence, the one being ticked: go one further.
	expect(nextDue(new Date(2026, 10, 6), 'WEEKLY', now)).toEqual(new Date(2026, 10, 20))
	expect(nextDue(new Date(2026, 10, 20), 'MONTHLY', now)).toEqual(new Date(2026, 11, 20))
	// Counted from the stored date: a task due on the 31st stays at the month's end, not on the 28th.
	expect(nextDue(new Date(2025, 0, 31, 8), 'MONTHLY', now)).toEqual(new Date(2026, 10, 30, 8))
	expect(nextDue(new Date(2026, 9, 31), 'MONTHLY', new Date(2026, 11, 1))).toEqual(new Date(2026, 11, 31))
})

test('reorder: before a sibling, to the end, only changed values written', () => {
	const t = (url: string, sortOrder: number | null) => ({ url, sortOrder })
	const a = t('a', 10), b = t('b', 20), c = t('c', 30)
	expect(reorder([a, b, c], c, a).map((x) => [x.task.url, x.sortOrder])).toEqual([['c', 10], ['a', 20], ['b', 30]])
	expect(reorder([a, b, c], a, null).map((x) => [x.task.url, x.sortOrder])).toEqual([['b', 10], ['c', 20], ['a', 30]])
	expect(reorder([a, b, c], b, c)).toEqual([])
	const n = t('n', null)
	expect(reorder([a, n], n, a).map((x) => [x.task.url, x.sortOrder])).toEqual([['n', 10], ['a', 20]])
	expect(sortKey(null)).toBe(Infinity)
})

test('CalDAV sharing: bodies, and the invite list read back', () => {
	expect(shareBody({ kind: 'user', id: 'bob', edit: true })).toContain('<o:set><d:href>principal:principals/users/bob</d:href><o:read-write/></o:set>')
	expect(shareBody({ kind: 'group', id: 'team a&b', edit: false })).toContain('<d:href>principal:principals/groups/team%20a%26b</d:href></o:set>')
	expect(unshareBody({ kind: 'user', id: 'bob' })).toContain('<o:remove><d:href>principal:principals/users/bob</d:href></o:remove>')
	const xml = `<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:propstat><d:prop><oc:invite>`
		+ `<oc:user><d:href>principal:principals/users/bob</d:href><oc:common-name>Bob Durand</oc:common-name><oc:invite-accepted/><oc:access><oc:read-write/></oc:access></oc:user>`
		+ `<oc:user><d:href>principal:principals/groups/family</d:href><oc:common-name>family</oc:common-name><oc:invite-accepted/><oc:access><oc:read/></oc:access></oc:user>`
		+ `<oc:user><d:href>mailto:x@example.org</d:href></oc:user>`
		+ `</oc:invite></d:prop></d:propstat></d:response></d:multistatus>`
	expect(parseInvite(xml)).toEqual([
		{ kind: 'user', id: 'bob', name: 'Bob Durand', edit: true },
		{ kind: 'group', id: 'family', name: 'family', edit: false },
	])
	expect(parseInvite('<x:user xmlns:x="http://owncloud.org/ns"><y:href xmlns:y="DAV:">principal:principals/users/c%20d</y:href></x:user>')).toEqual([{ kind: 'user', id: 'c d', name: 'c d', edit: false }])
})
