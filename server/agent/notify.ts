// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Optional owner pings over ntfy (approval requests, a refused doorbell).
// Configured with ATRIUM_NTFY_URL (the topic URL, e.g. https://ntfy.example/atrium)
// and optionally ATRIUM_NTFY_TOKEN. Without a URL nothing is sent.
import type { Notifier } from './events'

export function ntfyNotifier(url: string | undefined, token?: string, fetcher: typeof fetch = fetch): Notifier | null {
	if (!url) return null
	return {
		async notify(title, message, opts = {}) {
			const headers: Record<string, string> = { Title: title.replace(/[^\x20-\x7e]/g, '?') }
			if (opts.tags?.length) headers.Tags = opts.tags.join(',')
			if (opts.priority) headers.Priority = String(opts.priority)
			if (opts.click) headers.Click = opts.click
			if (token) headers.Authorization = `Bearer ${token}`
			const res = await fetcher(url, { method: 'POST', headers, body: message, signal: AbortSignal.timeout(10_000) })
			await res.body?.cancel().catch(() => {})
		},
	}
}
