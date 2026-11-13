// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Calendar gaps (P4-2) in the app, against a fake CalDAV server: a classic
// event link opens the event; inviting a guest writes ORGANIZER + ATTENDEE;
// an invitation from someone else is read-only with Accept / Maybe / Decline;
// subscribing makes a cs:subscribed collection; appointment pages are listed,
// created and deleted.
import '../../../core/web/testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Session } from '@atrium/sdk'
import { fakeServer, type FakeServer } from '../../../core/web/testing/fakeServer'
import { cleanup, click, getButton, getByText, getField, queryByText, renderApp, type, waitFor } from '../../../core/web/testing/render'
import CalendarApp from './index'
import { Appointments } from './Appointments'
import { EventDialog } from './EventDialog'
import { instanceAt } from './extras'
import type { Cal } from './api'

// happy-dom's DOMParser does not handle XML namespaces, so CalDAV listings
// (multistatus) cannot be faked: the dialog and the appointments list get
// their calendars directly; objects (GET/PUT) and MKCOL go through the fake
// server. The route itself (link -> dialog) is checked in the browser.
const PERSONAL: Cal = { url: '/remote.php/dav/calendars/alice/personal/', id: 'personal', name: 'Personal', color: '#0082c9', readOnly: false, shared: false, sub: false, ctag: '1' }

const session = { user: { id: 'alice', displayName: 'Alice', email: 'alice@atrium.test', isAdmin: false } } as unknown as Session
const HOME = '/remote.php/dav/calendars/alice/'
const OBJ = `${HOME}personal/ev1.ics`
let server: FakeServer
let ics: string
let appointments: Array<Record<string, unknown>>

const event = (extra = '') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:ev1\r\nSUMMARY:Project meeting\r\nDTSTART:20261120T090000Z\r\nDTEND:20261120T100000Z\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`

beforeEach(() => {
	server = fakeServer()
	ics = event()
	appointments = [{ id: 7, token: 'tok7', name: 'Office hours', description: '', location: null, visibility: 'PUBLIC', targetCalendarUri: 'personal', length: 1800, increment: 1800, availability: null }]
	server.on('GET', OBJ, () => new Response(ics, { headers: { ETAG: '"e1"', 'Content-Type': 'text/calendar' } }))
	server.on('PUT', OBJ, (req) => { ics = String(req.body); return new Response(null, { status: 204, headers: { ETAG: '"e2"' } }) })
	server.on('GET', '/index.php/apps/calendar/v1/appointment_configs', () => ({ status: 'success', data: appointments }))
})
afterEach(() => { cleanup(); server.restore() })

const open = (path: string) => renderApp('calendar', CalendarApp.Component!, path, { session })
const dlg = () => document.querySelector('.cal-dlg') as HTMLElement

async function openEvent() {
	const inst = await instanceAt({ url: OBJ, recurrence: null }, [PERSONAL])
	expect(inst).toMatchObject({ title: 'Project meeting', cal: { id: 'personal' }, recurrenceId: null })
	const Dlg = () => <EventDialog draft={{ inst: inst! }} calendars={[PERSONAL]} defaultCal={PERSONAL} onClose={() => {}} onChanged={() => {}} />
	await renderApp('calendar', Dlg, '/timeGridWeek/now', { session })
	await waitFor(() => dlg() && (getField(dlg(), 'Title') as HTMLInputElement).value === 'Project meeting' ? true : null)
}

test('a classic event link resolves to the stored event (and an occurrence of a series)', async () => {
	expect(await instanceAt({ url: '/remote.php/dav/calendars/alice/other/x.ics', recurrence: null }, [PERSONAL])).toBeNull()
	ics = event('RRULE:FREQ=WEEKLY\r\n')
	const occ = await instanceAt({ url: OBJ, recurrence: String(Date.UTC(2026, 10, 27, 9) / 1000) }, [PERSONAL])
	expect(occ).toMatchObject({ recurrenceId: '20261127T090000Z' })
	expect(occ!.end.getTime() - occ!.start.getTime()).toBe(3600000)
})

test('inviting a guest makes me the organizer and writes the attendee', async () => {
	await openEvent()
	await type(getField(dlg(), 'Invite by email'), 'not-an-email')
	await click(getButton(dlg(), 'Invite'))
	expect(queryByText(dlg(), 'not-an-email')).toBeNull()
	await type(getField(dlg(), 'Invite by email'), 'bob@example.org')
	await click(getButton(dlg(), 'Invite'))
	expect(getByText(dlg(), 'bob@example.org')).toBeTruthy()
	expect(getByText(dlg(), 'No answer yet')).toBeTruthy()
	expect(getByText(dlg(), /Guests get an invitation by email/)).toBeTruthy()
	await click(getButton(document.body, 'Save'))
	await waitFor(() => server.calls('PUT', OBJ).length === 1 || null)
	const put = server.calls('PUT', OBJ)[0]
	expect(put.headers.get('if-match')).toBe('"e1"')
	expect(ics.replace(/\r\n /g, '')).toContain('ORGANIZER;CN=Alice:mailto:alice@atrium.test')
	expect(ics.replace(/\r\n /g, '')).toMatch(/ATTENDEE;[^\r\n]*RSVP=TRUE[^\r\n]*:mailto:bob@example.org/)
})

test('an invitation from someone else: read-only, and my answer is saved', async () => {
	ics = event('ORGANIZER;CN=Bob:mailto:bob@example.org\r\nATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alice@atrium.test\r\nATTENDEE;CN=Carol;PARTSTAT=ACCEPTED:mailto:carol@example.org\r\n')
	await openEvent()
	await waitFor(() => dlg() && getByText(dlg(), /Invitation from Bob/))
	expect(getByText(dlg(), /your answer: No answer yet/)).toBeTruthy()
	expect(getByText(dlg(), 'Carol')).toBeTruthy()
	expect((getField(dlg(), 'Title') as HTMLInputElement).closest('fieldset')!.disabled).toBe(true)
	expect(queryByText(document.body, 'Save')).toBeNull()
	expect(queryByText(dlg(), 'Invite by email')).toBeNull()
	await click(getButton(document.body, 'Accept'))
	await waitFor(() => server.calls('PUT', OBJ).length === 1 || null)
	expect(ics.replace(/\r\n /g, '')).toMatch(/ATTENDEE;PARTSTAT=ACCEPTED:mailto:alice@atrium.test/)
	expect(ics.replace(/\r\n /g, '')).toContain('ORGANIZER;CN=Bob:mailto:bob@example.org')
	expect(ics.replace(/\r\n /g, '')).toMatch(/ATTENDEE;CN=Carol;PARTSTAT=ACCEPTED:mailto:carol@example.org/)
})

test('subscribe to a calendar by URL', async () => {
	server.on('MKCOL', /^\/remote\.php\/dav\/calendars\/alice\/sub-[a-z0-9]+\/$/, () => new Response(null, { status: 201 }))
	const { container } = await open('/timeGridWeek/now')
	await waitFor(() => getByText(container, 'Subscribe to a calendar'))
	await click(getByText(container, 'Subscribe to a calendar').closest('button')!)
	await type(getField(document.body, 'Calendar address (https:// or webcal://)'), 'webcal://holidays.example/fr.ics')
	await click(getButton(document.body, 'Subscribe'))
	await waitFor(() => server.calls('MKCOL').length === 1 || null)
	const body = String(server.calls('MKCOL')[0].body)
	expect(body).toContain('<cs:source><d:href>https://holidays.example/fr.ics</d:href></cs:source>')
	expect(body).toContain('<d:displayname>holidays.example</d:displayname>')
})

test('appointment pages: listed, created with weekly hours, deleted', async () => {
	server.on('POST', '/index.php/apps/calendar/v1/appointment_configs', (req) => {
		const c = { id: 8, token: 'tok8', ...(req.body as object) }
		appointments = [...appointments, c]
		return { status: 'success', data: c }
	})
	server.on('DELETE', '/index.php/apps/calendar/v1/appointment_configs/7', () => { appointments = appointments.filter((a) => a.id !== 7); return { status: 'success', data: null } })
	const List = () => <Appointments calendars={[PERSONAL]} />
	const { container } = await renderApp('calendar', List, '/', { session })
	await waitFor(() => getByText(container, 'Office hours'))
	await click(getByText(container, 'New appointment page').closest('button')!)
	await type(getField(document.body, 'Name'), 'Intro call')
	await type(getField(document.body, 'Length'), '45')
	await click(getField(document.body, 'Sat'))
	await click(getButton(document.body, 'Create'))
	await waitFor(() => server.calls('POST', '/index.php/apps/calendar/v1/appointment_configs').length === 1 || null)
	const sent = server.calls('POST', '/index.php/apps/calendar/v1/appointment_configs')[0].body as { name: string, length: number, targetCalendarUri: string, availability: { slots: Record<string, unknown[]> } }
	expect(sent).toMatchObject({ name: 'Intro call', length: 2700, targetCalendarUri: 'personal' })
	expect(Object.entries(sent.availability.slots).filter(([, v]) => v.length).map(([k]) => k)).toEqual(['MO', 'TU', 'WE', 'TH', 'FR', 'SA'])
	await waitFor(() => getByText(container, 'Intro call'))

	await click(getButton(container, 'Delete Office hours'))
	await click(getButton(document.body, 'Delete'))
	await waitFor(() => (queryByText(container, 'Office hours') ? null : true))
})
