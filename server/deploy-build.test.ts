// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// deploy/build.sh extracts the working tree into deploy/src as the Docker build
// context. It used to leave it there: 400+ MB of a second copy of the repo,
// inside the repo. `make test-server` is `bun test server/`, and that filter
// matches any path containing server/, so the snapshot made every server test
// run twice -- the second time against a tree whose deploy/ build.sh had just
// deleted, which failed the compose-stack test of V4-34 for no reason at all.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')

describe('deploy/build.sh leaves no snapshot behind', () => {
	test('the EXIT trap removes the build context', () => {
		const script = read('deploy/build.sh')
		const traps = [...script.matchAll(/^trap\s+'([^']*)'\s+EXIT$/gm)].map((m) => m[1])
		expect(traps.length).toBeGreaterThan(0)
		// One trap, several commands: whichever way it is written, src must go.
		expect(traps.some((t) => /rm -rf\s+"\$here\/src"/.test(t))).toBe(true)
	})

	test('and a snapshot that does exist is never committable', () => {
		expect(read('deploy/.gitignore').split('\n').map((l) => l.trim())).toContain('src/')
	})
})
