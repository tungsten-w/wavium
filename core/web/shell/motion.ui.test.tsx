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

test('moving to another app is a View Transition; inside an app, or with Calm, it is instant (v4 part 2)', async () => {
	const { navigate, withTransition } = await import('@atrium/sdk')
	const doc = document as unknown as { startViewTransition?: (u: () => Promise<void> | void) => { finished: Promise<void> } }
	const calls: string[] = []
	doc.startViewTransition = (update) => { calls.push(document.documentElement.dataset.vt ?? ''); void update(); return { finished: Promise.resolve() } }
	try {
		history.replaceState(null, '', '/apps/mail/')
		navigate('/apps/mail/view/inbox')
		expect(calls).toEqual([])
		navigate('/apps/messages/')
		expect(calls).toEqual(['app'])
		expect(location.pathname).toBe('/apps/messages/')
		setMotion('reduced')
		navigate('/apps/files/')
		expect(calls).toEqual(['app'])
		expect(location.pathname).toBe('/apps/files/')
		let ran = false
		withTransition(() => { ran = true }, { kind: 'theme' })
		expect(ran).toBe(true)
	} finally {
		delete doc.startViewTransition
	}
	// Without the API (older browsers), the change still happens.
	setMotion('full')
	let ran = false
	withTransition(() => { ran = true })
	expect(ran).toBe(true)
})

test('buttons ripple from the press, not with Calm', async () => {
	const { installRipple } = await import('@atrium/ui')
	const off = installRipple()
	try {
		const b = document.createElement('button')
		b.className = 'at-btn'
		document.body.append(b)
		b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }))
		expect(b.querySelectorAll('.at-ripple').length).toBe(1)
		setMotion('reduced')
		b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
		expect(b.querySelectorAll('.at-ripple').length).toBe(1)
		b.remove()
	} finally {
		off()
	}
})
