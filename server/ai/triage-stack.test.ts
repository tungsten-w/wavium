// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ATRIUM_SERVER_URL is how PHP reaches the Bun server for the internal AI
// routes (Mail's TriageService, see triage-route.ts). It has been wrong in
// production twice, in two different ways, and both failed silently -- the
// Mail status page kept showing classification as on while the queue only grew:
//
// - `http://127.0.0.1:80` works in the container that also runs Bun, but the
//   same environment block is shared with the cron service, where nothing
//   listens on port 80. That is where the triage worker runs, so every mail
//   failed with "AI unreachable: cURL error 7".
// - leaving it unset falls back to `http://web:8080`, the dev stack's service
//   name, in a stack that has no `web` service at all.
//
// So: every stack declares it, and it names a service of that same stack.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const STACKS = ['compose.yaml', 'deploy/compose.yaml', 'deploy/wavium/compose.yaml']
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '0.0.0.0']

/** The names under `services:`, i.e. the only names Docker's DNS answers here. */
export function stackServices(yaml: string): string[] {
	const at = yaml.search(/^services:$/m)
	return at < 0 ? [] : [...yaml.slice(at).matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)].map((m) => m[1])
}

/** Every ATRIUM_SERVER_URL value, a `${VAR:-default}` reduced to its default. */
export function stackServerUrls(yaml: string): string[] {
	return [...yaml.matchAll(/^[ \t]*ATRIUM_SERVER_URL:[ \t]*(\S+)/gm)]
		.map((m) => m[1].replace(/^\$\{[A-Za-z_][A-Za-z0-9_]*:-(.*)\}$/, '$1'))
}

describe('ATRIUM_SERVER_URL, in every compose stack', () => {
	for (const file of STACKS) {
		test(`${file}: declared, and names a service of the stack`, () => {
			const yaml = readFileSync(join(root, file), 'utf8')
			const urls = stackServerUrls(yaml)
			// Unset is not neutral: the default names the dev stack's service.
			expect([file, urls.length > 0]).toEqual([file, true])
			const names = stackServices(yaml)
			for (const url of urls) {
				const host = new URL(url).hostname
				// Loopback is right only for a container that runs Bun itself, and
				// these blocks are shared with cron, which does not.
				expect([file, url, LOOPBACK.includes(host)]).toEqual([file, url, false])
				expect([file, url, names.includes(host)]).toEqual([file, url, true])
			}
		})
	}
})

describe('the parsing itself', () => {
	test('services are read from `services:`, not from the x- anchor blocks', () => {
		const yaml = 'x-app: &app\n  image: atrium:local\n  restart: always\nservices:\n  app:\n    <<: *app\n  cron:\n    entrypoint: /cron.sh\n'
		expect(stackServices(yaml)).toEqual(['app', 'cron'])
	})

	test('a ${VAR:-default} reads as its default, a plain value as itself', () => {
		expect(stackServerUrls('    ATRIUM_SERVER_URL: ${ATRIUM_SERVER_URL:-http://web:8080}\n')).toEqual(['http://web:8080'])
		expect(stackServerUrls('    ATRIUM_SERVER_URL: http://app:80\n')).toEqual(['http://app:80'])
		expect(stackServerUrls('# ATRIUM_SERVER_URL: http://app:80\n')).toEqual([])
	})
})
