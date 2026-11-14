// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The logo can never be a broken image: Wavium's W is drawn inline; an admin's
// own logo is loaded from this origin whatever host the server built its URL for.
import '../testing/dom'
import { afterEach, expect, test } from 'vitest'
import { cleanup, render } from '../testing/render'
import { BrandLogo, isCustomLogo, sameOrigin } from './Brand'

afterEach(() => cleanup())

test('default logo: the inline W, no image request', async () => {
	const { container } = await render(<BrandLogo logo="http://localhost:8300/core/img/logo/logo.svg?v=0" />)
	expect(container.querySelector('img')).toBeNull()
	expect(container.querySelector('svg.at-wavium path')).toBeTruthy()
})

test('custom logo: an image on the current origin', async () => {
	const url = 'http://other-host:9999/index.php/apps/theming/image/logo?useSvg=1&v=3'
	expect(isCustomLogo(url)).toBe(true)
	expect(sameOrigin(url)).toBe('/index.php/apps/theming/image/logo?useSvg=1&v=3')
	const { container } = await render(<BrandLogo logo={url} />)
	expect(container.querySelector('img')!.getAttribute('src')).toBe('/index.php/apps/theming/image/logo?useSvg=1&v=3')
})
