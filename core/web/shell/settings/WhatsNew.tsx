// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What's new: the version this Wavium is, then every version before it. The
// header badge links here. Content is core/web/shell/whatsnew.ts (one entry per
// version in CHANGELOG.md); the Nextcloud release underneath comes from
// status.php, the same place Settings > Overview reads it.
import { formatDate, request, useAsync, type Session } from '@atrium/sdk'
import { Card, Icon } from '@atrium/ui'
import { CURRENT, RELEASES } from '../whatsnew'

/** The release day, in the reader's own format (formatDate is the shell's). */
const day = (iso: string) => {
	const t = Date.parse(iso)
	return Number.isNaN(t) ? iso : formatDate(t, { day: 'numeric', month: 'long', year: 'numeric' })
}

export function WhatsNew({ session }: { session: Session }) {
	const status = useAsync(() => request<{ versionstring: string, productname: string }>('/status.php'), [])
	const name = session.capabilities.theming?.name ?? 'Wavium'

	return (
		<section className="settings-section">
			<h2 className="at-headline">What's new</h2>
			<p className="at-muted">
				You are on {name} <strong>{CURRENT}</strong>
				{status.data ? <> · built on Nextcloud {status.data.versionstring}</> : null}
			</p>
			<ol className="whatsnew">
				{RELEASES.map((r) => (
					<li key={r.version} className={'whatsnew__item' + (r.version === CURRENT ? ' whatsnew__item--current' : '')}>
						<Card variant={r.version === CURRENT ? 'elevated' : 'outlined'} className="whatsnew__card">
							<header className="whatsnew__head">
								<h3>
									{r.version}
									{r.version === CURRENT && <span className="whatsnew__now"><Icon name="check" size="s" />You are here</span>}
								</h3>
								<time dateTime={r.date} className="at-muted">{day(r.date)}</time>
							</header>
							<p className="whatsnew__headline">{r.headline}</p>
							<ul className="whatsnew__list">
								{r.items.map((item, i) => <li key={i}>{item}</li>)}
							</ul>
						</Card>
					</li>
				))}
			</ol>
		</section>
	)
}
