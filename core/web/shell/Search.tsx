// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Global search in the header: Nextcloud's unified search over OCS.
//   GET search/providers                          -> the providers
//   GET search/providers/<id>/search?term=&limit= -> { name, entries: [{ title, subline, resourceUrl, thumbnailUrl, icon }] }
// Providers are queried in parallel; groups appear as their answers arrive.
import { useEffect, useMemo, useRef, useState } from 'react'
import { navigate, ocs } from '@atrium/sdk'
import { Icon, Spinner, cx } from '@atrium/ui'

interface Provider { id: string, name: string, icon: string, order: number, inAppSearch: boolean }
interface Entry { title: string, subline: string, resourceUrl: string, thumbnailUrl: string, icon: string, rounded?: boolean }
interface Group { id: string, name: string, icon: string, order: number, entries: Entry[] }

let providerCache: Promise<Provider[]> | null = null
const loadProviders = () => (providerCache ??= ocs<Provider[]>('search/providers').catch((e) => { providerCache = null; throw e }))

/** Same-origin results open inside the shell; classic /index.php/ prefixes are dropped. */
function open(url: string) {
	try {
		const u = new URL(url, location.origin)
		if (u.origin === location.origin) {
			navigate(u.pathname.replace(/^\/index\.php(?=\/)/, '') + u.search + u.hash)
			return
		}
	} catch {}
	window.open(url, '_blank', 'noopener')
}

const imgUrl = (s: string) => (s.startsWith('/') || /^https?:/.test(s) || s.startsWith('data:') ? s : '')

export function Search() {
	const [term, setTerm] = useState('')
	const [focused, setFocused] = useState(false)
	const [expanded, setExpanded] = useState(false) // phone: the icon button turned into a bar
	const [groups, setGroups] = useState<Group[]>([])
	const [pending, setPending] = useState(0)
	const [active, setActive] = useState(0)
	const [searched, setSearched] = useState('')
	const input = useRef<HTMLInputElement>(null)
	const root = useRef<HTMLDivElement>(null)

	// Debounced fan-out over all providers; a new term cancels the old requests.
	useEffect(() => {
		const q = term.trim()
		if (q.length < 2) { setGroups([]); setPending(0); setSearched(''); return }
		const ctl = new AbortController()
		const timer = setTimeout(async () => {
			let providers: Provider[]
			try { providers = await loadProviders() } catch { return }
			setGroups([]); setActive(0); setSearched(q); setPending(providers.length)
			for (const p of providers) {
				ocs<{ name: string, entries: Entry[] }>(`search/providers/${encodeURIComponent(p.id)}/search?term=${encodeURIComponent(q)}&limit=5`, { signal: ctl.signal })
					.then((r) => {
						if (ctl.signal.aborted || !r.entries?.length) return
						setGroups((g) => [...g, { id: p.id, name: r.name || p.name, icon: p.icon, order: p.order, entries: r.entries }].sort((a, b) => a.order - b.order))
					})
					.catch(() => {})
					.finally(() => { if (!ctl.signal.aborted) setPending((n) => n - 1) })
			}
		}, 300)
		return () => { clearTimeout(timer); ctl.abort() }
	}, [term])

	const flat = useMemo(() => groups.flatMap((g) => g.entries.map((e) => ({ e, g }))), [groups])
	useEffect(() => { if (active >= flat.length) setActive(0) }, [flat.length, active])

	// Click outside closes.
	useEffect(() => {
		if (!focused && !expanded) return
		const down = (e: MouseEvent) => {
			if (!root.current?.contains(e.target as Node)) { setFocused(false); setExpanded(false) }
		}
		document.addEventListener('mousedown', down)
		return () => document.removeEventListener('mousedown', down)
	}, [focused, expanded])

	useEffect(() => {
		if (expanded) input.current?.focus()
	}, [expanded])
	useEffect(() => {
		document.querySelector(`.shell-search__item[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
	}, [active])

	const close = () => { setFocused(false); setExpanded(false); input.current?.blur() }
	const choose = (url: string) => { close(); setTerm(''); open(url) }
	const showPanel = (focused || expanded) && term.trim().length >= 2 && searched === term.trim()

	function onKeyDown(e: React.KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault()
			if (term && showPanel) setFocused(false)
			else close()
		} else if (e.key === 'ArrowDown') {
			e.preventDefault(); setFocused(true)
			if (flat.length) setActive((a) => (a + 1) % flat.length)
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			if (flat.length) setActive((a) => (a - 1 + flat.length) % flat.length)
		} else if (e.key === 'Enter') {
			const it = flat[active]
			if (it) { e.preventDefault(); choose(it.e.resourceUrl) }
		}
	}

	let i = -1
	return (
		<div ref={root} className={cx('shell-search', expanded && 'shell-search--expanded', focused && 'shell-search--focus')} role="search">
			<button type="button" className="at-icon-btn shell-search__toggle" aria-label="Search" onClick={() => setExpanded(true)}><Icon name="search" /></button>
			<div className="shell-search__field">
				<Icon name="search" className="shell-search__icon" />
				<input
					ref={input}
					type="text"
					role="combobox"
					aria-expanded={showPanel}
					aria-controls="shell-search-results"
					aria-label="Search"
					placeholder="Search"
					autoComplete="off"
					value={term}
					onChange={(e) => { setTerm(e.target.value); setFocused(true) }}
					onFocus={() => setFocused(true)}
					onKeyDown={onKeyDown}
				/>
				{pending > 0 && <Spinner small />}
				{(term || expanded) && <button type="button" className="at-icon-btn shell-search__clear" aria-label={term ? 'Clear search' : 'Close search'} onClick={() => { if (term) { setTerm(''); input.current?.focus() } else close() }}><Icon name="close" /></button>}
			</div>
			{showPanel && (
				<div className="shell-search__panel" id="shell-search-results" role="listbox">
					{groups.map((g) => (
						<div key={g.id} className="shell-search__group" role="group" aria-label={g.name}>
							<div className="shell-search__heading">{imgUrl(g.icon) && <img src={g.icon} alt="" />}{g.name}</div>
							{g.entries.map((e, k) => {
								const idx = ++i
								const pic = imgUrl(e.thumbnailUrl) || imgUrl(e.icon)
								return (
									<button
										key={k} type="button" role="option" aria-selected={idx === active} data-i={idx}
										className={cx('shell-search__item', idx === active && 'is-active')}
										onMouseEnter={() => setActive(idx)}
										onClick={() => choose(e.resourceUrl)}
									>
										<span className={cx('shell-search__pic', (e.rounded || !e.thumbnailUrl) && 'is-round')}>{pic ? <img src={pic} alt="" /> : imgUrl(g.icon) ? <img src={g.icon} alt="" /> : <Icon name="search" />}</span>
										<span className="shell-search__text">
											<span className="shell-search__title">{e.title}</span>
											{e.subline && <span className="shell-search__sub">{e.subline}</span>}
										</span>
									</button>
								)
							})}
						</div>
					))}
					{!groups.length && (pending > 0
						? <div className="shell-search__empty"><Spinner small /> Searching...</div>
						: <div className="shell-search__empty">No results for "{searched}"</div>)}
				</div>
			)}
		</div>
	)
}
