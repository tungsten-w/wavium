// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal iCalendar / vCard (RFC 5545 / 6350) line model: enough to read and
// edit the common properties while keeping every other line as it was.

export interface VProp {
	name: string
	params: Record<string, string>
	value: string
}
export interface VComponent {
	name: string
	props: VProp[]
	children: VComponent[]
}

export function unfold(text: string): string[] {
	return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((l) => l !== '')
}

function splitParams(s: string): string[] {
	const out: string[] = []
	let cur = ''
	let q = false
	for (const ch of s) {
		if (ch === '"') q = !q
		if (ch === ';' && !q) { out.push(cur); cur = '' } else cur += ch
	}
	out.push(cur)
	return out
}

export function parseLine(line: string): VProp {
	let q = false
	let i = 0
	for (; i < line.length; i++) {
		if (line[i] === '"') q = !q
		if (line[i] === ':' && !q) break
	}
	const head = line.slice(0, i)
	const value = line.slice(i + 1)
	const [name, ...rawParams] = splitParams(head)
	const params: Record<string, string> = {}
	for (const p of rawParams) {
		const eq = p.indexOf('=')
		if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
	}
	return { name: name.toUpperCase(), params, value }
}

export function parseComponent(text: string): VComponent {
	const root: VComponent = { name: '', props: [], children: [] }
	const stack = [root]
	for (const line of unfold(text)) {
		const p = parseLine(line)
		if (p.name === 'BEGIN') {
			const c: VComponent = { name: p.value.toUpperCase(), props: [], children: [] }
			stack[stack.length - 1].children.push(c)
			stack.push(c)
		} else if (p.name === 'END') {
			if (stack.length > 1) stack.pop()
		} else {
			stack[stack.length - 1].props.push(p)
		}
	}
	return root.children[0] ?? root
}

function foldLine(line: string): string {
	const out: string[] = []
	let cur = ''
	let bytes = 0
	for (const ch of line) {
		const b = new TextEncoder().encode(ch).length
		if (bytes + b > 74) { out.push(cur); cur = ' '; bytes = 1 }
		cur += ch
		bytes += b
	}
	out.push(cur)
	return out.join('\r\n')
}

export function serializeComponent(c: VComponent): string {
	const lines: string[] = [`BEGIN:${c.name}`]
	for (const p of c.props) {
		const params = Object.entries(p.params).map(([k, v]) => `;${k}=${/[;:,]/.test(v) ? `"${v}"` : v}`).join('')
		lines.push(foldLine(`${p.name}${params}:${p.value}`))
	}
	for (const ch of c.children) lines.push(serializeComponent(ch))
	lines.push(`END:${c.name}`)
	return lines.join('\r\n')
}

export const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,')
export const unescapeText = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')

export const getProp = (c: VComponent, name: string) => c.props.find((p) => p.name === name)
export const getProps = (c: VComponent, name: string) => c.props.filter((p) => p.name === name)
export function setProp(c: VComponent, name: string, value: string | null, params: Record<string, string> = {}) {
	const i = c.props.findIndex((p) => p.name === name)
	if (value === null || value === '') {
		if (i >= 0) c.props.splice(i, 1)
		return
	}
	const p = { name, params, value }
	if (i >= 0) c.props[i] = p
	else c.props.push(p)
}

export function uuid(): string {
	return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
	})
}
