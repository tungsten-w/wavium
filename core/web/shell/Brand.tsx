// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The instance logo: Wavium's W drawn inline (it can never fail to load, whatever
// host or port the page is opened on), or the logo an admin uploaded in
// Settings > Theming, loaded from this origin.
import { WaviumMark } from '@atrium/ui'

/** True when an admin uploaded their own logo (theming serves it from its image route). */
export const isCustomLogo = (url?: string | null) => !!url && url.includes('/apps/theming/image/logo')

/** The same path on the current origin: an absolute URL built for another host must not break the image. */
export function sameOrigin(url: string): string {
	try {
		const u = new URL(url, location.href)
		return u.pathname + u.search
	} catch {
		return url
	}
}

export function BrandLogo({ logo, size = 24, className }: { logo?: string | null, size?: number, className?: string }) {
	if (isCustomLogo(logo)) return <img className={className} src={sameOrigin(logo!)} alt="" style={{ height: size }} />
	return <WaviumMark size={size} className={className} />
}
