// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings frame. React sections where they exist; every other classic section
// (from core/atrium/session) opens in a frame with its own navigation hidden.
import type { ComponentType } from 'react'
import { navigate, useLocation, type Session } from '@atrium/sdk'
import { AppLayout, NavItem, NavSection, NavToggle, sectionIcon } from '@atrium/ui'
import type { AppIndex } from '../apps'
import { LegacyFrame } from '../LegacyFrame'
import { Profile } from './Profile'
import { Security } from './Security'
import { Appearance } from './Appearance'
import { Agents } from './Agents'
import { Users } from './Users'
import { Apps } from './Apps'
import { AdminSharing, AdminTheming, Overview, PersonalSharing, Server } from './Admin'
import { AdminSecurity, Delegation, Groupware, Notifications, Presets } from './Extra'

interface ReactSection { path: string, label: string, icon: string, admin?: boolean, replaces?: string, Component: ComponentType<{ session: Session }> }

/** Paths owned by React; the classic section with the same id is hidden from the list. */
const SECTIONS: ReactSection[] = [
	{ path: '/settings/user', label: 'Profile', icon: 'user-circle', replaces: 'personal-info', Component: Profile },
	{ path: '/settings/user/security', label: 'Security', icon: 'shield-lock', replaces: 'security', Component: Security },
	{ path: '/settings/user/theming', label: 'Appearance', icon: 'palette', replaces: 'theming', Component: Appearance },
	{ path: '/settings/user/sharing', label: 'Sharing', icon: 'share', replaces: 'sharing', Component: PersonalSharing },
	{ path: '/settings/user/notifications', label: 'Notifications', icon: 'bell', replaces: 'notifications', Component: Notifications },
	{ path: '/settings/user/agents', label: 'Agents', icon: 'agent', Component: Agents },
	{ path: '/settings/admin/overview', label: 'Overview', icon: 'dashboard', admin: true, replaces: 'overview', Component: Overview },
	{ path: '/settings/admin/server', label: 'Basic settings', icon: 'settings', admin: true, replaces: 'server', Component: Server },
	{ path: '/settings/users', label: 'Accounts', icon: 'group', admin: true, Component: Users },
	{ path: '/settings/apps', label: 'Apps', icon: 'extension', admin: true, Component: Apps },
	{ path: '/settings/admin/sharing', label: 'Sharing', icon: 'share', admin: true, replaces: 'sharing', Component: AdminSharing },
	{ path: '/settings/admin/theming', label: 'Theming', icon: 'palette', admin: true, replaces: 'theming', Component: AdminTheming },
	{ path: '/settings/admin/security', label: 'Security', icon: 'shield-lock', admin: true, replaces: 'security', Component: AdminSecurity },
	{ path: '/settings/admin/groupware', label: 'Groupware', icon: 'users-group', admin: true, replaces: 'groupware', Component: Groupware },
	{ path: '/settings/admin/presets', label: 'Quick presets', icon: 'adjustments', admin: true, replaces: 'presets', Component: Presets },
	{ path: '/settings/admin/admindelegation', label: 'Administration privileges', icon: 'user-shield', admin: true, replaces: 'admindelegation', Component: Delegation },
	{ path: '/settings/admin/activity', label: 'Activity', icon: 'activity', admin: true, replaces: 'activity', Component: (p) => <Notifications {...p} admin /> },
]

/** In frames: drop the classic section list and let the content use the full width. */
const FRAME_CSS = '#app-navigation,.app-navigation,#app-navigation-vue{display:none!important}#app-content,.app-content{margin-left:0!important;width:100%!important}'

const norm = (p: string) => p.replace(/\/+$/, '') || '/'

export function Settings({ session }: { session: Session, index: AppIndex }) {
	const { pathname, search } = useLocation()
	const path = norm(pathname)
	const sections = SECTIONS.filter((s) => !s.admin || session.user.isAdmin)
	const own = sections.find((s) => path === s.path || (s.path !== '/settings/user' && path.startsWith(s.path + '/')))
	const replaced = (admin: boolean) => new Set(sections.filter((s) => !!s.admin === admin).map((s) => s.replaces).filter(Boolean))
	const personal = session.settingsSections.personal.filter((s) => !replaced(false).has(s.id))
	const admin = session.settingsSections.admin.filter((s) => !replaced(true).has(s.id))

	let content
	if (own) content = <div className="settings-page"><own.Component session={session} /></div>
	else if (path === '/settings' || path === '/settings/personal') content = <div className="settings-page"><Profile session={session} /></div>
	else if (path === '/settings/admin' && session.user.isAdmin) content = <div className="settings-page"><Overview session={session} /></div>
	else content = <LegacyFrame key={path.split('/').slice(0, 4).join('/')} src={pathname + search} css={FRAME_CSS} />

	return (
		<AppLayout nav={<>
			<NavSection title="Personal">
				{sections.filter((s) => !s.admin).map((s) => <NavItem key={s.path} icon={s.icon} label={s.label} href={s.path} active={own === s} onClick={() => go(s.path)} />)}
				{personal.map((s) => {
					const href = `/settings/user/${s.id}`
					return <NavItem key={s.id} icon={sectionIcon(s.id)} label={s.name} href={href} active={path === href} onClick={() => go(href)} />
				})}
			</NavSection>
			{session.user.isAdmin && (
				<NavSection title="Administration">
					{sections.filter((s) => s.admin).map((s) => <NavItem key={s.path} icon={s.icon} label={s.label} href={s.path} active={own === s} onClick={() => go(s.path)} />)}
					{admin.map((s) => {
						const href = `/settings/admin/${s.id}`
						return <NavItem key={s.id} icon={sectionIcon(s.id)} label={s.name} href={href} active={path === href || (s.id === 'overview' && path === '/settings/admin')} onClick={() => go(href)} />
					})}
				</NavSection>
			)}
		</>}>
			<div className="settings-topbar at-only-mobile"><NavToggle /></div>
			{content}
		</AppLayout>
	)
}

const go = (href: string) => navigate(href)
