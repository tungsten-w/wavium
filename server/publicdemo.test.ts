// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import { demoInfo, demoRefusal, loadPublicDemo, refusalResponse } from './publicdemo'

const on = loadPublicDemo({ ATRIUM_PUBLIC_DEMO: '1' })
const off = loadPublicDemo({})

test('off by default: nothing refused, the UI only learns "enabled: false"', () => {
	expect(off.enabled).toBe(false)
	expect(demoRefusal(off, 'POST', '/settings/personal/changepassword')).toBeNull()
	expect(demoInfo(off)).toEqual({ enabled: false })
})

test('on: defaults for feedback, reset time and the shared accounts', () => {
	expect(on.feedbackUrl).toBe('https://github.com/tungsten-w/wavium/issues/new/choose')
	expect(on.resetAt).toBe('04:00')
	expect(on.accounts).toEqual([
		{ user: 'alice', password: 'alice-demo-pass', label: 'Alice' },
		{ user: 'bob', password: 'bob-demo-pass', label: 'Bob' },
	])
	// Compose passes unset variables as empty strings.
	expect(loadPublicDemo({ ATRIUM_PUBLIC_DEMO: '1', ATRIUM_DEMO_ACCOUNTS: '', ATRIUM_FEEDBACK_URL: '' })).toEqual(on)
	const custom = loadPublicDemo({ ATRIUM_PUBLIC_DEMO: '1', ATRIUM_DEMO_ACCOUNTS: 'eve:pw, broken', ATRIUM_DEMO_RESET_AT: '3h', ATRIUM_FEEDBACK_URL: 'https://example.org/f' })
	expect(custom.accounts).toEqual([{ user: 'eve', password: 'pw', label: 'eve' }])
	expect(custom.resetAt).toBe('04:00')
	expect(loadPublicDemo({ ATRIUM_PUBLIC_DEMO: '1', ATRIUM_DEMO_RESET_AT: '03:30 Paris time' }).resetAt).toBe('03:30 Paris time')
	expect(custom.feedbackUrl).toBe('https://example.org/f')
})

test('on: refuses what would lock others out or reach other servers', () => {
	const refused: Array<[string, string]> = [
		['POST', '/settings/personal/changepassword'],
		['POST', '/index.php/settings/personal/changepassword'],
		['POST', '/index.php/lostpassword/email'],
		['POST', '/lostpassword/set/abc/alice'],
		['PUT', '/index.php/settings/users/alice/settings'],
		['PUT', '/ocs/v2.php/cloud/users/alice'],
		['POST', '/ocs/v1.php/cloud/users'],
		['POST', '/ocs/v2.php/cloud/groups/admin/users'],
		['POST', '/index.php/apps/mail/api/accounts'],
		['PUT', '/apps/mail/api/accounts/1'],
		['DELETE', '/index.php/apps/mail/api/accounts/1/'],
		['PUT', '/index.php/apps/mail/api/sieve/account/1'],
		['POST', '/index.php/apps/twofactor_totp/settings/enable'],
	]
	for (const [m, p] of refused) expect([m, p, demoRefusal(on, m, p)]).toEqual([m, p, expect.any(String)])
})

test('on: the rest of the demo works (reading, mail, calendar, files, agents)', () => {
	const allowed: Array<[string, string]> = [
		['GET', '/ocs/v2.php/cloud/users/alice'],
		['GET', '/index.php/apps/mail/api/accounts'],
		['PATCH', '/index.php/apps/mail/api/accounts/1'],
		['PUT', '/index.php/apps/mail/api/accounts/1/signature'],
		['POST', '/index.php/apps/mail/api/messages/send'],
		['POST', '/login'],
		['PUT', '/remote.php/dav/files/alice/notes.txt'],
		['POST', '/agent/v1/owner/agents'],
		['GET', '/settings/user/ai'],
	]
	for (const [m, p] of allowed) expect([m, p, demoRefusal(on, m, p)]).toEqual([m, p, null])
})

test('refusals speak OCS to OCS clients and JSON to the rest', async () => {
	const ocs = refusalResponse('/ocs/v2.php/cloud/users/alice', 'no')
	expect(ocs.status).toBe(403)
	expect(await ocs.json()).toMatchObject({ ocs: { meta: { statuscode: 403, message: 'no' } } })
	const mail = refusalResponse('/index.php/apps/mail/api/accounts', 'no')
	expect(await mail.json()).toMatchObject({ message: 'no', error: { code: 'public_demo' } })
})
