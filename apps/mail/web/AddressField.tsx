// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// To / Cc / Bcc with contact suggestions (PLAN P4-1). The last address being
// typed (after the last comma) is completed from Mail's own autocomplete
// (contacts + people you wrote to): GET /apps/mail/api/autoComplete?term=...
import { useEffect, useRef, useState } from 'react'
import { TextField } from '@atrium/ui'
import { autoComplete, type Suggestion } from './api'

/** "a@x, Bo" -> ["a@x, ", "Bo"] */
export function splitLast(value: string): [string, string] {
	const i = value.lastIndexOf(',')
	return i < 0 ? ['', value] : [value.slice(0, i + 1) + ' ', value.slice(i + 1).trimStart()]
}

export const formatSuggestion = (s: Suggestion) => (s.label && s.label !== s.email ? `${s.label} <${s.email}>` : s.email)

export function AddressField({ label, value, onChange, autoFocus, required, placeholder }: { label: string, value: string, onChange: (v: string) => void, autoFocus?: boolean, required?: boolean, placeholder?: string }) {
	const [items, setItems] = useState<Suggestion[]>([])
	const [active, setActive] = useState(0)
	const [focused, setFocused] = useState(false)
	const seq = useRef(0)
	const term = splitLast(value)[1].trim()

	useEffect(() => {
		if (!focused || term.length < 2 || term.includes('@') && term.includes('>')) { setItems([]); return }
		const n = ++seq.current
		const t = setTimeout(() => {
			autoComplete(term).then((r) => { if (n === seq.current) { setItems(r.slice(0, 6)); setActive(0) } }, () => { if (n === seq.current) setItems([]) })
		}, 200)
		return () => clearTimeout(t)
	}, [term, focused])

	const pick = (s: Suggestion) => {
		onChange(`${splitLast(value)[0]}${formatSuggestion(s)}, `)
		setItems([])
	}

	return (
		<div className="ml-addr" onKeyDown={(e) => {
			if (!items.length) return
			if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length) }
			else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length) }
			else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(items[active]) }
			else if (e.key === 'Escape') setItems([])
		}}>
			<TextField label={label} required={required} autoFocus={autoFocus} value={value} placeholder={placeholder} autoComplete="off"
				onChange={(e) => onChange(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)} />
			{items.length > 0 && (
				<ul className="ml-addr__list" role="listbox" aria-label={`${label} suggestions`}>
					{items.map((s, i) => (
						<li key={`${s.email}${i}`} role="option" aria-selected={i === active}>
							<button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
								<strong>{s.label || s.email}</strong>{s.label && s.label !== s.email && <small>{s.email}</small>}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}
