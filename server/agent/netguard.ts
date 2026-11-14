// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Outgoing webhooks (the agent doorbell) must not reach the server's own
// network: localhost, the database, the LAN, cloud metadata (169.254.169.254).
// A webhook URL is refused when its host is, or resolves to, an internal
// address, unless the admin allows it in ATRIUM_WEBHOOK_ALLOW.
//
// ATRIUM_WEBHOOK_ALLOW: comma- or space-separated list of
//   - host names: `hooks.lan`, or `*.lan` for every sub-domain;
//   - addresses or CIDR ranges: `192.168.2.10`, `10.0.0.0/8`, `fd00::/8`.
// A host name entry allows that name whatever it resolves to.
//
// Checked when the URL is saved and again before each POST (DNS may change).
// Redirects are not followed by the doorbell, so a public URL cannot bounce the
// request inward. Left open: DNS rebinding between the check and the connect
// (a few ms); closing it needs connecting to the checked IP itself.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type Resolver = (host: string) => Promise<string[]>

export const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

interface Range { bytes: Uint8Array, bits: number }

export interface WebhookPolicy {
	hosts: Set<string>
	suffixes: string[]
	ranges: Range[]
	resolve: Resolver
	/** Set in the public demo (ATRIUM_PUBLIC_DEMO=1): every URL is refused with this message. */
	off?: string
}

// Internal, reserved or special-purpose ranges (IANA special registries).
const BLOCKED = [
	'0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
	'192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
	'203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
	'::/128', '::1/128', '100::/64', '2001:db8::/32', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8',
].map(parseRange)

/** IPv6 forms that carry an IPv4 address: checked as that IPv4 address. */
function embeddedV4(b: Uint8Array): Uint8Array | null {
	if (b.length !== 16) return null
	const zero = (from: number, to: number) => b.subarray(from, to).every((x) => x === 0)
	// ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated)
	if (zero(0, 10) && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) return b.slice(12)
	// 64:ff9b::a.b.c.d (NAT64)
	if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return b.slice(12)
	// 2002:AABB:CCDD:: (6to4)
	if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6)
	return null
}

export function ipBytes(ip: string): Uint8Array | null {
	const s = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
	const v = isIP(s)
	if (v === 4) return Uint8Array.from(s.split('.').map(Number))
	if (v !== 6) return null
	let text = s
	// Trailing dotted IPv4 (::ffff:1.2.3.4).
	const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
	if (dotted) {
		const [a, b, c, d] = dotted[1].split('.').map(Number)
		text = text.slice(0, -dotted[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
	}
	const [head, tail] = text.includes('::') ? text.split('::') : [text, null]
	const h = head ? head.split(':') : []
	const t = tail ? tail.split(':') : []
	const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
	if (groups.length !== 8) return null
	const out = new Uint8Array(16)
	groups.forEach((g, i) => {
		const n = parseInt(g || '0', 16)
		out[i * 2] = n >> 8
		out[i * 2 + 1] = n & 0xff
	})
	return out
}

export function parseRange(text: string): Range {
	const [addr, len] = text.split('/')
	const bytes = ipBytes(addr)
	if (!bytes) throw new Error(`not an IP address or range: "${text}"`)
	const max = bytes.length * 8
	const bits = len === undefined ? max : Number(len)
	if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`bad prefix length in "${text}"`)
	return { bytes, bits }
}

function inRange(ip: Uint8Array, r: Range): boolean {
	if (ip.length !== r.bytes.length) return false
	for (let i = 0; i < r.bits; i++) {
		const byte = i >> 3, mask = 0x80 >> (i & 7)
		if ((ip[byte] & mask) !== (r.bytes[byte] & mask)) return false
	}
	return true
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved... */
export function isInternalIp(ip: string): boolean {
	const b = ipBytes(ip)
	if (!b) return true // unparsable: refuse
	const v4 = embeddedV4(b)
	if (v4) return BLOCKED.some((r) => inRange(v4, r))
	return BLOCKED.some((r) => inRange(b, r))
}

export function webhookPolicy(allow: string | undefined = process.env.ATRIUM_WEBHOOK_ALLOW, resolve: Resolver = systemResolver, publicDemo = process.env.ATRIUM_PUBLIC_DEMO === '1'): WebhookPolicy {
	const p: WebhookPolicy = { hosts: new Set(), suffixes: [], ranges: [], resolve }
	if (publicDemo) p.off = 'The public demo does not call other servers (webhooks and personal AI providers are off)'
	for (const raw of (allow ?? '').split(/[\s,]+/)) {
		const e = raw.trim().toLowerCase()
		if (!e) continue
		if (e.startsWith('*.')) p.suffixes.push(e.slice(1))
		else if (/^[\d.]+(\/\d+)?$/.test(e) || e.includes(':')) p.ranges.push(parseRange(e))
		else p.hosts.add(e.replace(/\.$/, ''))
	}
	return p
}

function allowedIp(p: WebhookPolicy, ip: string): boolean {
	const b = ipBytes(ip)
	if (!b) return false
	const v4 = embeddedV4(b)
	return p.ranges.some((r) => inRange(b, r) || (v4 !== null && inRange(v4, r)))
}

export class BlockedWebhook extends Error {}

/**
 * Throws BlockedWebhook when `url` is not http(s) or points (directly or by DNS)
 * to an internal address that the allow list does not cover. With
 * `unresolvedOk`, a host that does not resolve passes (saved now, checked
 * again at send time); otherwise the DNS error is thrown as is.
 */
export async function assertPublicWebhook(url: string, p: WebhookPolicy = webhookPolicy(), opts: { unresolvedOk?: boolean } = {}): Promise<void> {
	if (p.off) throw new BlockedWebhook(p.off)
	let u: URL
	try {
		u = new URL(url)
	} catch {
		throw new BlockedWebhook('The webhook URL is not a valid URL')
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedWebhook('The webhook URL must be http(s)')
	if (u.username || u.password) throw new BlockedWebhook('The webhook URL must not contain a user name or password')
	const host = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
	if (p.hosts.has(host) || p.suffixes.some((s) => host.endsWith(s))) return
	let addrs: string[]
	if (isIP(host)) addrs = [host]
	else if (host === 'localhost' || host.endsWith('.localhost')) addrs = ['127.0.0.1']
	else {
		try {
			addrs = await p.resolve(host)
		} catch (e) {
			if (opts.unresolvedOk) return
			throw e
		}
	}
	for (const a of addrs) {
		if (isInternalIp(a) && !allowedIp(p, a)) {
			throw new BlockedWebhook(`The webhook URL points to an internal address (${a}). An admin can allow it with ATRIUM_WEBHOOK_ALLOW.`)
		}
	}
}
