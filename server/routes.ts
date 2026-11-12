// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// URL rules, ported from Nextcloud's .htaccess (Setup::updateHtaccess) and its
// recommended nginx config. Pure function of the path, so it is unit-tested
// (routes.test.ts) without PHP.

export type Route =
	| { kind: 'redirect', status: number, location: string }
	| { kind: 'deny' }
	| { kind: 'static', path: string }
	| { kind: 'php', script: string, pathInfo: string }

export interface Fs {
	isFile(rel: string): Promise<boolean>
}

// Never served. Nextcloud's list plus repo-only dirs (dev containers serve the repo).
const DENY_DIRS = /^\/(?:build|tests|config|lib|3rdparty|templates|data|memory|docs|deploy|live|server|node_modules|vendor-bin|resources|__tests__|__mocks__)(?:$|\/)/
const DENY_PREFIX = /^\/(?:\.(?!well-known\/)|autotest|occ|issue|indie|db_|console)/
// Files PHP-FPM may run directly; any other *.php goes through index.php.
const PHP_ENTRY = /^\/(?:index|remote|public|cron|core\/ajax\/update|status|ocs\/v[12]|ocs-provider\/index|ocm-provider\/index)\.php$/
// Text files at the top of the repo that are not meant for the web.
const DENY_FILES = /^\/(?:[^/]+\.(?:md|json|lock|xml|yml|yaml|ts|js|cjs|mjs|nix|sh|dist)|Makefile|COPYING.*|AUTHORS|todo\.md)$/
const ALLOWED_TOP = new Set(['/robots.txt', '/index.html'])

const front = (pathInfo: string): Route => ({ kind: 'php', script: '/index.php', pathInfo })

export async function route(path: string, userAgent: string, fs: Fs): Promise<Route> {
	if (path === '/' && userAgent.includes('DavClnt')) {
		return { kind: 'redirect', status: 302, location: '/remote.php/webdav/' }
	}
	if (/^\/\.well-known\/(?:carddav|caldav)(?:$|\/)/.test(path)) {
		return { kind: 'redirect', status: 301, location: '/remote.php/dav/' }
	}
	if (path.startsWith('/.well-known/')) {
		if (/^\/\.well-known\/(?:acme-challenge|pki-validation)\//.test(path) && await fs.isFile(path)) {
			return { kind: 'static', path }
		}
		return front(path)
	}
	if (/^\/ocm-provider\/?$/.test(path)) return front(path)
	if (path.startsWith('/remote/')) return { kind: 'php', script: '/remote.php', pathInfo: path.slice('/remote'.length) }
	if (DENY_DIRS.test(path) || DENY_PREFIX.test(path)) return { kind: 'deny' }
	if (DENY_FILES.test(path) && !ALLOWED_TOP.has(path)) return { kind: 'deny' }

	const php = path.match(/^(.+?\.php)(\/.*)?$/)
	if (php) {
		const [, script, pathInfo = ''] = php
		if (PHP_ENTRY.test(script)) return { kind: 'php', script, pathInfo }
		// Unknown PHP file: hand the whole path to the front controller (it 404s).
		return front(path)
	}
	if (path === '/' || path === '') return front('')
	if (path.endsWith('/')) {
		if (await fs.isFile(path + 'index.php') && PHP_ENTRY.test(path + 'index.php')) {
			return { kind: 'php', script: path + 'index.php', pathInfo: '' }
		}
		if (await fs.isFile(path + 'index.html')) return { kind: 'static', path: path + 'index.html' }
		return front(path)
	}
	if (await fs.isFile(path)) return { kind: 'static', path }
	if (await fs.isFile(path + '/index.php') && PHP_ENTRY.test(path + '/index.php')) {
		return { kind: 'redirect', status: 301, location: path + '/' }
	}
	return front(path)
}

// ---------------------------------------------------------------- React shell

// Paths below /apps/<id>/ that are endpoints or files, never pages.
const APP_NON_PAGE = /^\/apps\/[^/]+\/(?:api|ajax|export|download|public|p|s|embed|img|css|js|l10n|templates|dist|web|preview|thumbnail|avatar)(?:\/|$)/
// Pages the classic backend must keep rendering (login flows, OAuth, 2FA, password reset).
const CLASSIC_PAGES = /^\/(?:apps\/oauth2|apps\/twofactor_[^/]+|login\/(?:v2|flow|challenge|selectchallenge|confirm)|lostpassword|s|f)(?:\/|$)/

/**
 * Whether a request is a page load the React shell answers (core/web/dist/index.html).
 * Only real navigations (Sec-Fetch-Dest: document, or no fetch metadata and an
 * HTML Accept) of shell-owned paths: /, /login, /apps/<id>/..., /settings/...
 * Frames (Sec-Fetch-Dest: iframe) still get the classic page.
 */
export function isShellPage(path: string, method: string, dest: string | null, accept: string | null): boolean {
	if (method !== 'GET' && method !== 'HEAD') return false
	if (dest !== null ? dest !== 'document' : !(accept ?? '').includes('text/html')) return false
	if (CLASSIC_PAGES.test(path) || APP_NON_PAGE.test(path)) return false
	const last = path.slice(path.lastIndexOf('/') + 1)
	if (last.includes('.')) return false
	return path === '/' || /^\/login\/?$/.test(path) || /^\/apps\/[^/]+(?:\/|$)/.test(path) || /^\/settings(?:\/|$)/.test(path)
}
