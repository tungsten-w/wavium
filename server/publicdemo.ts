// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public demo mode (v3): ATRIUM_PUBLIC_DEMO=1 on an instance that strangers
// try with shared accounts and fake data (deploy/demo/). Two jobs:
//   - tell the UI (GET /core/web/dist/demo.json): banner, demo logins on the
//     login page, where to send feedback, when the data resets;
//   - refuse the requests that would let one visitor lock out the others or
//     make the server reach other machines: password and account changes, new
//     or edited mail accounts and Sieve servers. Webhooks are refused by the
//     agent layer (netguard), personal AI providers by the instance setting,
//     share links, federation, 2FA and external storage by deploy/demo/setup.sh.
// Off (the default), nothing here changes anything.

export interface PublicDemo {
	enabled: boolean
	/** Where the "Feedback" link goes. */
	feedbackUrl: string
	/** When the data goes back to the start ("04:00", "04:00 Paris time"). */
	resetAt: string
	/** Shared accounts shown on the login page. */
	accounts: Array<{ user: string, password: string, label: string }>
}

const DEFAULT_FEEDBACK = 'https://github.com/tungsten-w/wavium/issues/new/choose'

/** ATRIUM_DEMO_ACCOUNTS: "alice:alice-demo-pass:Alice,bob:bob-demo-pass:Bob". */
function parseAccounts(raw: string | undefined): PublicDemo['accounts'] {
	return (raw || 'alice:alice-demo-pass:Alice,bob:bob-demo-pass:Bob').split(',')
		.map((e) => e.trim().split(':'))
		.filter((p) => p.length >= 2 && p[0] && p[1])
		.map(([user, password, label]) => ({ user, password, label: label || user }))
}

export function loadPublicDemo(env: Record<string, string | undefined> = process.env): PublicDemo {
	const enabled = env.ATRIUM_PUBLIC_DEMO === '1'
	return {
		enabled,
		feedbackUrl: env.ATRIUM_FEEDBACK_URL || DEFAULT_FEEDBACK,
		resetAt: /^\d{2}:\d{2}( [\w ()/+-]{1,40})?$/.test(env.ATRIUM_DEMO_RESET_AT ?? '') ? env.ATRIUM_DEMO_RESET_AT! : '04:00',
		accounts: enabled ? parseAccounts(env.ATRIUM_DEMO_ACCOUNTS) : [],
	}
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** [method filter, path pattern (index.php/ optional), why] */
const RULES: Array<[Set<string>, RegExp, string]> = [
	[WRITE, /^\/settings\/personal\/changepassword$/, 'Passwords cannot be changed in the public demo'],
	[WRITE, /^\/lostpassword(\/|$)/, 'Passwords cannot be reset in the public demo'],
	[WRITE, /^\/settings\/users(\/|$)/, 'Accounts cannot be changed in the public demo'],
	[WRITE, /^\/ocs\/v[12]\.php\/cloud\/(users|groups)(\/|$)/, 'Accounts cannot be changed in the public demo'],
	[new Set(['POST']), /^\/apps\/mail\/api\/accounts$/, 'Adding a mail account is off in the public demo: try the demo mailbox'],
	[new Set(['PUT', 'DELETE']), /^\/apps\/mail\/api\/accounts\/\d+$/, 'The demo mail account cannot be changed or removed'],
	[new Set(['PUT']), /^\/apps\/mail\/api\/sieve\/account\/\d+$/, 'Sieve servers cannot be set in the public demo'],
	[WRITE, /^\/apps\/twofactor_[a-z]+\//, 'Two-factor sign-in cannot be turned on in the public demo'],
]

/** Why this request is refused in the public demo, or null. */
export function demoRefusal(demo: PublicDemo, method: string, pathname: string): string | null {
	if (!demo.enabled) return null
	const p = pathname.replace(/^\/index\.php(?=\/)/, '').replace(/\/+$/, '') || '/'
	for (const [methods, re, why] of RULES) if (methods.has(method) && re.test(p)) return why
	return null
}

/** The refusal as the callers expect it: OCS JSON, Mail JSON, or text. */
export function refusalResponse(pathname: string, why: string): Response {
	if (pathname.includes('/ocs/')) {
		return Response.json({ ocs: { meta: { status: 'failure', statuscode: 403, message: why }, data: [] } }, { status: 403 })
	}
	return Response.json({ status: 'error', message: why, error: { code: 'public_demo', message: why } }, { status: 403 })
}

/** What the UI may know: everything but the switch itself is harmless. */
export const demoInfo = (d: PublicDemo) => d.enabled
	? { enabled: true, feedbackUrl: d.feedbackUrl, resetAt: d.resetAt, accounts: d.accounts }
	: { enabled: false }
