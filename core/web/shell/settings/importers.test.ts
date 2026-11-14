// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import '../../testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { fakeServer, type FakeServer } from '../../testing/fakeServer'
import { importIcs, importVcf, safeName, splitIcs, splitVcf, subscribe } from './importers'

const ICS = [
	'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
	'BEGIN:VTIMEZONE', 'TZID:Europe/Paris', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE',
	'BEGIN:VTIMEZONE', 'TZID:America/New_York', 'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD', 'END:VTIMEZONE',
	'BEGIN:VEVENT', 'UID:abc123@google.com', 'DTSTART;TZID=Europe/Paris:20261120T100000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Sport', 'END:VEVENT',
	'BEGIN:VEVENT', 'UID:abc123@google.com', 'RECURRENCE-ID;TZID=Europe/Paris:20261127T100000', 'DTSTART;TZID=Europe/Paris:20261127T110000', 'SUMMARY:Sport (moved)', 'END:VEVENT',
	'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261224', 'SUMMARY:No UID', 'END:VEVENT',
	'END:VCALENDAR', '',
].join('\r\n')

test('ics: one object per UID, overrides kept together, only the zones used, a UID added when missing', () => {
	const objs = splitIcs(ICS)
	expect(objs).toHaveLength(2)
	const sport = objs.find((o) => o.uid === 'abc123@google.com')!
	expect(sport.ics.match(/BEGIN:VEVENT/g)).toHaveLength(2)
	expect(sport.ics).toContain('TZID:Europe/Paris')
	expect(sport.ics).not.toContain('America/New_York')
	expect(sport.ics).toContain('PRODID:-//Wavium//Import//EN')
	const other = objs.find((o) => o.uid !== 'abc123@google.com')!
	expect(other.ics).toContain(`UID:${other.uid}`)
	expect(other.ics).not.toContain('VTIMEZONE')
	expect(splitIcs('not a calendar')).toEqual([])
	expect(safeName('abc123@google.com')).toBe('abc123_google.com')
})

test('vcf: each card, CRLF, a UID added when the export has none', () => {
	const cards = splitVcf('BEGIN:VCARD\nVERSION:3.0\nFN:Ann\nUID:u-1\nEND:VCARD\nBEGIN:VCARD\nVERSION:3.0\nFN:Bob\nEND:VCARD\n')
	expect(cards.map((c) => c.uid)[0]).toBe('u-1')
	expect(cards[1].vcf).toMatch(/UID:wavium-import-2-.+\r\nEND:VCARD$/)
	expect(cards[0].vcf).toContain('\r\nFN:Ann\r\n')
})

let server: FakeServer
beforeEach(() => { server = fakeServer() })
afterEach(() => server.restore())

test('import: PUT with If-None-Match, an existing item is skipped (412), never overwritten', async () => {
	const T = '/remote.php/dav/calendars/alice/personal/'
	server.on('PUT', /^\/remote\.php\/dav\/calendars\/alice\/personal\/wavium-import-.+\.ics$/, () => new Response(null, { status: 201 }))
		.on('PUT', `${T}abc123_google.com.ics`, () => new Response(null, { status: 412 }))
	const r = await importIcs(T, ICS)
	expect(r).toEqual({ added: 1, skipped: 1, failed: 0 })
	const put = server.calls('PUT')[0]
	expect(put.headers.get('if-none-match')).toBe('*')
	expect(put.headers.get('content-type')).toContain('text/calendar')
})

test('vcf import into an address book; broken server answers count as failed', async () => {
	const B = '/remote.php/dav/addressbooks/users/alice/contacts/'
	// The fake server tries the routes added last first.
	server.on('PUT', /\.vcf$/, () => new Response(null, { status: 500 })).on('PUT', `${B}u-1.vcf`, () => new Response(null, { status: 201 }))
	expect(await importVcf(B, 'BEGIN:VCARD\nFN:Ann\nUID:u-1\nEND:VCARD\nBEGIN:VCARD\nFN:Bob\nEND:VCARD')).toEqual({ added: 1, skipped: 0, failed: 1 })
})

test('subscribe: webcal:// becomes https://, anything else is refused', async () => {
	server.on('MKCOL', /^\/remote\.php\/dav\/calendars\/alice\/sub-.+\/$/, () => new Response(null, { status: 201 }))
	await subscribe('alice', 'webcal://calendar.google.com/calendar/ical/x/basic.ics', 'Google Calendar')
	expect(String(server.calls('MKCOL')[0].body)).toContain('<cs:source><d:href>https://calendar.google.com/calendar/ical/x/basic.ics</d:href></cs:source>')
	await expect(subscribe('alice', 'http://insecure.test/x.ics', 'x')).rejects.toThrow('https://')
})
