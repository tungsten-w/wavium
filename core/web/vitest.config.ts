// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One vitest config for every Atrium React/TS frontend test:
//   core/web/**/*.test.ts(x)    shell, ui, sdk
//   apps/*/web/**/*.test.ts(x)  app UIs
// The shared packages resolve to their sources, like the shell's import map.
// Run (from the repo root): make test-web
//   or: cd core/web && bun --bun node_modules/.bin/vitest run
// DOM tests import core/web/testing/dom first (happy-dom globals; vitest's
// `@vitest-environment` switch breaks under the Bun runtime), see AGENTS.md.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
	root: here('../..'),
	resolve: {
		alias: {
			'@atrium/sdk': here('./sdk/index.ts'),
			'@atrium/ui': here('./ui/index.tsx'),
			// Single React copy for the app UIs, which have no node_modules of their own.
			'react/jsx-runtime': here('./node_modules/react/jsx-runtime.js'),
			'react/jsx-dev-runtime': here('./node_modules/react/jsx-dev-runtime.js'),
			'react-dom/client': here('./node_modules/react-dom/client.js'),
			'react-dom': here('./node_modules/react-dom/index.js'),
			react: here('./node_modules/react/index.js'),
		},
	},
	esbuild: { jsx: 'automatic', tsconfigRaw: '{}' },
	test: {
		include: ['core/web/**/*.test.{ts,tsx}', 'apps/*/web/**/*.test.{ts,tsx}'],
		exclude: ['**/node_modules/**', '**/dist/**'],
	},
})
