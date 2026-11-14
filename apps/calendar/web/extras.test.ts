// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Calendar gaps (P4-2), pure parts: classic event links, guests in and out of
// iCalendar, my answer, feed URLs, appointment hours.
import { expect, test } from 'vitest'
import { parseComponent, serializeComponent } from '@atrium/sdk'
import { applyPeople, appointmentPayload, availabilityOf, feedUrl, isOrganizer, myAttendance, parseEditPath, peopleOf, setMyAnswer, subscriptionBody } from './extras'

const b64 = (s: string) => btoa(s)
const OBJ = '/remote.php/dav/calendars/alice/personal/abc-123.ics'

test('classic event links: both forms, "next", bad input refused', () => {
	expect(parseEditPath(['edit', b64(OBJ)])).toEqual({ url: OBJ, recurrence: null })
	expect(parseEditPath(['edit', encodeURIComponent(b64(OBJ)), '1794600000'])).toEqual({ url: OBJ, recurrence: '1794600000' })
	expect(parseEditPath(['timeGridWeek', 'now', 'edit', 'popover', b64(OBJ), 'next'])).toEqual({ url: OBJ, recurrence: null })
	expect(parseEditPath(['dayGridMonth', '2026-11-13'])).toBeNull()
	expect(parseEditPath(['edit', '%%%'])).toBeNull()
	expect(parseEditPath(['edit', b64('/remote.php/dav/files/alice/secret.txt')])).toBeNull()
	expect(parseEditPath(['edit', b64('/remote.php/dav/calendars/alice/../bob/x.ics')])).toBeNull()
})

const VEV = (extra: string) => parseComponent(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:u1\r\nSUMMARY:Meet\r\nDTSTART:20261120T090000Z\r\nDTEND:20261120T100000Z\r\n${extra}END:VEVENT\r\nEND:VCALENDAR`)
const ev = (root: ReturnType<typeof parseComponent>) => root.children.find((c) => c.name === 'VEVENT')!

test('guests: read, written with me as organizer and RSVP; removed entirely when none', () => {
	const root = VEV('')
	const e = ev(root)
	expect(peopleOf(e)).toEqual({ organizer: null, attendees: [] })
	applyPeople(e, { organizer: null, attendees: [{ email: 'bob@example.org', name: 'Bob', partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT' }] }, { email: 'alice@atrium.test', name: 'Alice' })
	const text = serializeComponent(root).replace(/\r\n /g, '')
	expect(text).toContain('ORGANIZER;CN=Alice:mailto:alice@atrium.test')
	expect(text).toMatch(/ATTENDEE;[^\r\n]*PARTSTAT=NEEDS-ACTION[^\r\n]*RSVP=TRUE[^\r\n]*:mailto:bob@example.org/)
	const back = peopleOf(ev(parseComponent(text)))
	expect(back).toEqual({ organizer: { email: 'alice@atrium.test', name: 'Alice' }, attendees: [{ email: 'bob@example.org', name: 'Bob', partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT' }] })
	expect(isOrganizer(back, 'ALICE@atrium.test')).toBe(true)
	expect(isOrganizer(back, 'bob@example.org')).toBe(false)
	applyPeople(e, { ...back, attendees: [] }, { email: 'alice@atrium.test', name: 'Alice' })
	expect(serializeComponent(root)).not.toMatch(/ATTENDEE|ORGANIZER/)
})

test('my answer changes only my own line', () => {
	const root = VEV('ORGANIZER;CN=Bob:mailto:bob@example.org\r\nATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alice@atrium.test\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:carol@example.org\r\n')
	const e = ev(root)
	expect(myAttendance(peopleOf(e), 'alice@atrium.test')?.partstat).toBe('NEEDS-ACTION')
	expect(setMyAnswer(e, 'Alice@Atrium.test', 'ACCEPTED')).toBe(true)
	const p = peopleOf(e)
	expect(p.attendees.map((a) => [a.email, a.partstat])).toEqual([['alice@atrium.test', 'ACCEPTED'], ['carol@example.org', 'ACCEPTED']])
	expect(serializeComponent(root).replace(/\r\n /g, '')).not.toMatch(/RSVP=TRUE[^\r\n]*alice/)
	expect(setMyAnswer(e, 'dave@example.org', 'DECLINED')).toBe(false)
})

test('feed URLs and the subscription body', () => {
	expect(feedUrl(' webcal://example.org/cal.ics ')).toBe('https://example.org/cal.ics')
	expect(feedUrl('https://example.org/a?b=1')).toBe('https://example.org/a?b=1')
	expect(feedUrl('ftp://example.org/x')).toBeNull()
	expect(feedUrl('not a url')).toBeNull()
	const body = subscriptionBody('https://example.org/a?b=1&c=2', 'Holidays <FR>', '#e8710a')
	expect(body).toContain('<cs:subscribed/>')
	expect(body).toContain('<cs:source><d:href>https://example.org/a?b=1&amp;c=2</d:href></cs:source>')
	expect(body).toContain('Holidays &lt;FR&gt;')
})

test('appointment hours: chosen days only, local times of day, lengths in seconds', () => {
	const a = availabilityOf({ days: ['MO', 'WE'], from: '09:30', to: '12:00' }, 'Europe/Paris')
	expect(a.timezoneId).toBe('Europe/Paris')
	expect(a.slots.TU).toEqual([])
	expect(a.slots.SU).toEqual([])
	const [slot] = a.slots.MO
	expect(new Date(slot.start * 1000).getHours()).toBe(9)
	expect(new Date(slot.start * 1000).getMinutes()).toBe(30)
	expect((slot.end - slot.start) / 60).toBe(150)
	const p = appointmentPayload({ name: ' Call ', description: '', location: '', visibility: 'PRIVATE', calendar: 'personal', length: 30, days: ['FR'], from: '14:00', to: '16:00' }, 'UTC')
	expect(p).toMatchObject({ name: 'Call', location: null, length: 1800, increment: 1800, targetCalendarUri: 'personal', calendarFreeBusyUris: ['personal'], visibility: 'PRIVATE' })
	expect(Object.keys(p.availability.slots).sort()).toEqual(['FR', 'MO', 'SA', 'SU', 'TH', 'TU', 'WE'])
})
