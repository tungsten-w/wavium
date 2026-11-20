// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import { route } from './routes'

const files = new Set(['/index.php', '/remote.php', '/status.php', '/ocs/v2.php', '/ocs/v1.php', '/public.php',
	'/ocs-provider/index.php', '/core/js/main.js', '/robots.txt', '/dist/core-main.js', '/.well-known/acme-challenge/x'])
const fs = { isFile: async (p: string) => files.has(p) }
const r = (p: string, ua = '') => route(p, ua, fs)

test('DAV and well-known', async () => {
	expect(await r('/.well-known/caldav')).toEqual({ kind: 'redirect', status: 301, location: '/remote.php/dav/' })
	expect(await r('/.well-known/carddav')).toEqual({ kind: 'redirect', status: 301, location: '/remote.php/dav/' })
	expect(await r('/.well-known/webfinger')).toEqual({ kind: 'php', script: '/index.php', pathInfo: '/.well-known/webfinger' })
	expect(await r('/.well-known/acme-challenge/x')).toEqual({ kind: 'static', path: '/.well-known/acme-challenge/x' })
	expect(await r('/', 'Microsoft-WebDAV-MiniRedir DavClnt')).toEqual({ kind: 'redirect', status: 302, location: '/remote.php/webdav/' })
	expect(await r('/remote.php/dav/calendars/lia/personal/')).toEqual({ kind: 'php', script: '/remote.php', pathInfo: '/dav/calendars/lia/personal/' })
	expect(await r('/remote/webdav/x')).toEqual({ kind: 'php', script: '/remote.php', pathInfo: '/webdav/x' })
})

test('PHP entry points', async () => {
	expect(await r('/status.php')).toEqual({ kind: 'php', script: '/status.php', pathInfo: '' })
	expect(await r('/ocs/v2.php/cloud/capabilities')).toEqual({ kind: 'php', script: '/ocs/v2.php', pathInfo: '/cloud/capabilities' })
	expect(await r('/public.php/dav/files/tok')).toEqual({ kind: 'php', script: '/public.php', pathInfo: '/dav/files/tok' })
	expect(await r('/ocs-provider/')).toEqual({ kind: 'php', script: '/ocs-provider/index.php', pathInfo: '' })
	expect(await r('/index.php/login/v2')).toEqual({ kind: 'php', script: '/index.php', pathInfo: '/login/v2' })
	// Other PHP files never run directly.
	expect(await r('/core/templates/login.php')).toEqual({ kind: 'php', script: '/index.php', pathInfo: '/core/templates/login.php' })
})

test('front controller (pretty URLs)', async () => {
	expect(await r('/')).toEqual({ kind: 'php', script: '/index.php', pathInfo: '' })
	expect(await r('/login/v2/flow/abc')).toEqual({ kind: 'php', script: '/index.php', pathInfo: '/login/v2/flow/abc' })
	expect(await r('/s/AbCdEf')).toEqual({ kind: 'php', script: '/index.php', pathInfo: '/s/AbCdEf' })
	expect(await r('/apps/files/')).toEqual({ kind: 'php', script: '/index.php', pathInfo: '/apps/files/' })
	expect(await r('/ocm-provider/')).toEqual({ kind: 'php', script: '/index.php', pathInfo: '/ocm-provider/' })
})

test('static', async () => {
	expect(await r('/core/js/main.js')).toEqual({ kind: 'static', path: '/core/js/main.js' })
	expect((await r('/core/web/dist/shell.js')).kind).not.toBe('deny')
	expect((await r('/apps/messages/web/dist/index.js')).kind).not.toBe('deny')
	expect(await r('/robots.txt')).toEqual({ kind: 'static', path: '/robots.txt' })
})

test('denied', async () => {
	for (const p of ['/data/admin/files/x', '/config/config.php', '/lib/base.php', '/3rdparty/x', '/occ', '/.git/config',
		'/.htaccess', '/console.php', '/memory/INDEX.md', '/live/.env', '/todo.md', '/composer.json', '/build/x', '/templates',
		// v4 security check: sidecar sources, reports, UI sources and dependencies
		'/services/gmessages/go.mod', '/reports/V3.md', '/apps/messages/web/index.tsx', '/apps/messages/web/bun.lock', '/core/web/package.json',
		'/apps/notes/web/node_modules/@codemirror/state/package.json', '/custom_apps/x/web/api.ts', '/core/web/shell/Login.tsx']) {
		expect(await r(p)).toEqual({ kind: 'deny' })
	}
})

test('React shell pages', async () => {
	const { isShellPage } = await import('./routes')
	const doc = (p: string) => isShellPage(p, 'GET', 'document', 'text/html')
	expect(doc('/')).toBe(true)
	expect(doc('/login')).toBe(true)
	expect(doc('/apps/files/')).toBe(true)
	expect(doc('/apps/files/files/123')).toBe(true)
	expect(doc('/apps/daily_todo/')).toBe(true)
	expect(doc('/settings/user/security')).toBe(true)
	expect(doc('/settings/apps')).toBe(true)
	// classic flows and endpoints
	expect(doc('/login/v2/flow/abc')).toBe(false)
	expect(doc('/login/flow')).toBe(false)
	expect(doc('/login/challenge/totp')).toBe(false)
	expect(doc('/apps/oauth2/authorize')).toBe(false)
	expect(doc('/s/AbCdEf')).toBe(false)
	expect(doc('/lostpassword/reset/form/t/u')).toBe(false)
	expect(doc('/apps/files/ajax/download.php')).toBe(false)
	expect(doc('/apps/daily_todo/api/day/2026-11-01')).toBe(false)
	expect(doc('/apps/files_sharing/public/x')).toBe(false)
	expect(doc('/remote.php/dav/files/u/a.txt')).toBe(false)
	expect(doc('/status.php')).toBe(false)
	expect(doc('/core/img/logo.svg')).toBe(false)
	// not navigations
	expect(isShellPage('/apps/files/', 'GET', 'iframe', 'text/html')).toBe(false)
	expect(isShellPage('/apps/files/', 'GET', 'empty', '*/*')).toBe(false)
	expect(isShellPage('/apps/files/', 'POST', 'document', 'text/html')).toBe(false)
	expect(isShellPage('/apps/files/', 'GET', null, 'text/html,application/xhtml+xml')).toBe(true)
	expect(isShellPage('/apps/files/', 'GET', null, 'application/json')).toBe(false)
})
