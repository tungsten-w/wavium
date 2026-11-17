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

test('disguised script links, data URLs and dangerous elements are dropped (security check, v4)', () => {
	const out = cleanHtml([
		'<a href="java\tscript:alert(1)">a</a>', '<a href=" JAVASCRIPT:alert(1)">b</a>', '<a href="&#x6A;avascript:alert(1)">c</a>',
		'<a href="data:text/html,<script>alert(1)</script>">d</a>', '<a href="vbscript:x">e</a>',
		'<img src="javascript:alert(1)"><img src="https://img.test/a.png">', '<svg><a xlink:href="javascript:alert(1)"><text>s</text></a></svg>',
		'<form action="https://x"><button formaction="javascript:x">f</button></form>', '<base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://e">',
		'<a href="mailto:bob@x.test">m</a><a href="/apps/files">r</a><p style="background:url(https://track)">p</p>',
	].join(''))
	expect(out).not.toMatch(/javascript|vbscript|data:|<svg|<form|<button|<base|<meta|url\(/i)
	expect(out).toContain('<img src="https://img.test/a.png">')
	expect(out).toContain('href="mailto:bob@x.test"')
	expect(out).toContain('href="/apps/files"')
})
