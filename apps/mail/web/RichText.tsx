// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HTML compose (PLAN P4-1c): a small rich editor (bold, italic, underline,
// lists, links) on contentEditable. The HTML goes out with a plain-text part
// made from it; Mail's backend builds the multipart message.
import { useEffect, useRef } from 'react'
import { IconButton } from '@atrium/ui'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Plain text -> HTML that keeps the lines (for switching a draft to rich text). */
export const textToHtml = (text: string) => esc(text).replace(/\r?\n/g, '<br>')

/** HTML -> plain text for the text/plain part: lines, list items, links as "text (url)". */
export function htmlToText(html: string): string {
	const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
	doc.querySelectorAll('a[href]').forEach((a) => {
		const href = a.getAttribute('href') ?? ''
		if (href && a.textContent !== href) a.textContent = `${a.textContent} (${href})`
	})
	doc.querySelectorAll('li').forEach((li) => li.prepend('- '))
	doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'))
	doc.querySelectorAll('p, div, li, ul, ol').forEach((el) => el.append('\n'))
	return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

/** Removes scripts, event handlers and javascript: links from pasted HTML. */
export function cleanHtml(html: string): string {
	const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
	doc.querySelectorAll('script, style, iframe, object, embed, form').forEach((el) => el.remove())
	doc.querySelectorAll('*').forEach((el) => {
		for (const attr of Array.from(el.attributes)) {
			if (/^on/i.test(attr.name) || (attr.name === 'href' && /^\s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name)
		}
	})
	return doc.body.firstElementChild?.innerHTML ?? ''
}

export function RichEditor({ value, onChange, label }: { value: string, onChange: (html: string) => void, label: string }) {
	const ref = useRef<HTMLDivElement>(null)
	// Set the content once (and when the draft changes from outside); typing must not reset the caret.
	useEffect(() => {
		if (ref.current && ref.current.innerHTML !== value) ref.current.innerHTML = value
	}, [value])
	const run = (cmd: string, arg?: string) => {
		ref.current?.focus()
		document.execCommand(cmd, false, arg)
		if (ref.current) onChange(cleanHtml(ref.current.innerHTML))
	}
	return (
		<div className="ml-rich">
			<div className="ml-rich__bar" role="toolbar" aria-label="Formatting">
				{([['Bold', 'bold', <b key="b">B</b>], ['Italic', 'italic', <i key="i">I</i>], ['Underline', 'underline', <u key="u">U</u>],
					['Bulleted list', 'insertUnorderedList', '•'], ['Numbered list', 'insertOrderedList', '1.']] as const).map(([name, cmd, face]) => (
					<button key={cmd} type="button" className="ml-rich__btn" aria-label={name} title={name} onMouseDown={(e) => e.preventDefault()} onClick={() => run(cmd)}>{face}</button>
				))}
				<IconButton icon="link" label="Link" onMouseDown={(e) => e.preventDefault()} onClick={() => {
					const url = window.prompt('Link address (https://…)')
					if (url && /^(https?:|mailto:)/i.test(url.trim())) run('createLink', url.trim())
				}} />
			</div>
			<div ref={ref} className="ml-rich__area" contentEditable role="textbox" aria-multiline="true" aria-label={label}
				onInput={() => { if (ref.current) onChange(cleanHtml(ref.current.innerHTML)) }} />
		</div>
	)
}
