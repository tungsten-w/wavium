// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tasks gaps (P4-3) against a fake CalDAV server: ticking a repeating task
// moves it to the next date (and keeps it open); repeat and manual order
// saved from the detail; sharing a list (who has it, add, change, remove).
// Components get their list directly (happy-dom cannot parse namespaced XML).
import '../../../core/web/testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { fakeServer, type FakeServer } from '../../../core/web/testing/fakeServer'
import { cleanup, click, getButton, getByText, getField, queryByText, render, type, waitFor } from '../../../core/web/testing/render'
import { toTask, updateTask, type Patch, type Task, type TaskList } from './api'
import { TaskDetail } from './Detail'
import { ShareDialog } from './Share'

const LIST: TaskList = { url: '/remote.php/dav/calendars/alice/tasks/', id: 'tasks', name: 'Tasks', color: '#0082c9', readOnly: false, shared: false, ctag: '1' }
const URL1 = `${LIST.url}t1.ics`
const vtodo = (extra: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VTODO\r\nUID:t1\r\nSUMMARY:Water the plants\r\nSTATUS:NEEDS-ACTION\r\n${extra}END:VTODO\r\nEND:VCALENDAR\r\n`
let server: FakeServer
let stored: string

beforeEach(() => {
	server = fakeServer()
	stored = ''
	server.on('PUT', URL1, (req) => { stored = String(req.body); return new Response(null, { status: 204, headers: { ETAG: '"e2"' } }) })
})
afterEach(() => { cleanup(); server.restore() })

test('ticking a repeating task moves its dates to the next occurrence and keeps it open', async () => {
	const today = new Date()
	const d = (n: number) => {
		const x = new Date(today.getFullYear(), today.getMonth(), today.getDate() + n)
		return `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`
	}
	const t = toTask(LIST, URL1, '"e1"', vtodo(`RRULE:FREQ=WEEKLY\r\nDTSTART;VALUE=DATE:${d(-1)}\r\nDUE;VALUE=DATE:${d(0)}\r\n`))!
	expect(t.repeat).toBe('WEEKLY')
	const n = await updateTask(t, { done: true })
	expect(server.calls('PUT', URL1)[0].headers.get('if-match')).toBe('"e1"')
	expect(n.done).toBe(false)
	const week = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7)
	expect(n.due!.date).toEqual(week)
	expect(n.start!.date).toEqual(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 6))
	expect(stored).toContain('STATUS:NEEDS-ACTION')
	expect(stored).not.toContain('COMPLETED:')
	// No date: nothing to move, it is completed.
	const plain = toTask(LIST, URL1, '"e2"', vtodo('RRULE:FREQ=DAILY\r\n'))!
	expect((await updateTask(plain, { done: true })).done).toBe(true)
	// Custom rule: completed as before (not guessed).
	const custom = toTask(LIST, URL1, '"e3"', vtodo(`RRULE:FREQ=WEEKLY;BYDAY=MO\r\nDUE;VALUE=DATE:${d(0)}\r\n`))!
	expect(custom.repeat).toBe('custom')
	expect((await updateTask(custom, { done: true })).done).toBe(true)
})

test('repeat and sort order are written; "none" removes the rule', async () => {
	const t = toTask(LIST, URL1, '"e1"', vtodo(''))!
	const r = await updateTask(t, { repeat: 'MONTHLY', sortOrder: 20 })
	expect(stored).toContain('RRULE:FREQ=MONTHLY')
	expect(stored).toContain('X-APPLE-SORT-ORDER:20')
	expect(r).toMatchObject({ repeat: 'MONTHLY', sortOrder: 20 })
	await updateTask(r, { repeat: 'none', sortOrder: null })
	expect(stored).not.toContain('RRULE')
	expect(stored).not.toContain('X-APPLE-SORT-ORDER')
})

test('detail: repeat select and move up / down', async () => {
	const patches: Patch[] = []
	const moves: number[] = []
	const t = toTask(LIST, URL1, '"e1"', vtodo('RRULE:FREQ=WEEKLY;BYDAY=MO\r\n'))!
	const { container } = await render(<TaskDetail task={t} lists={[LIST]} children_={[]} onPatch={async (_t: Task, p: Patch) => { patches.push(p); return null }}
		onReplace={() => {}} onAddSub={() => {}} onDelete={() => {}} onClose={() => {}} onOpen={() => {}} onMove={(_t, dir) => moves.push(dir)} />)
	expect((getField(container, 'Repeat') as HTMLSelectElement).value).toBe('custom')
	expect(getByText(container, /Give it a due date/)).toBeTruthy()
	await type(getField(container, 'Repeat'), 'DAILY')
	expect(patches).toEqual([{ repeat: 'DAILY' }])
	await click(getButton(container, 'Task actions'))
	await click(getByText(document.body, 'Move down'))
	await click(getButton(container, 'Task actions'))
	await click(getByText(document.body, 'Move up'))
	expect(moves).toEqual([1, -1])
})

test('share a list: current shares, add someone, change access, remove', async () => {
	let invite = `<oc:user><d:href>principal:principals/users/bob</d:href><oc:common-name>Bob</oc:common-name><oc:access><oc:read/></oc:access></oc:user>`
	server.on('PROPFIND', LIST.url, () => new Response(`<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:propstat><d:prop><oc:invite>${invite}</oc:invite></d:prop></d:propstat></d:response></d:multistatus>`, { status: 207 }))
	server.on('POST', LIST.url, () => new Response(null, { status: 200 }))
	server.on('GET', '/ocs/v2.php/apps/files_sharing/api/v1/sharees', (req) => ({ ocs: { data: {
		exact: { users: [], groups: [] },
		users: req.query.get('search') === 'car' ? [{ label: 'Carol', value: { shareType: 0, shareWith: 'carol' } }] : [],
		groups: req.query.get('search') === 'car' ? [{ label: 'Cars club', value: { shareType: 1, shareWith: 'cars' } }] : [],
	} } }))
	const { container } = await render(<ShareDialog list={LIST} onClose={() => {}} />)
	await waitFor(() => getByText(document.body, 'Bob'))
	const bob = document.querySelector('[data-sharee="user/bob"]')!
	expect((getField(bob as HTMLElement, 'Access') as HTMLSelectElement).value).toBe('read')

	await type(getField(document.body, 'Share with a person or group'), 'car')
	await waitFor(() => getByText(document.body, 'Cars club (group)'))
	invite += `<oc:user><d:href>principal:principals/users/carol</d:href><oc:common-name>Carol</oc:common-name><oc:access><oc:read/></oc:access></oc:user>`
	await click(getByText(document.body, 'Carol'))
	await waitFor(() => server.calls('POST', LIST.url).length === 1 || null)
	expect(String(server.calls('POST', LIST.url)[0].body)).toContain('<o:set><d:href>principal:principals/users/carol</d:href></o:set>')
	await waitFor(() => document.querySelector('[data-sharee="user/carol"]'))

	await type(getField(bob as HTMLElement, 'Access'), 'edit')
	await waitFor(() => server.calls('POST', LIST.url).length === 2 || null)
	expect(String(server.calls('POST', LIST.url)[1].body)).toContain('<d:href>principal:principals/users/bob</d:href><o:read-write/>')

	await click(getButton(document.body, 'Stop sharing with Bob'))
	await waitFor(() => server.calls('POST', LIST.url).length === 3 || null)
	expect(String(server.calls('POST', LIST.url)[2].body)).toContain('<o:remove><d:href>principal:principals/users/bob</d:href></o:remove>')
	expect(queryByText(container, 'Not shared yet.')).toBeNull()
})
