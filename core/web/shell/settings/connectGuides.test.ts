import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectGuides } from './agentsModel'

const info = {
	mcpUrl: 'https://atrium.example.com/agent/mcp',
	restUrl: 'https://atrium.example.com/agent/v1/tools/<tool>', // exactly as server/agent/owner.ts returns it
	openapiUrl: 'https://atrium.example.com/agent/v1/openapi.json',
	token: "tok'en-123",
}
const guides = connectGuides(info)
const guide = (id: string) => {
	const g = guides.find((x) => x.id === id)
	if (!g) throw new Error(`no guide ${id}`)
	return g
}

describe('connect box guides', () => {
	it('covers every client of PLAN.md P2-6, in order', () => {
		expect(guides.map((g) => g.id)).toEqual(['claude-code', 'claude-desktop', 'cursor', 'codex', 'rest'])
		for (const g of guides) expect(g.steps.length).toBeGreaterThan(0)
	})

	it('Claude Code: http transport, URL and header quoted for the shell', () => {
		const cmd = guide('claude-code').steps[0].value
		expect(cmd).toBe(`claude mcp add --transport http atrium 'https://atrium.example.com/agent/mcp' --header 'Authorization: Bearer tok'\\''en-123'`)
		const json = JSON.parse(guide('claude-code').steps[1].value)
		expect(json.mcpServers.atrium).toEqual({ type: 'http', url: info.mcpUrl, headers: { Authorization: `Bearer ${info.token}` } })
	})

	it('Claude Desktop: valid JSON, mcp-remote with the token only in env', () => {
		const cfg = JSON.parse(guide('claude-desktop').steps[0].value).mcpServers.atrium
		expect(cfg.command).toBe('npx')
		expect(cfg.args).toEqual(['-y', 'mcp-remote', info.mcpUrl, '--header', 'Authorization:${ATRIUM_AUTH}'])
		expect(cfg.env).toEqual({ ATRIUM_AUTH: `Bearer ${info.token}` })
	})

	it('Cursor: url + header', () => {
		expect(JSON.parse(guide('cursor').steps[0].value)).toEqual({ mcpServers: { atrium: { url: info.mcpUrl, headers: { Authorization: `Bearer ${info.token}` } } } })
	})

	it('Codex: token kept out of config.toml', () => {
		const [toml, env] = guide('codex').steps
		expect(toml.value).toContain(`url = "${info.mcpUrl}"`)
		expect(toml.value).toContain('bearer_token_env_var = "ATRIUM_TOKEN"')
		expect(toml.value).not.toContain(info.token)
		expect(env.value).toBe(`export ATRIUM_TOKEN='tok'\\''en-123'`)
	})

	it('REST intro names the tool URL once', () => {
		expect(guide('rest').intro).toContain('POST https://atrium.example.com/agent/v1/tools/<tool> ')
	})

	it('REST script runs: right URL, header and body, default body {}', () => {
		const dir = mkdtempSync(join(tmpdir(), 'atrium-guide-'))
		// Fake curl: prints its arguments, one per line.
		writeFileSync(join(dir, 'curl'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n')
		chmodSync(join(dir, 'curl'), 0o755)
		const script = join(dir, 'atrium.sh')
		writeFileSync(script, guide('rest').steps[0].value)
		const run = (...args: string[]) => execFileSync('sh', [script, ...args], { env: { PATH: `${dir}:/usr/bin:/bin` } }).toString().trim().split('\n')
		const withBody = run('mail_message_list', '{"limit": 5}')
		expect(withBody).toContain('https://atrium.example.com/agent/v1/tools/mail_message_list')
		expect(withBody).toContain(`Authorization: Bearer ${info.token}`)
		expect(withBody[withBody.length - 1]).toBe('{"limit": 5}')
		const noBody = run('agent_whoami')
		expect(noBody[noBody.length - 1]).toBe('{}')
	})
})
