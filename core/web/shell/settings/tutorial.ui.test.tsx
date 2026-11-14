// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import '../../testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@atrium/sdk'
import { cleanup, click, getButton, render } from '../../testing/render'
import { TOUR, Tutorial } from './Tutorial'

const session = { user: { id: 'alice' } } as unknown as Session
beforeEach(() => { try { localStorage.clear() } catch { /* none */ } })
afterEach(() => cleanup())

test('every step has its screenshot in core/img/tutorial', () => {
	for (const s of TOUR) expect(existsSync(join(__dirname, '../../../img/tutorial', `${s.image}.jpg`))).toBe(true)
})

test('steps: next, previous, jump, last step restarts; the place is remembered', async () => {
	const { container } = await render(<Tutorial session={session} />)
	const title = () => container.querySelector('.tour__step h3')!.textContent
	expect(title()).toBe('Your day at a glance')
	expect(getButton(container, 'Previous').hasAttribute('disabled')).toBe(true)
	await click(getButton(container, 'Next'))
	expect(title()).toBe('Mail that sorts itself')
	expect(container.querySelector('.tour__window img')!.getAttribute('src')).toBe('/core/img/tutorial/02-mail.jpg')
	await click(container.querySelectorAll<HTMLButtonElement>('.tour__list button')[TOUR.length - 1])
	expect(title()).toBe('Move from Google')
	expect(container.querySelector('.tour__actions a')!.getAttribute('href')).toBe('/settings/user/move-from-google')
	cleanup()
	const again = await render(<Tutorial session={session} />)
	expect(again.container.querySelector('.tour__step h3')!.textContent).toBe('Move from Google')
	await click(getButton(again.container, 'Start again'))
	expect(again.container.querySelector('.tour__step h3')!.textContent).toBe('Your day at a glance')
})
