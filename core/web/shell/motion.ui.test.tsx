// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import '../testing/dom'
import { afterEach, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, click, getButton, render, testSession } from '../testing/render'
import { Appearance } from './settings/Appearance'
import { getMotion, setMotion } from './theme'

afterEach(() => { cleanup(); setMotion('full') })

test('Animations: Calm marks the page, Lively (the default) removes the mark, per device', async () => {
	expect(getMotion()).toBe('full')
	const { container } = await render(<Appearance session={testSession} />)
	await click(getButton(container, 'Calm'))
	expect(document.documentElement.dataset.motion).toBe('reduced')
	expect(localStorage.getItem('atrium.motion')).toBe('reduced')
	await click(getButton(container, 'Lively'))
	expect(document.documentElement.dataset.motion).toBeUndefined()
	expect(localStorage.getItem('atrium.motion')).toBeNull()
})

test('the design system stops movement for Calm and for the system setting, and never leaves a transform behind', () => {
	const css = readFileSync(join(__dirname, '../ui/ui.css'), 'utf8')
	expect(css).toContain(":root[data-motion='reduced'] *")
	expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ animation-duration: 1ms/)
	// Entering elements use fill-mode backwards: a transform kept after the animation would trap fixed menus.
	for (const m of css.matchAll(/animation: at-enter[^;]*;/g)) expect(m[0]).toContain('backwards')
})
