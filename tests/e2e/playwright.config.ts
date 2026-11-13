// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// End-to-end smoke tests against a running dev stack (P1-7).
// `make test-e2e` starts the stack if needed and runs them in the official
// Playwright image (mcr.microsoft.com/playwright:v1.49.1-noble, same version as
// package.json), with the host network so http://localhost:$ATRIUM_PORT works.
// ATRIUM_URL overrides the target (never a production URL: AGENTS.md rule A1).
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
	testDir: '.',
	testMatch: '*.spec.ts',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	// First page loads on a cold dev stack (Bun watch builds, PHP opcache) are slow.
	timeout: 90_000,
	expect: { timeout: 20_000 },
	reporter: [['list']],
	outputDir: './results',
	use: {
		baseURL: process.env.ATRIUM_URL ?? `http://localhost:${process.env.ATRIUM_PORT ?? '8092'}`,
		locale: 'fr-FR',
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure',
		...devices['Desktop Chrome'],
	},
})
