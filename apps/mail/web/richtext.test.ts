// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import '../../../core/web/testing/dom'
import { expect, test } from 'vitest'
import { cleanHtml, htmlToText, textToHtml } from './RichText'

test('text <-> html', () => {
	expect(textToHtml('a < b\nline 2')).toBe('a &lt; b<br>line 2')
	expect(htmlToText('<p>Hello <b>Bob</b></p><ul><li>one</li><li>two</li></ul><p>See <a href="https://x.test">site</a></p>')).toBe('Hello Bob\n- one\n- two\n\nSee site (https://x.test)')
	expect(htmlToText('a<br>b')).toBe('a\nb')
})

test('pasted HTML loses scripts, handlers and javascript links', () => {
	const out = cleanHtml('<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><a href="https://ok.test">ok</a>')
	expect(out).toBe('<p>Hi</p><a>x</a><a href="https://ok.test">ok</a>')
})
