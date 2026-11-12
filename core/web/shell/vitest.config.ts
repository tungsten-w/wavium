// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure-logic tests of the shell (loginBody.test.ts).
// Run: cd apps/daily_todo && HOME=/tmp bun --bun node_modules/.bin/vitest run --root ../../core/web/shell --config vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['*.test.ts', 'settings/*.test.ts'] } })
