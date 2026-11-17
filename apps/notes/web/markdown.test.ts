// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Note preview HTML must never carry script: payloads that once broke out of
// an image's alt through the bare-URL linker (security check, v4).
import '../../../core/web/testing/dom'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

function unsafe(html: string): string[] {
	const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
	const bad: string[] = []
	doc.querySelectorAll('*').forEach((el) => {
		if (['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'STYLE', 'SVG'].includes(el.tagName.toUpperCase())) bad.push(el.tagName)
		for (const a of Array.from(el.attributes)) {
			if (/^on/i.test(a.name)) bad.push(`${el.tagName}[${a.name}]`)
			if (/^(href|src)$/i.test(a.name) && /^\s*(javascript|data|vbscript):/i.test(a.value.replace(/[\s\u0000-\u001f]/g, ''))) bad.push(`${el.tagName}[${a.name}=${a.value}]`)
		}
	})
	return bad
}

describe('note preview is safe', () => {
	const payloads = [
		'![x https://e.co/a/onerror=alert(1)// b](https://img/a.png)',
		'![a https://x.y/ "](https://i/p.png)',
		'[see https://evil.example/onmouseover=alert(1)//](https://ok.example)',
		'<img src=x onerror=alert(1)>',
		'<script>alert(1)</script>',
		'[x](javascript:alert(1))',
		'[x](JaVaScRiPt:alert(1))',
		'![x](data:text/html,<script>alert(1)</script>)',
		'[x](https://ok" onclick="alert(1))',
		'`<b onclick=x>` **<i onclick=y>**',
		'| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | https://t.co/x"onerror="a |',
		'- [ ] task https://x.y/onerror=alert(1)//',
	]
	for (const p of payloads) {
		it(JSON.stringify(p), () => {
			expect(unsafe(renderMarkdown(p))).toEqual([])
		})
	}

	it('still links bare URLs in text, once', () => {
		const html = renderMarkdown('Voir https://wavium.example/doc et [ici](https://a.example "t")')
		const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
		expect(Array.from(doc.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['https://wavium.example/doc', 'https://a.example'])
	})

	it('an image alt with a URL stays plain text', () => {
		const doc = new DOMParser().parseFromString(renderMarkdown('![photo https://x.y/z](https://img/a.png)'), 'text/html')
		expect(doc.querySelector('img')!.getAttribute('alt')).toBe('photo https://x.y/z')
		expect(doc.querySelectorAll('a').length).toBe(0)
	})
})
