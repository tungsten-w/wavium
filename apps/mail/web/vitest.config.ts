// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure-logic tests of the Mail web app (labels.test.ts). The SDK is aliased to its source.
// Run: cd apps/daily_todo && bun --bun node_modules/.bin/vitest run --root ../mail/web --config vitest.config.ts
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: { alias: { '@atrium/sdk': fileURLToPath(new URL('../../../core/web/sdk/index.ts', import.meta.url)) } },
	test: { include: ['*.test.ts'] },
})
