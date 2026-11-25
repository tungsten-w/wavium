// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// services/agentchat/chat-loop.sh (V4-39): the runner that lets an agent on
// the owner's own machine answer from inside Wavium. Run for real against a
// fake Wavium and a fake `claude`, because what can break here is the script,
// not the idea: a message answered twice, a failure nobody is told about, a
// token on a command line, two loops at once.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '../../../services/agentchat/chat-loop.sh')

let dir: string
let server: ReturnType<typeof Bun.serve>
let said: string[]
let waiting: string[]
let auths: Array<string | null>

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'wv-chat-'))
	writeFileSync(join(dir, 'token'), 'agt_not-a-real-token\n')
	said = []
	waiting = []
	auths = []
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname
			auths.push(req.headers.get('authorization'))
			if (path === '/agent/v1/chat/-/pending' && req.method === 'GET') {
				const body = waiting.join('\n\n')
				waiting = []
				return new Response(body, { headers: { 'Content-Type': 'text/plain' } })
			}
			if (path === '/agent/v1/chat/-/say' && req.method === 'POST') {
				said.push(await req.text())
				return new Response('1', { status: 201 })
			}
			return new Response('nope', { status: 404 })
		},
	})
})
afterEach(() => server.stop(true))

/** A stand-in for `claude`: records its stdin and argv, prints what we tell it. */
function fakeClaude(body: string): string {
	const path = join(dir, 'claude')
	writeFileSync(path, `#!/bin/sh\ncat > "${dir}/stdin"\nprintf '%s' "$*" > "${dir}/argv"\n${body}\n`)
	chmodSync(path, 0o755)
	return path
}

async function runLoop(env: Record<string, string> = {}) {
	const p = Bun.spawn(['bash', SCRIPT], {
		env: {
			PATH: process.env.PATH ?? '/usr/bin:/bin',
			HOME: dir,
			WAVIUM_URL: `http://127.0.0.1:${server.port}`,
			WAVIUM_AGENT: 'claude-mail',
			WAVIUM_AGENT_TOKEN_FILE: join(dir, 'token'),
			WAVIUM_CHAT_DIR: dir,
			WAVIUM_CHAT_ONCE: '1',
			CLAUDE_BIN: join(dir, 'claude'),
			...env,
		},
		stdout: 'pipe', stderr: 'pipe',
	})
	const code = await p.exited
	return { code, log: existsSync(join(dir, 'chat.log')) ? readFileSync(join(dir, 'chat.log'), 'utf8') : '' }
}

const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null)

test('a waiting message reaches the agent, and its answer comes back', async () => {
	fakeClaude(`printf 'J ai tague 14 factures.'`)
	waiting = ['Tague les factures de novembre']
	const { code, log } = await runLoop()
	expect(code).toBe(0)
	// What the agent was actually handed: the owner's words, with the framing.
	expect(read('stdin')).toContain('Tague les factures de novembre')
	expect(read('stdin')).toContain('goes straight into their chat panel')
	expect(said).toEqual(['J ai tague 14 factures.'])
	expect(log).toContain('answered')
	// The token travelled in the header, and only there.
	expect(auths.every((a) => a === 'Bearer agt_not-a-real-token')).toBe(true)
	expect(read('argv')).not.toContain('agt_not-a-real-token')
})

test('nothing waiting: the agent is not started at all', async () => {
	fakeClaude(`printf 'I should not run'`)
	const { code } = await runLoop()
	expect([code, read('stdin'), said]).toEqual([0, null, []])
})

test('a run that fails says so to the owner instead of leaving them waiting', async () => {
	fakeClaude('exit 3')
	waiting = ['tu peux regarder mes mails ?']
	const { log } = await runLoop()
	expect(said).toHaveLength(1)
	expect(said[0]).toContain('could not answer just now (error 3)')
	expect(log).toContain('FAIL rc=3')
})

test('a run that takes too long is cut, and the owner is told that too', async () => {
	fakeClaude('sleep 5')
	waiting = ['fais tout, maintenant']
	const { log } = await runLoop({ WAVIUM_CHAT_TIMEOUT: '1' })
	expect(said[0]).toContain('could not finish in time (1s)')
	expect(log).toContain('FAIL timeout')
})

test('an empty answer is a failure, not an empty message in the thread', async () => {
	fakeClaude('exit 0')
	waiting = ['dis quelque chose']
	await runLoop()
	expect(said[0]).toContain('could not answer just now')
})

test('the conversation continues: the second run resumes the first session', async () => {
	fakeClaude(`printf 'ok'`)
	waiting = ['un']
	await runLoop()
	const first = read('argv')!
	expect(first).toContain('--session-id')
	const uuid = /--session-id (\S+)/.exec(first)![1]
	expect(read('session')).toBe(uuid)
	waiting = ['deux']
	await runLoop()
	expect(read('argv')).toContain(`--resume ${uuid}`)
})

test('a failed run drops the session, so one bad turn does not poison the next', async () => {
	fakeClaude(`printf 'ok'`)
	waiting = ['un']
	await runLoop()
	expect(read('session')).not.toBeNull()
	fakeClaude('exit 1')
	waiting = ['deux']
	await runLoop()
	expect(read('session')).toBeNull()
})

test('two loops do not run at once: the second leaves without touching anything', async () => {
	fakeClaude(`printf 'ok'`)
	waiting = ['un seul passage']
	// Hold the same lock the loop takes.
	const holder = Bun.spawn(['flock', join(dir, 'loop.lock'), '-c', 'sleep 3'], { stdout: 'ignore', stderr: 'ignore' })
	await Bun.sleep(300)
	const { code, log } = await runLoop()
	holder.kill()
	expect([code, said, read('stdin')]).toEqual([0, [], null])
	expect(log).toContain('another loop holds the lock')
})

test('an unreadable token file stops before any call', async () => {
	fakeClaude(`printf 'ok'`)
	const { code, log } = await runLoop({ WAVIUM_AGENT_TOKEN_FILE: join(dir, 'no-such-token') })
	expect([code, auths]).toEqual([1, []])
	expect(log).toContain('FATAL token file unreadable')
})

test('a server that refuses is reported, and nothing is invented', async () => {
	fakeClaude(`printf 'ok'`)
	const { code, log } = await runLoop({ WAVIUM_URL: `http://127.0.0.1:${server.port}/wrong` })
	expect([code, said, read('stdin')]).toEqual([0, [], null])
	expect(log).toContain('WARN pending failed')
})
