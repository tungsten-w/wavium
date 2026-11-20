// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Appearance: light/dark/system (per browser), accent colour and wallpaper (per
// user, stored by the theming app so classic pages and other devices match).
import { useState } from 'react'
import { ocs, type Session } from '@atrium/sdk'
import { Card, Icon, TextField, toast } from '@atrium/ui'
import { getAccent, getMode, getMotion, setMotion, type MotionMode, getServerAccent, getWallpaper, setAccent, setMode, setWallpaper, type ThemeMode } from '../theme'

const COLORS = ['#00679e', '#0b57d0', '#6750a4', '#8e4585', '#b3261e', '#c26401', '#7c5800', '#386a20', '#006a6a', '#455a64']
const MODES: { id: ThemeMode, label: string, bg: string, fg: string }[] = [
	{ id: 'system', label: 'System', bg: 'linear-gradient(135deg, #f8f9ff 50%, #111418 50%)', fg: '#888' },
	{ id: 'light', label: 'Light', bg: '#f8f9ff', fg: '#191c20' },
	{ id: 'dark', label: 'Dark', bg: '#111418', fg: '#e1e2e8' },
]
const THEMING_IDS: Record<ThemeMode, string> = { system: 'default', light: 'light', dark: 'dark' }
/** Shipped images (apps/theming/img/background), with a preview in preview/. */
const IMAGES = [
	'jo-myoung-hee-fluid.webp', 'jenna-kim-the-globe.webp', 'kamil-porembinski-clouds.jpg', 'hannah-maclean-soft-floral.jpg',
	'ted-moravec-morning-fog.jpg', 'stefanus-martanto-setyo-husodo-underwater-ocean.jpg', 'zoltan-voros-rhythm-and-blues.jpg',
	'anatoly-mikhaltsov-butterfly-wing-scale.jpg', 'bernie-cetonia-aurata-take-off-composition.jpg', 'dejan-krsmanovic-ribbed-red-metal.jpg',
	'eduardo-neves-pedra-azul.jpg', 'european-space-agency-barents-bloom.jpg', 'hannes-fritz-flippity-floppity.jpg', 'hannes-fritz-roulette.jpg',
	'hannes-fritz-sea-spray.jpg', 'bernard-spragg-new-zealand-fern.jpg', 'rawpixel-pink-tapioca-bubbles.jpg', 'nasa-waxing-crescent-moon.jpg',
	'tommy-chau-already.jpg', 'tommy-chau-lion-rock-hill.jpg', 'lali-masriera-yellow-bricks.jpg',
]
const imageUrl = (file: string) => `/apps/theming/img/background/${file}`

export function Appearance({ session: _session }: { session: Session }) {
	const [mode, setM] = useState(getMode())
	const [motion, setMo] = useState<MotionMode>(getMotion())
	const serverColor = getServerAccent()?.toLowerCase() ?? null
	const [current, setCurrent] = useState((getAccent() ?? serverColor ?? '#00679e').toLowerCase())
	const [hex, setHex] = useState(current)
	const [wallpaper, setW] = useState(getWallpaper())
	const custom = !COLORS.includes(current) && current !== serverColor

	function pickMode(m: ThemeMode, origin?: { x: number, y: number }) {
		setM(m)
		setMode(m, origin)
		// Classic pages follow the theming app's per-user theme.
		void ocs(`apps/theming/api/v1/theme/${THEMING_IDS[m]}/enable`, { method: 'PUT' }).catch(() => {})
	}
	function pickColor(c: string | null) {
		const next = (c ?? serverColor ?? '#00679e').toLowerCase()
		setCurrent(next)
		setHex(next)
		setAccent(c)
	}
	function pickWallpaper(value: string) {
		setW(value)
		setWallpaper(value, value === 'default' || value === 'color' ? null : imageUrl(value)).catch((e) => toast.error(`Could not save the wallpaper: ${e instanceof Error ? e.message : e}`))
	}

	return (
		<section className="settings-section">
			<h2 className="at-headline">Appearance</h2>
			<p className="at-muted">Choose how Wavium looks. The theme is per device; colour and wallpaper follow your account.</p>
			<Card className="settings-block">
				<h3>Theme</h3>
				<div className="theme-options">
					{MODES.map((m) => (
						<button key={m.id} type="button" className={'theme-option' + (mode === m.id ? ' theme-option--active' : '')} onClick={(e) => pickMode(m.id, { x: e.clientX, y: e.clientY })} aria-pressed={mode === m.id}>
							<span className="swatch" style={{ background: m.bg }} />
							<span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{mode === m.id && <Icon name="check" />}{m.label}</span>
						</button>
					))}
				</div>
			</Card>
			<Card className="settings-block">
				<h3>Animations</h3>
				<div className="theme-options">
					{([['full', 'Lively', 'Pages, lists and charts move in'], ['reduced', 'Calm', 'Almost no movement']] as [MotionMode, string, string][]).map(([id, label, sub]) => (
						<button key={id} type="button" className={'theme-option motion-option motion-option--' + id + (motion === id ? ' theme-option--active' : '')} onClick={() => { setMo(id); setMotion(id) }} aria-pressed={motion === id}>
							<span className="swatch motion-swatch"><span /><span /><span /></span>
							<span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{motion === id && <Icon name="check" />}{label}</span>
							<small className="at-muted">{sub}</small>
						</button>
					))}
				</div>
			</Card>
			<Card className="settings-block">
				<h3>Accent colour</h3>
				<p className="at-muted" style={{ margin: '-4px 0 16px' }}>Wavium builds its light and dark tones, and its default wallpaper, from this colour.</p>
				<div className="accent-grid" role="radiogroup" aria-label="Accent colour">
					{[...(serverColor ? [serverColor] : []), ...COLORS.filter((c) => c !== serverColor)].map((c) => {
						const active = current === c
						return (
							<button key={c} type="button" role="radio" aria-checked={active} className={'accent-tile' + (active ? ' accent-tile--active' : '')} style={{ '--c': c } as React.CSSProperties}
								title={c === serverColor ? 'Server colour' : c} onClick={() => pickColor(c === serverColor ? null : c)}>
								<span className="accent-tile__swatch"><span /><span /><span /></span>
								{active && <span className="accent-tile__check"><Icon name="check" /></span>}
							</button>
						)
					})}
					<label className={'accent-tile accent-tile--custom' + (custom ? ' accent-tile--active' : '')} title="Custom colour" style={custom ? { '--c': current } as React.CSSProperties : undefined}>
						{custom ? <span className="accent-tile__swatch"><span /><span /><span /></span> : <Icon name="palette" />}
						{custom && <span className="accent-tile__check"><Icon name="check" /></span>}
						<input type="color" value={current} onChange={(e) => pickColor(e.target.value)} />
					</label>
				</div>
				<div className="accent-foot">
					<div className="accent-preview" aria-hidden="true">
						<span className="accent-preview__bar" />
						<span className="accent-preview__btn">Button</span>
						<span className="accent-preview__chip">Tonal</span>
						<span className="accent-preview__switch"><span /></span>
					</div>
					<TextField label="Hex" value={hex} onChange={(e) => { setHex(e.target.value); if (/^#[0-9a-f]{6}$/i.test(e.target.value)) pickColor(e.target.value.toLowerCase()) }} className="accent-hex" />
				</div>
			</Card>
			<Card className="settings-block">
				<h3>Wallpaper</h3>
				<p className="at-muted" style={{ margin: '-4px 0 16px' }}>Shown behind the top bar and around your apps.</p>
				<div className="wallpaper-grid" role="radiogroup" aria-label="Wallpaper">
					<WallpaperTile label="Wavium" active={wallpaper === 'default'} className="wallpaper-tile--atrium" onClick={() => pickWallpaper('default')} />
					<WallpaperTile label="Plain" active={wallpaper === 'color'} className="wallpaper-tile--plain" onClick={() => pickWallpaper('color')} />
					{IMAGES.map((f) => (
						<WallpaperTile key={f} active={wallpaper === f} image={`/apps/theming/img/background/preview/${f}`} title={f.replace(/\.\w+$/, '').replace(/-/g, ' ')} onClick={() => pickWallpaper(f)} />
					))}
				</div>
			</Card>
		</section>
	)
}

function WallpaperTile({ label, title, image, active, className, onClick }: { label?: string, title?: string, image?: string, active: boolean, className?: string, onClick: () => void }) {
	return (
		<button type="button" role="radio" aria-checked={active} title={title ?? label} onClick={onClick}
			className={'wallpaper-tile' + (active ? ' wallpaper-tile--active' : '') + (className ? ' ' + className : '')}
			style={image ? { backgroundImage: `url("${image}")` } : undefined}>
			{label && <span className="wallpaper-tile__label">{label}</span>}
			{active && <span className="wallpaper-tile__check"><Icon name="check" /></span>}
		</button>
	)
}
