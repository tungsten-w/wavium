// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Markdown editor that renders while you type (CodeMirror 6), like the
// classic Notes editor: headings are big, **bold** is bold, lists get bullets,
// - [ ] tasks become checkboxes, links and images show as such. The Markdown
// marks only appear on the line the cursor is on, so the file stays plain
// Markdown and nothing is converted.
import { useEffect, useRef } from 'react'
import { EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder as cmPlaceholder, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

class CheckboxWidget extends WidgetType {
	constructor(readonly checked: boolean, readonly pos: number) { super() }
	eq(o: CheckboxWidget) { return o.checked === this.checked && o.pos === this.pos }
	toDOM() {
		const box = document.createElement('input')
		box.type = 'checkbox'
		box.className = 'cm-task-box'
		box.checked = this.checked
		box.dataset.pos = String(this.pos)
		box.setAttribute('aria-label', this.checked ? 'Mark as not done' : 'Mark as done')
		return box
	}
	ignoreEvent() { return false }
}
class BulletWidget extends WidgetType {
	eq() { return true }
	toDOM() { const s = document.createElement('span'); s.className = 'cm-bullet'; s.textContent = '•'; return s }
}
class RuleWidget extends WidgetType {
	eq() { return true }
	toDOM() { const s = document.createElement('span'); s.className = 'cm-hr'; return s }
}
class ImageWidget extends WidgetType {
	constructor(readonly src: string, readonly alt: string) { super() }
	eq(o: ImageWidget) { return o.src === this.src && o.alt === this.alt }
	toDOM() {
		const img = document.createElement('img')
		img.className = 'cm-image'
		img.src = this.src
		img.alt = this.alt
		img.loading = 'lazy'
		return img
	}
}

const hide = Decoration.replace({})
const line = (cls: string) => Decoration.line({ class: cls })

function livePreview(resolveImage: (src: string) => string) {
	function build(view: EditorView): DecorationSet {
		const { state } = view
		// Lines with the cursor/selection show their raw Markdown (only while focused).
		const active = new Set<number>()
		if (view.hasFocus) {
			for (const r of state.selection.ranges) {
				const a = state.doc.lineAt(r.from).number, b = state.doc.lineAt(r.to).number
				for (let n = a; n <= b; n++) active.add(n)
			}
		}
		const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number)
		const decos: Range<Decoration>[] = []
		const lineClass = (from: number, to: number, cls: string) => {
			for (let n = state.doc.lineAt(from).number, end = state.doc.lineAt(to).number; n <= end; n++) decos.push(line(cls).range(state.doc.line(n).from))
		}
		for (const { from, to } of view.visibleRanges) {
			syntaxTree(state).iterate({
				from, to,
				enter: (node) => {
					const name = node.name
					const h = /^ATXHeading(\d)$/.exec(name)
					if (h) { lineClass(node.from, node.from, `cm-h cm-h${h[1]}`); return }
					switch (name) {
						case 'FencedCode': {
							lineClass(node.from, node.to, 'cm-codeblock')
							// The ``` lines fold to thin padding unless the cursor is on them.
							for (const n of [state.doc.lineAt(node.from), state.doc.lineAt(node.to)]) {
								if (!isActive(n.from) && /^\s*(```|~~~)/.test(n.text)) {
									decos.push(Decoration.line({ class: 'cm-fence' }).range(n.from))
									if (n.to > n.from) decos.push(hide.range(n.from, n.to))
								}
							}
							return false
						}
						case 'Blockquote':
							lineClass(node.from, node.to, 'cm-quote')
							return
						case 'HorizontalRule':
							if (!isActive(node.from)) decos.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to))
							return
						case 'HeaderMark': {
							if (isActive(node.from)) return
							const next = state.doc.sliceString(node.to, node.to + 1)
							decos.push(hide.range(node.from, next === ' ' ? node.to + 1 : node.to))
							return
						}
						case 'EmphasisMark': case 'StrikethroughMark': case 'CodeMark':
							if (node.node.parent?.name !== 'FencedCode' && !isActive(node.from)) decos.push(hide.range(node.from, node.to))
							return
						case 'QuoteMark':
							if (!isActive(node.from)) {
								const next = state.doc.sliceString(node.to, node.to + 1)
								decos.push(hide.range(node.from, next === ' ' ? node.to + 1 : node.to))
							}
							return
						case 'ListMark': {
							const text = state.doc.sliceString(node.from, node.to)
							const task = node.node.nextSibling?.name === 'Task'
							if (isActive(node.from) || /\d/.test(text)) return
							const after = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
							decos.push(task ? hide.range(node.from, after) : Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to))
							return
						}
						case 'TaskMarker': {
							if (isActive(node.from)) return
							const checked = /x/i.test(state.doc.sliceString(node.from, node.to))
							decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to))
							if (checked) {
								const l = state.doc.lineAt(node.from)
								if (node.to + 1 < l.to) decos.push(Decoration.mark({ class: 'cm-task-done' }).range(node.to + 1, l.to))
							}
							return
						}
						case 'Image': {
							if (isActive(node.from)) return false
							const raw = state.doc.sliceString(node.from, node.to)
							const m = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?/.exec(raw)
							if (!m) return false
							const src = m[2]
							if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^https?:/i.test(src)) return false
							const url = /^(https?:)?\/\//i.test(src) || src.startsWith('/') ? src : resolveImage(decodeURIComponent(src))
							decos.push(Decoration.replace({ widget: new ImageWidget(url, m[1]) }).range(node.from, node.to))
							return false
						}
						case 'Link': {
							if (isActive(node.from)) return false
							// Show only the label: hide "[" and "](url ...)".
							const marks: { from: number, to: number }[] = []
							for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === 'LinkMark') marks.push({ from: c.from, to: c.to })
							if (marks.length >= 2) {
								decos.push(hide.range(marks[0].from, marks[0].to))
								decos.push(hide.range(marks[1].from, node.to))
								decos.push(Decoration.mark({ class: 'cm-link-text' }).range(marks[0].to, marks[1].from))
							}
							return false
						}
					}
				},
			})
		}
		return Decoration.set(decos, true)
	}
	return ViewPlugin.fromClass(class {
		decorations: DecorationSet
		constructor(view: EditorView) { this.decorations = build(view) }
		update(u: ViewUpdate) {
			if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view)
		}
	}, {
		decorations: (v) => v.decorations,
		eventHandlers: {
			mousedown(e, view) {
				const el = e.target as HTMLElement
				if (!(el instanceof HTMLInputElement) || !el.classList.contains('cm-task-box')) return false
				e.preventDefault()
				if (view.state.readOnly) return true
				const pos = Number(el.dataset.pos)
				const cur = view.state.doc.sliceString(pos, pos + 3)
				view.dispatch({ changes: { from: pos, to: pos + 3, insert: /x/i.test(cur) ? '[ ]' : '[x]' } })
				return true
			},
		},
	})
}

const highlight = HighlightStyle.define([
	{ tag: t.heading1, fontSize: '1.75em', fontWeight: '500' },
	{ tag: t.heading2, fontSize: '1.4em', fontWeight: '500' },
	{ tag: t.heading3, fontSize: '1.2em', fontWeight: '500' },
	{ tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600' },
	{ tag: t.strong, fontWeight: '700' },
	{ tag: t.emphasis, fontStyle: 'italic' },
	{ tag: t.strikethrough, textDecoration: 'line-through' },
	{ tag: [t.link, t.url], color: 'var(--at-primary)' },
	{ tag: t.monospace, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.9em' },
	{ tag: t.quote, color: 'var(--at-on-surface-variant)' },
	{ tag: [t.processingInstruction, t.contentSeparator], color: 'var(--at-on-surface-variant)', opacity: '0.7' },
])

export interface LiveEditorProps {
	value: string
	readOnly?: boolean
	placeholder?: string
	autoFocus?: boolean
	onChange: (v: string) => void
	onBlur?: () => void
	onSave?: () => void
	resolveImage: (src: string) => string
	/** Pasted/dropped files: return the Markdown to insert, or null to ignore them. */
	onFiles?: (files: File[]) => Promise<string | null>
}

export function LiveEditor(props: LiveEditorProps) {
	const host = useRef<HTMLDivElement>(null)
	const view = useRef<EditorView | null>(null)
	const p = useRef(props)
	p.current = props

	useEffect(() => {
		const files = (list: FileList | null | undefined, v: EditorView, at: number) => {
			const fs = [...(list ?? [])]
			if (!fs.length || !p.current.onFiles || v.state.readOnly) return false
			p.current.onFiles(fs).then((md) => { if (md) v.dispatch({ changes: { from: at, insert: md }, selection: { anchor: at + md.length } }) })
			return true
		}
		const v = new EditorView({
			parent: host.current!,
			state: EditorState.create({
				doc: props.value,
				extensions: [
					history(),
					EditorView.lineWrapping,
					markdown({ base: markdownLanguage, addKeymap: false }),
					syntaxHighlighting(highlight),
					livePreview((src) => p.current.resolveImage(src)),
					cmPlaceholder(props.placeholder ?? ''),
					EditorState.readOnly.of(!!props.readOnly),
					EditorView.editable.of(!props.readOnly),
					EditorView.contentAttributes.of({ 'aria-label': 'Note text', spellcheck: 'true', autocapitalize: 'sentences' }),
					keymap.of([
						{ key: 'Mod-s', run: () => { p.current.onSave?.(); return true } },
						...markdownKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap,
					]),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) p.current.onChange(u.state.doc.toString())
						if (u.focusChanged && !u.view.hasFocus) p.current.onBlur?.()
					}),
					EditorView.domEventHandlers({
						paste: (e, v) => files(e.clipboardData?.files, v, v.state.selection.main.head),
						drop: (e, v) => {
							const at = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head
							if (files(e.dataTransfer?.files, v, at)) { e.preventDefault(); return true }
							return false
						},
					}),
				],
			}),
		})
		view.current = v
		if (props.autoFocus) v.focus()
		return () => { v.destroy(); view.current = null }
		// The editor is created once per note (the parent keys it by note id).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Outside changes (the other version picked after a conflict, a reload).
	//
	// Never while the editor has the focus, i.e. while someone is typing. Each
	// keystroke travels editor -> onChange -> React state -> back here, and the
	// document is already ahead of the value that arrives: typing "SONDE" fast
	// enough wrote "SNE", because this replaced the whole document with a value
	// that predated the last letters. An outside change only ever matters when
	// the editor is not the thing being typed into.
	useEffect(() => {
		const v = view.current
		if (!v || v.hasFocus) return
		if (props.value !== v.state.doc.toString()) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } })
	}, [props.value])

	return <div ref={host} className="nt-live" />
}
