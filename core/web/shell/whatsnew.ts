// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What every released version brought, in the words of someone using Wavium
// rather than building it. The header badge shows CURRENT and links to the page
// that lists these (Settings > What's new).
//
// One release here per `## vX` heading in CHANGELOG.md, newest first:
// whatsnew.test.ts fails if the two drift apart, so a new version cannot ship
// with the badge still naming the old one. The changelog keeps the long,
// technical account; this is the short one.

export interface Release {
	/** Tag name, exactly as in CHANGELOG.md and in git: "v4.1". */
	version: string
	/** Release day, ISO (YYYY-MM-DD). */
	date: string
	/** One line: what this version is about. */
	headline: string
	/** What changed, one plain sentence each. */
	items: string[]
}

export const RELEASES: Release[] = [
	{
		version: 'v4.3',
		date: '2026-11-25',
		headline: 'Mail sorting comes alive: a Run now button, and tags you can actually see.',
		items: [
			'Mail: "Run now", next to the Classification switch, sorts your mail straight away instead of waiting up to five minutes -- and says how many it did, or why it did none.',
			'Fixed: tags were painted white on white. 668 of 676 tagged mails showed a chip you could not see. Every tag has a colour now, the ones already stored included.',
			'Agents can tag your mail, not just star it -- which is what sorting it actually needs.',
			'Fixed: classification could never reach the AI. 3401 mails had been waiting on an error on every single one.',
			'Classification turns itself on when you add an AI provider, instead of staying off behind a switch you never saw.',
			'You choose which folders get classified. Before, only Inbox and Spam were ever looked at.',
			'A category for school and university, and the four labels no mail could ever carry are gone.',
			'Fixed: the twice-daily mail brief died silently under cron and left the old one in place.',
		],
	},
	{
		version: 'v4.2',
		date: '2026-11-23',
		headline: 'Mail: your messages show up, and the filters tell you what they are doing.',
		items: [
			'Fixed: a mail account you had just connected looked empty -- "This folder is empty" with the Curated filter, while All showed everything.',
			'A filter that hides every message now says which filter is on, and offers "See all mail".',
			'The filter you pick is remembered, so Mail opens where you left it.',
			'Fixed: Favorites was always empty on Orange, Free, SFR, iCloud and most mail servers. It now lists everything you starred, wherever it is.',
			'Fixed: adding a mail account failed with a bare "HTTP 400". It now says which server refused and why -- and app passwords work with the spaces providers print them with.',
		],
	},
	{
		version: 'v4.1',
		date: '2026-11-23',
		headline: 'The version is now written next to the logo, and a round of fixes.',
		items: [
			'The version sits next to the logo in the header. Click it to read this page.',
			'Fixed: Notes lost letters while you typed -- "Courses" came back as "Couses". What you type is what is saved now.',
			'Fixed: on a new account, changing the accent colour failed with "Internal server error" -- and so did choosing a wallpaper afterwards.',
			'Fixed: a fresh install logged an error on every classic page, for a file the image did not carry.',
			'The screens you see on a brand-new account -- empty lists, "connect your mail" -- are now opened by the tests, on a computer and on a phone.',
		],
	},
	{
		version: 'v4',
		date: '2026-11-20',
		headline: 'Your phone\'s texts, and mail that explains itself.',
		items: [
			'Messages: link your Android phone with a QR code and read, search and answer SMS and RCS from Wavium. Every text is kept here, even the ones deleted on the phone.',
			'Mail says why a mail was put where it was, in plain words, and "Wrong?" moves it and teaches the sorting.',
			'Agents: a Test button for the doorbell, each token shows when and from where it was last used, and quiet hours keep the night silent.',
			'More motion: pages slide, the light/dark switch grows from your click, buttons ripple. All of it off with Calm.',
			'A security check fixed a note preview that could run a script, and tightened what the web server hands out.',
			'Installing works on a Raspberry Pi or any ARM machine, and on a home network with no public name.',
		],
	},
	{
		version: 'v3',
		date: '2026-11-14',
		headline: 'A public demo anyone can try.',
		items: [
			'Demo mode: shared accounts with fake data, a banner saying when it resets, and a link to send feedback.',
			'Everything a stranger should not touch is locked: passwords, accounts, mail servers, share links, AI keys.',
			'The dev stack can be published on a VPN address behind a reverse proxy.',
		],
	},
	{
		version: 'v2.1',
		date: '2026-11-14',
		headline: 'Leaving Google, in a few clicks.',
		items: [
			'Known mail providers fill in their own servers, and Gmail can use Sign in with Google.',
			'Settings > Move from Google brings over Gmail, Calendar, Contacts and Drive.',
			'Settings > Tutorial: an illustrated nine-step tour.',
			'The logo is drawn in the page, so it can never show up broken.',
			'One command installs Wavium on a server.',
		],
	},
	{
		version: 'v2',
		date: '2026-11-14',
		headline: 'Wavium gets its name, and the apps grow up.',
		items: [
			'Mail: tags, rich text, undo delete, conversations, snooze.',
			'Calendar: invitations and answers, subscriptions, appointment pages.',
			'Tasks: repeating tasks, manual order, shared lists.',
			'Agents: several per account, an activity page, and a custom connector for claude.ai.',
			'A generic install with automatic HTTPS, backup and restore.',
		],
	},
	{
		version: 'v1',
		date: '2026-11-13',
		headline: 'The first Wavium: a hub built for agents.',
		items: [
			'A new interface served by Bun, and an agent layer with permissions, approvals and events.',
			'The AI provider is yours to choose (Anthropic, OpenAI, Mistral, Ollama, ...), with budgets and a model per task.',
			'Mail organiser: sorting, a morning digest, reply drafts that are never sent on their own, rules in plain language, scam warnings, assisted unsubscribe.',
			'Mail is never deleted: Wavium keeps its own copy.',
		],
	},
]

/** The version this build is: what the header badge shows. */
export const CURRENT = RELEASES[0].version

/** Release for a version name, or undefined. */
export const releaseOf = (version: string): Release | undefined => RELEASES.find((r) => r.version === version)
