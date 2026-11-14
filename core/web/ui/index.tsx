// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @atrium/ui: the design system. Shared by the shell and every app through the
// import map (one React, one copy of the components). Styles: ui.css.
import {
	createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
	type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
	type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { icons, iconPaths, isFilled, type IconName } from './icons'

import { sectionIcon } from './icons'
export { icons, sectionIcon, type IconName }

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')
export { cx }

/** Wavium's wave W, inline (never a broken image), in currentColor. */
export const WAVIUM_W_PATH = 'M42 176 C68 137 91 104 119 76 C135 60 151 54 165 64 C179 74 183 96 191 119 C204 157 218 187 242 187 C264 187 280 160 294 132 C308 105 322 78 341 68 C354 61 368 68 380 82 C393 98 402 119 415 133 L475 39 L454 145 C447 181 428 218 402 218 C379 218 361 191 345 165 C333 146 322 127 311 128 C299 129 287 158 272 185 C252 222 232 247 205 247 C172 247 151 210 136 171 C126 145 117 119 107 117 C97 115 79 143 63 166 Z'
export function WaviumMark({ size = 32, className, title }: { size?: number, className?: string, title?: string }) {
	return (
		<svg className={cx('at-wavium', className)} viewBox="30 30 456 226" width={size * 2} height={size} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title} fill="currentColor">
			<path d={WAVIUM_W_PATH} />
		</svg>
	)
}

export function Icon({ name, size, className, title }: { name: IconName | string, size?: 's' | 'l', className?: string, title?: string }) {
	const known = iconPaths(name)
	// An unknown name is taken as raw filled path data (app glyphs such as Daily Todo's sunset).
	const d = known ?? name
	const solid = known === undefined || isFilled(name)
	return (
		<svg className={cx('at-icon', solid && 'at-icon--solid', size && `at-icon--${size}`, className)} viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
			{title && <title>{title}</title>}
			{d.split('|').map((p, i) => <path key={i} d={p} />)}
		</svg>
	)
}

type ButtonVariant = 'filled' | 'tonal' | 'outlined' | 'text' | 'danger'
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant
	size?: 's' | 'm' | 'l'
	icon?: IconName
	block?: boolean
	busy?: boolean
}
export function Button({ variant = 'filled', size = 'm', icon, block, busy, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
	return (
		<button
			type={type}
			className={cx('at-btn', variant !== 'filled' && `at-btn--${variant}`, size !== 'm' && `at-btn--${size}`, block && 'at-btn--block', className)}
			disabled={disabled || busy}
			{...rest}>
			{busy ? <span className="at-spinner at-spinner--s" /> : icon && <Icon name={icon} />}
			{children}
		</button>
	)
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	icon: IconName
	label: string
	variant?: 'standard' | 'filled' | 'tonal'
}
export function IconButton({ icon, label, variant = 'standard', className, type = 'button', ...rest }: IconButtonProps) {
	return (
		<button type={type} className={cx('at-icon-btn', variant !== 'standard' && `at-icon-btn--${variant}`, className)} aria-label={label} title={label} {...rest}>
			<Icon name={icon} />
		</button>
	)
}

export function Fab({ icon, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName }) {
	return <button type="button" className="at-fab" {...rest}><Icon name={icon} />{children}</button>
}

interface FieldShell { label: string, hint?: string, error?: string, icon?: IconName, className?: string }
function useHasValue(value: unknown, defaultValue: unknown) {
	return value !== undefined ? String(value ?? '') !== '' : String(defaultValue ?? '') !== ''
}
export function TextField({ label, hint, error, icon, className, value, defaultValue, onChange, ...rest }: FieldShell & InputHTMLAttributes<HTMLInputElement>) {
	const id = useId()
	const [filled, setFilled] = useState(useHasValue(value, defaultValue))
	const has = value !== undefined ? String(value ?? '') !== '' : filled
	const always = rest.type === 'date' || rest.type === 'time' || rest.type === 'datetime-local' || !!rest.placeholder
	return (
		<div className={cx('at-field', error && 'at-field--error', className)}>
			<div className={cx('at-field__box', (has || always) && 'has-value')}>
				{icon && <Icon name={icon} />}
				<input id={id} value={value} defaultValue={defaultValue} onChange={(e) => { setFilled(e.target.value !== ''); onChange?.(e) }} aria-invalid={!!error} {...rest} />
				<label htmlFor={id}>{label}</label>
			</div>
			{(error || hint) && <div className="at-field__hint">{error || hint}</div>}
		</div>
	)
}
export function TextArea({ label, hint, error, className, value, ...rest }: FieldShell & TextareaHTMLAttributes<HTMLTextAreaElement>) {
	const id = useId()
	return (
		<div className={cx('at-field', error && 'at-field--error', className)}>
			<div className={cx('at-field__box', String(value ?? rest.defaultValue ?? '') !== '' && 'has-value')}>
				<textarea id={id} value={value} {...rest} />
				<label htmlFor={id}>{label}</label>
			</div>
			{(error || hint) && <div className="at-field__hint">{error || hint}</div>}
		</div>
	)
}
export function Select({ label, hint, className, children, ...rest }: FieldShell & SelectHTMLAttributes<HTMLSelectElement>) {
	const id = useId()
	return (
		<div className={cx('at-field', className)}>
			<div className="at-field__box has-value">
				<select id={id} {...rest}>{children}</select>
				<label htmlFor={id}>{label}</label>
			</div>
			{hint && <div className="at-field__hint">{hint}</div>}
		</div>
	)
}
export function SearchBar({ value, onChange, placeholder = 'Search', autoFocus }: { value: string, onChange: (v: string) => void, placeholder?: string, autoFocus?: boolean }) {
	return (
		<div className="at-search">
			<Icon name="search" />
			<input type="search" value={value} placeholder={placeholder} aria-label={placeholder} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />
			{value && <IconButton icon="close" label="Clear" onClick={() => onChange('')} />}
		</div>
	)
}

export function Checkbox({ label, round, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode, round?: boolean }) {
	return <label className={cx('at-check', round && 'at-check--round', className)}><input type="checkbox" {...rest} />{label}</label>
}
export function Switch({ label, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
	return <label className={cx('at-switch', className)}><input type="checkbox" role="switch" {...rest} />{label}</label>
}

export function Card({ variant = 'filled', className, children, ...rest }: { variant?: 'filled' | 'elevated' | 'outlined', className?: string, children?: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
	return <div className={cx('at-card', variant !== 'filled' && `at-card--${variant}`, className)} {...rest}>{children}</div>
}

export function Avatar({ name, src, size = 40 }: { name: string, src?: string | null, size?: number }) {
	const [broken, setBroken] = useState(false)
	const initials = name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?'
	return (
		<span className="at-avatar" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">
			{src && !broken ? <img src={src} alt="" onError={() => setBroken(true)} /> : initials}
		</span>
	)
}

export function ListItem({ title, subtitle, meta, leading, trailing, selected, onClick, href }: {
	title: ReactNode, subtitle?: ReactNode, meta?: ReactNode, leading?: ReactNode, trailing?: ReactNode,
	selected?: boolean, onClick?: () => void, href?: string,
}) {
	const cls = cx('at-list-item', (onClick || href) && 'at-list-item--clickable', selected && 'at-list-item--selected')
	const body = (
		<>
			{leading}
			<div className="at-list-item__text">
				<span className="at-list-item__title">{title}</span>
				{subtitle && <span className="at-list-item__sub">{subtitle}</span>}
			</div>
			{meta && <span className="at-list-item__meta">{meta}</span>}
			{trailing}
		</>
	)
	if (href) return <li><a className={cls} href={href} onClick={onClick ? (e) => { e.preventDefault(); onClick() } : undefined}>{body}</a></li>
	return (
		<li className={cls} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
			onKeyDown={onClick ? (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onClick() } } : undefined}>
			{body}
		</li>
	)
}

export function Spinner({ small }: { small?: boolean }) {
	return <span className={cx('at-spinner', small && 'at-spinner--s')} role="progressbar" aria-label="Loading" />
}
export function Progress({ value }: { value: number }) {
	return <div className="at-progress" role="progressbar" aria-valuenow={Math.round(value * 100)}><div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} /></div>
}
export function EmptyState({ icon = 'info', title, children }: { icon?: IconName, title: string, children?: ReactNode }) {
	return <div className="at-empty"><Icon name={icon} /><div className="at-title">{title}</div>{children}</div>
}
export function Badge({ children }: { children: ReactNode }) {
	return <span className="at-badge">{children}</span>
}
export function Chip({ selected, icon, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean, icon?: IconName }) {
	return <button type="button" className={cx('at-chip', selected && 'at-chip--selected')} aria-pressed={selected} {...rest}>{icon && <Icon name={icon} />}{children}</button>
}
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T, label: string }[], value: T, onChange: (id: T) => void }) {
	return (
		<div className="at-tabs" role="tablist">
			{tabs.map((t) => (
				<button key={t.id} type="button" role="tab" aria-selected={t.id === value} className={cx('at-tab', t.id === value && 'at-tab--active')} onClick={() => onChange(t.id)}>{t.label}</button>
			))}
		</div>
	)
}

export function Dialog({ open, title, onClose, children, actions }: { open: boolean, title?: string, onClose: () => void, children?: ReactNode, actions?: ReactNode }) {
	useEffect(() => {
		if (!open) return
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [open, onClose])
	if (!open) return null
	return createPortal(
		<div className="at-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
			<div className="at-dialog" role="dialog" aria-modal="true" aria-label={title}>
				{title && <h2 className="at-dialog__title">{title}</h2>}
				{children}
				{actions && <div className="at-dialog__actions">{actions}</div>}
			</div>
		</div>,
		document.body,
	)
}

export interface MenuEntry { label: string, icon?: IconName, onClick?: () => void, href?: string, danger?: boolean }
export function Menu({ trigger, items, align = 'end' }: { trigger: (open: () => void, expanded: boolean) => ReactNode, items: (MenuEntry | null | false)[], align?: 'start' | 'end' }) {
	const [pos, setPos] = useState<{ x: number, y: number } | null>(null)
	const anchor = useRef<HTMLSpanElement>(null)
	const menu = useRef<HTMLDivElement>(null)
	const open = useCallback(() => {
		const r = anchor.current!.getBoundingClientRect()
		setPos({ x: align === 'end' ? r.right : r.left, y: r.bottom + 4 })
	}, [align])
	useLayoutEffect(() => {
		if (!pos || !menu.current) return
		const m = menu.current.getBoundingClientRect()
		let x = align === 'end' ? pos.x - m.width : pos.x
		x = Math.max(8, Math.min(x, window.innerWidth - m.width - 8))
		let y = pos.y
		if (y + m.height > window.innerHeight - 8) y = Math.max(8, pos.y - m.height - 48)
		menu.current.style.left = `${x}px`
		menu.current.style.top = `${y}px`
	}, [pos, align])
	useEffect(() => {
		if (!pos) return
		const close = (e: Event) => { if (!menu.current?.contains(e.target as Node)) setPos(null) }
		const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setPos(null) }
		setTimeout(() => window.addEventListener('mousedown', close), 0)
		window.addEventListener('keydown', key)
		window.addEventListener('resize', () => setPos(null), { once: true })
		return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key) }
	}, [pos])
	return (
		<>
			<span ref={anchor} style={{ display: 'inline-flex' }}>{trigger(open, !!pos)}</span>
			{pos && createPortal(
				<div ref={menu} className="at-menu" role="menu" style={{ left: -9999, top: -9999 }}>
					{items.filter((i): i is MenuEntry => !!i).map((i) => i.href
						? <a key={i.label} role="menuitem" className={cx('at-menu__item', i.danger && 'at-menu__item--danger')} href={i.href} onClick={() => setPos(null)}>{i.icon && <Icon name={i.icon} />}{i.label}</a>
						: <button key={i.label} type="button" role="menuitem" className={cx('at-menu__item', i.danger && 'at-menu__item--danger')} onClick={() => { setPos(null); i.onClick?.() }}>{i.icon && <Icon name={i.icon} />}{i.label}</button>)}
				</div>,
				document.body,
			)}
		</>
	)
}

// Snackbars: toast('Saved'), toast.error('Failed'), toast('Deleted', { action: { label: 'Undo', onClick } })
interface Toast { id: number, text: string, error?: boolean, action?: { label: string, onClick: () => void } }
type ToastFn = ((text: string, opts?: Partial<Omit<Toast, 'id' | 'text'>>) => void) & { error: (text: string) => void }
const listeners = new Set<(t: Toast[]) => void>()
let toasts: Toast[] = []
let nextId = 1
const emit = () => listeners.forEach((l) => l(toasts))
export const toast: ToastFn = Object.assign(
	(text: string, opts: Partial<Omit<Toast, 'id' | 'text'>> = {}) => {
		const t = { id: nextId++, text, ...opts }
		toasts = [...toasts.slice(-2), t]
		emit()
		setTimeout(() => { toasts = toasts.filter((x) => x.id !== t.id); emit() }, opts.action ? 7000 : 4000)
	},
	{ error: (text: string) => toast(text, { error: true }) },
)
export function Snackbars() {
	const [list, setList] = useState<Toast[]>(toasts)
	useEffect(() => { listeners.add(setList); return () => { listeners.delete(setList) } }, [])
	return createPortal(
		<div className="at-snackbars" aria-live="polite">
			{list.map((t) => (
				<div key={t.id} className={cx('at-snackbar', t.error && 'at-snackbar--error')}>
					<span style={{ flex: 1 }}>{t.text}</span>
					{t.action && <Button variant="text" size="s" onClick={() => { t.action!.onClick(); toasts = toasts.filter((x) => x.id !== t.id); emit() }}>{t.action.label}</Button>}
					<IconButton icon="close" label="Dismiss" onClick={() => { toasts = toasts.filter((x) => x.id !== t.id); emit() }} style={{ color: 'inherit' }} />
				</div>
			))}
		</div>,
		document.body,
	)
}

export function confirmDialog(message: string, opts: { title?: string, confirm?: string, danger?: boolean } = {}): Promise<boolean> {
	return new Promise((resolve) => {
		const host = document.createElement('div')
		document.body.append(host)
		import('react-dom/client').then(({ createRoot }) => {
			const root = createRoot(host)
			const done = (v: boolean) => { root.unmount(); host.remove(); resolve(v) }
			root.render(
				<Dialog open title={opts.title ?? 'Are you sure?'} onClose={() => done(false)} actions={<>
					<Button variant="text" onClick={() => done(false)}>Cancel</Button>
					<Button variant={opts.danger ? 'danger' : 'filled'} onClick={() => done(true)} autoFocus>{opts.confirm ?? 'OK'}</Button>
				</>}>
					<p style={{ margin: 0 }}>{message}</p>
				</Dialog>,
			)
		})
	})
}

// App layout: navigation pane + main area. The shell gives each app the full
// area below its header; apps use this for the Nextcloud-style layout.
const NavCtx = createContext<{ open: boolean, setOpen: (v: boolean) => void }>({ open: false, setOpen: () => {} })
export function AppLayout({ nav, children }: { nav?: ReactNode, children: ReactNode }) {
	const [open, setOpen] = useState(false)
	useEffect(() => {
		if (!open) return
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [open])
	return (
		<NavCtx.Provider value={{ open, setOpen }}>
			<div className="at-app">
				{nav && <nav className={cx('at-app-nav', open && 'at-app-nav--open')} onClick={(e) => { if ((e.target as HTMLElement).closest('a,button')) setOpen(false) }}>
					<div className="at-app-nav__close at-only-mobile"><IconButton icon="close" label="Close navigation" onClick={() => setOpen(false)} /></div>
					{nav}
				</nav>}
				{/* Phone: the drawer covers its own toggle, so tapping outside closes it. */}
				{nav && open && <div className="at-app-nav__scrim at-only-mobile" onClick={() => setOpen(false)} />}
				<main className="at-app-main">{children}</main>
			</div>
		</NavCtx.Provider>
	)
}
export function NavToggle() {
	const { open, setOpen } = useContext(NavCtx)
	return <IconButton className="at-only-mobile" icon="menu" label="Navigation" onClick={() => setOpen(!open)} />
}
export function NavItem({ icon, label, active, onClick, href, count, actions }: { icon?: IconName | string, label: string, active?: boolean, onClick?: () => void, href?: string, count?: number, actions?: ReactNode }) {
	const content = <>{icon && (icon.startsWith('/') ? <img src={icon} alt="" className="at-icon" /> : <Icon name={icon} />)}<span>{label}</span>{count ? <span className="at-label at-muted">{count}</span> : null}{actions}</>
	const cls = cx('at-app-nav__item', active && 'at-app-nav__item--active')
	if (href) return <a className={cls} href={href} aria-current={active ? 'page' : undefined} onClick={onClick ? (e) => { e.preventDefault(); onClick() } : undefined}>{content}</a>
	return <button type="button" className={cls} aria-current={active ? 'page' : undefined} onClick={onClick}>{content}</button>
}
/** A group in the navigation pane, with an optional caption. */
export function NavSection({ title, children, id, collapsible, actions }: { title?: string, children?: ReactNode, id?: string, collapsible?: boolean, actions?: ReactNode }) {
	// Open by default; the choice is remembered per section (id) in this browser.
	const key = id ? `at-nav-closed:${id}` : null
	const [open, setOpen] = useState(() => { try { return !(key && localStorage.getItem(key)) } catch { return true } })
	const toggle = () => {
		setOpen(!open)
		try { if (key) { if (open) localStorage.setItem(key, '1'); else localStorage.removeItem(key) } } catch { /* not remembered */ }
	}
	return <div className="at-app-nav__group">
		{title && (collapsible
			? <div className="at-app-nav__section at-app-nav__section--fold">
				<button type="button" className="at-app-nav__fold" aria-expanded={open} onClick={toggle}><Icon name="expandMore" className={open ? '' : 'at-app-nav__chev--shut'} /><span>{title}</span></button>
				{actions}
			</div>
			: <div className="at-app-nav__section">{title}</div>)}
		{(!collapsible || open) && children}
	</div>
}

/** Debounced value, for search fields. */
export function useDebounced<T>(value: T, ms = 250): T {
	const [v, setV] = useState(value)
	useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
	return v
}
