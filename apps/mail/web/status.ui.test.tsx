// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a non-admin is told about classification (V4-26). The switch spends the
// instance's AI budget, so it stays admin-only; before this, everyone else saw
// nothing on the Mail status page and could not tell whether their mail was
// being sorted, or why it was not.
import '../../../core/web/testing/dom'
import { afterEach, expect, test } from 'vitest'
import { cleanup, getByText, render } from '../../../core/web/testing/render'
import type { TriageStatus } from './api'
import { ClassificationLine } from './Status'

afterEach(() => { cleanup() })

const settings = (over: Partial<TriageStatus['settings']>): TriageStatus['settings'] => ({
	enabled: false, configured: true, capTotalEur: 1, capBackfillEur: 0.3,
	model: 'mock-small', questionsVersion: 'mail-v3', timezone: 'Europe/Paris', ...over,
})

test('says classification is on when it is', async () => {
	const { container } = await render(<ClassificationLine settings={settings({ enabled: true })} />)
	expect(getByText(container, 'Classification is on')).toBeTruthy()
})

test('no AI provider yet: says so, and where an admin adds one', async () => {
	const { container } = await render(<ClassificationLine settings={settings({ configured: false })} />)
	expect(getByText(container, /no AI provider yet/)).toBeTruthy()
	expect(getByText(container, /Settings > AI/)).toBeTruthy()
})

test('a provider exists but it is off: points at this page, not at Settings', async () => {
	const { container } = await render(<ClassificationLine settings={settings({})} />)
	expect(getByText(container, /turn it on from this page/)).toBeTruthy()
	expect(container.textContent).not.toContain('Settings > AI')
})
