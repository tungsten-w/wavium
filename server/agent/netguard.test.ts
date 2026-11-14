// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import { assertPublicWebhook, BlockedWebhook, ipBytes, isInternalIp, webhookPolicy } from './netguard'

const dns = (table: Record<string, string[]>) => async (host: string) => {
	if (!(host in table)) throw new Error(`ENOTFOUND ${host}`)
	return table[host]
}

test('internal addresses', () => {
	for (const ip of ['127.0.0.1', '127.8.9.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.2.10', '169.254.169.254',
		'100.101.102.103', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
		'::1', '::', 'fe80::1', 'fd12:3456::1', 'fc00::1', 'ff02::1',
		'::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::10.0.0.1', '2002:c0a8:0101::1', '::127.0.0.1',
		'[::1]', 'fe80::1%eth0', 'not-an-ip']) {
		expect([ip, isInternalIp(ip)]).toEqual([ip, true])
	}
})

test('public addresses', () => {
	for (const ip of ['1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1',
		'2606:4700:4700::1111', '2a00:1450:4007:80e::200e', '::ffff:93.184.216.34', '64:ff9b::1.1.1.1']) {
		expect([ip, isInternalIp(ip)]).toEqual([ip, false])
	}
})

test('ipBytes parses IPv6 shorthand', () => {
	expect([...ipBytes('::1')!]).toEqual([...Array(15).fill(0), 1])
	expect([...ipBytes('::ffff:1.2.3.4')!].slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4])
	expect(ipBytes('2001:db8::')!.length).toBe(16)
	expect(ipBytes('1.2.3')).toBeNull()
})

test('webhook URLs: refused when the host is or resolves inside', async () => {
	const p = webhookPolicy('', dns({ 'hooks.example.com': ['93.184.216.34'], 'evil.example.com': ['93.184.216.34', '127.0.0.1'], 'meta.example.com': ['169.254.169.254'] }))
	await assertPublicWebhook('https://hooks.example.com/x', p)
	for (const url of ['http://127.0.0.1:9000/', 'http://localhost/', 'http://api.localhost/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
		'http://10.0.0.5/hook', 'http://evil.example.com/', 'http://meta.example.com/latest/meta-data',
		'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/']) {
		await expect(assertPublicWebhook(url, p)).rejects.toBeInstanceOf(BlockedWebhook)
	}
	await expect(assertPublicWebhook('ftp://hooks.example.com/', p)).rejects.toThrow('http(s)')
	await expect(assertPublicWebhook('https://u:p@hooks.example.com/', p)).rejects.toThrow('user name')
	await expect(assertPublicWebhook('nope', p)).rejects.toBeInstanceOf(BlockedWebhook)
})

test('unresolvable names: allowed at save time only', async () => {
	const p = webhookPolicy('', dns({}))
	await assertPublicWebhook('https://not-yet.example.com/', p, { unresolvedOk: true })
	await expect(assertPublicWebhook('https://not-yet.example.com/', p)).rejects.toThrow('ENOTFOUND')
})

test('ATRIUM_WEBHOOK_ALLOW: host names, wildcards, IPs and ranges', async () => {
	const p = webhookPolicy('openclaw.lan, *.agents.lan 192.168.2.10,10.8.0.0/16 fd00::/8', dns({
		'openclaw.lan': ['192.168.2.50'], 'a.agents.lan': ['192.168.2.51'], 'nas.lan': ['192.168.2.10'], 'vpn.lan': ['10.8.3.4'], 'other.lan': ['192.168.2.11'], 'agents.lan.evil.com': ['192.168.2.51'],
	}))
	for (const url of ['http://openclaw.lan:8080/hook', 'http://a.agents.lan/', 'http://nas.lan/', 'http://192.168.2.10/', 'http://vpn.lan/', 'http://[fd00::5]/']) {
		await assertPublicWebhook(url, p)
	}
	for (const url of ['http://other.lan/', 'http://192.168.2.11/', 'http://agents.lan.evil.com/', 'http://127.0.0.1/']) {
		await expect(assertPublicWebhook(url, p)).rejects.toBeInstanceOf(BlockedWebhook)
	}
	expect(() => webhookPolicy('10.0.0.0/33')).toThrow()
})

test('public demo: every webhook URL is refused, even a public one', async () => {
	const p = webhookPolicy('', async () => ['93.184.216.34'], true)
	await expect(assertPublicWebhook('https://hooks.example.com/x', p)).rejects.toThrow('public demo')
	await expect(assertPublicWebhook('https://hooks.example.com/x', webhookPolicy('', async () => ['93.184.216.34'], false))).resolves.toBeUndefined()
})
