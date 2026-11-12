// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Small Markdown -> HTML renderer for the note preview. Everything is escaped
// first; only the constructs below produce tags, and links/images only allow
// http(s), mailto and relative URLs. Task list items carry data-line so the
// preview can tick them in the source.
//   headings (#), paragraphs, line breaks, > quotes, - * + and 1. lists
//   (nested by indentation), - [ ] tasks, ``` fences, `code`, **bold**,
//   *italic*, ~~strike~~, [links](url), ![images](src), autolinks, ---, tables.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function safeUrl(url: string): string | null {
	const u = url.trim()
	if (/^(https?:|mailto:)/i.test(u)) return u
	if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null // javascript:, data:, ...
	return u
}

export interface RenderOptions {
	/** Turns a relative image path (an attachment next to the note) into a URL. */
	resolveImage?: (src: string) => string
}

function inline(text: string, opts: RenderOptions): string {
	// Code spans first, so their content is not formatted.
	const codes: string[] = []
	let s = text.replace(/`([^`]+)`/g, (_, c: string) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000` })
	s = esc(s)
	s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, alt: string, src: string) => {
		const raw = src.replace(/&amp;/g, '&')
		const ok = safeUrl(raw)
		if (!ok) return m
		const url = /^(https?:)?\/\//i.test(ok) || ok.startsWith('/') ? ok : (opts.resolveImage?.(decodeURIComponent(ok)) ?? ok)
		return `<img src="${esc(url)}" alt="${alt}" loading="lazy">`
	})
	s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label: string, href: string) => {
		const ok = safeUrl(href.replace(/&amp;/g, '&'))
		return ok ? `<a href="${esc(ok)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m
	})
	s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (_, pre: string, url: string) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
	s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a?: string, b?: string) => `<strong>${a ?? b}</strong>`)
	s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)|(^|[^_\w])_([^_\s][^_]*)_(?![_\w])/g, (_, p1?: string, a?: string, p2?: string, b?: string) => `${p1 ?? p2 ?? ''}<em>${a ?? b}</em>`)
	s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
	return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)])
}

interface ListItem { indent: number, ordered: boolean, html: string }

export function renderMarkdown(src: string, opts: RenderOptions = {}): string {
	const lines = src.replace(/\r\n?/g, '\n').split('\n')
	const out: string[] = []
	let para: string[] = []
	let list: ListItem[] = []
	let quote: string[] = []

	const flushPara = () => {
		if (para.length) out.push(`<p>${para.map((l) => inline(l, opts)).join('<br>')}</p>`)
		para = []
	}
	const flushList = () => {
		if (!list.length) return
		// Nest by indentation: a deeper item opens a sub-list inside the previous item.
		const stack: { indent: number, tag: string }[] = []
		let html = ''
		for (const it of list) {
			const tag = it.ordered ? 'ol' : 'ul'
			while (stack.length && it.indent < stack[stack.length - 1].indent) { html += `</li></${stack.pop()!.tag}>` }
			if (!stack.length || it.indent > stack[stack.length - 1].indent) { html += `<${tag}>`; stack.push({ indent: it.indent, tag }) } else html += '</li>'
			html += `<li${it.html.startsWith('<input') ? ' class="md-task"' : ''}>${it.html}`
		}
		while (stack.length) html += `</li></${stack.pop()!.tag}>`
		out.push(html)
		list = []
	}
	const flushQuote = () => {
		// Line numbers inside a quote are relative to it, so its task boxes are read-only.
		if (quote.length) out.push(`<blockquote>${renderMarkdown(quote.join('\n'), opts).replace(/data-line="\d+"/g, 'disabled')}</blockquote>`)
		quote = []
	}
	const flush = () => { flushPara(); flushList(); flushQuote() }

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const fence = /^\s*(```|~~~)(.*)$/.exec(line)
		if (fence) {
			flush()
			const body: string[] = []
			i++
			while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
			out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
			continue
		}
		if (/^\s*>/.test(line)) { flushPara(); flushList(); quote.push(line.replace(/^\s*>\s?/, '')); continue }
		if (quote.length) flushQuote()
		if (!line.trim()) { flushPara(); if (list.length && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i + 1] ?? '')) flushList(); continue }
		const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
		if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2], opts)}</h${h[1].length}>`); continue }
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue }
		// Table: header row, then a |---|---| row.
		if (line.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1] ?? '')) {
			flush()
			const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
			const head = cells(line)
			i += 2
			const rows: string[][] = []
			while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
			i--
			out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c, opts)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '', opts)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
			continue
		}
		const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
		if (li) {
			flushPara()
			const indent = li[1].replace(/\t/g, '    ').length
			const task = /^\[([ xX])\]\s+(.*)$/.exec(li[3])
			const html = task
				? `<input type="checkbox" data-line="${i}"${task[1] !== ' ' ? ' checked' : ''} aria-label="Toggle item"> <span>${inline(task[2], opts)}</span>`
				: inline(li[3], opts)
			list.push({ indent, ordered: /\d/.test(li[2]), html })
			continue
		}
		if (list.length && /^\s+\S/.test(line)) { list[list.length - 1].html += '<br>' + inline(line.trim(), opts); continue }
		flushList()
		para.push(line)
	}
	flush()
	return out.join('\n')
}

/** Tick or untick the task item on source line `line`. */
export function toggleTask(src: string, line: number): string {
	const lines = src.split('\n')
	const l = lines[line]
	if (l === undefined) return src
	lines[line] = l.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/, (_, p: string, c: string) => `${p}[${c === ' ' ? 'x' : ' '}]`)
	return lines.join('\n')
}
