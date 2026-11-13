// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A browser-like DOM (happy-dom) for React tests. Import it FIRST in a test
// file: `import '<path>/core/web/testing/dom'`.
//
// Why not `// @vitest-environment happy-dom`: under the Bun runtime that `make
// test-web` uses (`bun --bun vitest`, no Node in the image), vitest's
// environment switch breaks module loading ("Cannot find module <the test>").
// Installing happy-dom's window objects as globals ourselves works on Bun.
import { Window } from 'happy-dom'

const win = new Window({
	url: 'http://atrium.test/',
	// No network from the DOM itself: frames, scripts and styles are not loaded.
	settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true } },
})
const g = globalThis as Record<string, unknown>
// Keep the runtime's own fetch/URL/streams/timers: tests stub fetch themselves.
const keep = new Set(['fetch', 'Request', 'Response', 'Headers', 'URL', 'URLSearchParams', 'ReadableStream', 'WritableStream', 'TransformStream',
	'TextEncoder', 'TextDecoder', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'Blob', 'File', 'FormData',
	'AbortController', 'AbortSignal', 'crypto', 'performance', 'console', 'structuredClone', 'atob', 'btoa', 'process', 'global', 'globalThis'])
for (const key of Object.getOwnPropertyNames(win)) {
	if (keep.has(key) || key.startsWith('_')) continue
	try {
		g[key] = (win as unknown as Record<string, unknown>)[key]
	} catch { /* read-only global */ }
}
g.window = globalThis
// The window's own fetch is not used: tests stub globalThis.fetch.
;(win as unknown as { fetch: typeof fetch }).fetch = (...a: Parameters<typeof fetch>) => globalThis.fetch(...a)

export const domWindow = win
