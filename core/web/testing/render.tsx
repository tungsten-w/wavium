// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test helper for the React UIs (happy-dom): render a tree, wait for text,
// click and type like a user. No testing library: plain DOM + React's act().
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AppCtx, navigate, type AppContext, type Session } from '@atrium/sdk'

// React only runs act() warnings-free with this flag.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export interface Rendered {
	container: HTMLElement
	unmount(): void
}

let mounted: { root: Root, container: HTMLElement }[] = []

export async function render(node: ReactNode): Promise<Rendered> {
	const container = document.createElement('div')
	document.body.append(container)
	const root = createRoot(container)
	await act(async () => { root.render(node) })
	const entry = { root, container }
	mounted.push(entry)
	return {
		container,
		unmount: () => {
			act(() => root.unmount())
			container.remove()
			mounted = mounted.filter((m) => m !== entry)
		},
	}
}

/** Unmount everything rendered (call in afterEach). */
export function cleanup(): void {
	for (const { root, container } of mounted) {
		act(() => root.unmount())
		container.remove()
	}
	mounted = []
	document.body.innerHTML = ''
}

export const testSession: Session = { uid: 'alice', displayName: 'Alice', email: 'alice@atrium.test', isAdmin: false, groups: [], language: 'en', locale: 'en', theme: {} } as unknown as Session

/** Renders an app's Component the way the shell does, at `path` below /apps/<id>. */
export async function renderApp(appId: string, Component: React.ComponentType, path = '/', ctx: Partial<AppContext> = {}) {
	const titles: string[] = []
	const value: AppContext = { appId, basePath: `/apps/${appId}`, session: testSession, setTitle: (t) => { titles.push(t) }, ...ctx }
	await act(async () => { navigate(`/apps/${appId}${path === '/' ? '/' : path}`) })
	const r = await render(<AppCtx.Provider value={value}><Component /></AppCtx.Provider>)
	return { ...r, titles }
}

/** Lets pending promises and effects settle. */
export async function flush(times = 5): Promise<void> {
	for (let i = 0; i < times; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

/** Waits until `fn` stops throwing (or returns a truthy value), up to `timeout` ms. */
export async function waitFor<T>(fn: () => T, timeout = 2000): Promise<NonNullable<T>> {
	const until = Date.now() + timeout
	let last: unknown
	for (;;) {
		try {
			const v = fn()
			if (v) return v as NonNullable<T>
			last = new Error('waitFor: falsy result')
		} catch (e) {
			last = e
		}
		if (Date.now() > until) throw last
		await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
	}
}

const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()

/** The smallest element whose text contains `wanted`. */
export function getByText(root: ParentNode, wanted: string | RegExp): HTMLElement {
	const all = [...root.querySelectorAll<HTMLElement>('*')].filter((el) => typeof wanted === 'string' ? text(el).includes(wanted) : wanted.test(text(el)))
	const smallest = all.filter((el) => !all.some((o) => o !== el && el.contains(o)))
	if (!smallest.length) throw new Error(`no element with text ${wanted}. Page: ${text(root as Element).slice(0, 400)}`)
	return smallest[0]
}

export function queryByText(root: ParentNode, wanted: string | RegExp): HTMLElement | null {
	try { return getByText(root, wanted) } catch { return null }
}

/** A button (or link) by its text or aria-label / title. */
export function getButton(root: ParentNode, name: string): HTMLElement {
	const els = [...root.querySelectorAll<HTMLElement>('button, a, [role=button]')]
	const el = els.find((b) => text(b) === name || b.getAttribute('aria-label') === name || b.getAttribute('title') === name)
		?? els.find((b) => text(b).includes(name))
	if (!el) throw new Error(`no button "${name}". Buttons: ${els.map((b) => text(b) || b.getAttribute('aria-label')).filter(Boolean).join(' | ').slice(0, 400)}`)
	return el
}

/** An input/textarea/select by its label text. */
export function getField(root: ParentNode, label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
	for (const l of root.querySelectorAll('label')) {
		if (!text(l).startsWith(label)) continue
		const id = l.getAttribute('for')
		const el = (id ? (root as Document | Element).querySelector(`#${CSS.escape(id)}`) : null) ?? l.querySelector('input, textarea, select')
		if (el) return el as HTMLInputElement
	}
	const byAria = root.querySelector(`[aria-label="${label}"], [placeholder="${label}"]`)
	if (byAria) return byAria as HTMLInputElement
	throw new Error(`no field "${label}"`)
}

export async function click(el: Element): Promise<void> {
	await act(async () => { (el as HTMLElement).click() })
}

/** Sets a controlled input's value the way React notices (native setter + input event). */
export async function type(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
	const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
	await act(async () => {
		Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
		el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
	})
}

export async function submit(form: HTMLFormElement): Promise<void> {
	await act(async () => { form.requestSubmit() })
}
