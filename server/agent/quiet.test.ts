// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// V4-11: quiet hours per agent. No doorbell, no approval ping in the window
// (which may cross midnight, in the owner's time zone), except urgent "now";
// held rings go out when it ends; the digest counts what waits.
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { getSettings, isQuiet, updateSettings, validQuiet } from './access'
import { type Db, migrate, wrap } from './db'
import { buildDigest } from './digest/build'
import { Doorbell, urgentEvent } from './events'
import { webhookPolicy } from './netguard'

let db: Db
const policy = webhookPolicy('', async () => ['93.184.216.34'], false)
let posts: string[]
const fetcher = (async (_url: string, init: RequestInit) => { posts.push(String(init.body)); return new Response(null, { status: 204 }) }) as unknown as typeof fetch

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	posts = []
})

const paris = (hhmm: string) => new Date(`2026-01-15T${hhmm}:00+01:00`)

test('the window crosses midnight in the owner\'s time zone', () => {
	const q = { from: '22:00', to: '07:30', tz: 'Europe/Paris' }
	expect(isQuiet(q, paris('23:15'))).toBe(true)
	expect(isQuiet(q, paris('03:00'))).toBe(true)
	expect(isQuiet(q, paris('07:30'))).toBe(false)
	expect(isQuiet(q, paris('12:00'))).toBe(false)
	expect(isQuiet({ from: '12:00', to: '14:00', tz: 'Europe/Paris' }, paris('13:00'))).toBe(true)
	expect(isQuiet(null, paris('03:00'))).toBe(false)
	expect(() => validQuiet({ from: '25:00', to: '07:00' })).toThrow()
	expect(() => validQuiet({ from: '07:00', to: '07:00' })).toThrow()
	expect(() => validQuiet({ from: '22:00', to: '07:00', tz: 'Mars/Olympus' })).toThrow()
	expect(validQuiet({ from: '22:00', to: '07:00' })).toEqual({ from: '22:00', to: '07:00', tz: 'UTC' })
})

test('quiet hours hold the doorbell, urgent mail rings, the rest goes out in the morning', async () => {
	await updateSettings(db, 'agent-bot', { webhookUrl: 'https://hooks.example.com/d', quiet: { from: '22:00', to: '07:30', tz: 'Europe/Paris' } }, policy)
	expect((await getSettings(db, 'agent-bot')).quiet).toEqual({ from: '22:00', to: '07:30', tz: 'Europe/Paris' })
	const bell = new Doorbell(db, null, fetcher, policy)
	bell.now = () => paris('23:00')
	await bell.ring('agent-bot', 'c_000001', true)
	await bell.ring('agent-bot', 'c_000002', false)
	expect(posts).toEqual([])
	expect(bell.heldFor('agent-bot')).toEqual({ cursor: 'c_000002', wake: false })
	await bell.ring('agent-bot', 'c_000003', true, true) // urgent "now"
	expect(posts.length).toBe(1)
	expect(bell.heldFor('agent-bot')).toBeUndefined()
	await bell.ring('agent-bot', 'c_000004', false)
	await bell.releaseHeld()
	expect(posts.length).toBe(1) // still night
	bell.now = () => paris('07:45')
	await bell.releaseHeld()
	expect(posts.length).toBe(2)
	expect(JSON.parse(posts[1])).toMatchObject({ cursor: 'c_000004' })
})

test('urgent events: mail urgency now, or marked urgent', () => {
	expect(urgentEvent('{"urgency":"now"}')).toBe(true)
	expect(urgentEvent({ triage: { urgency: 'now' } })).toBe(true)
	expect(urgentEvent('{"urgency":"today"}')).toBe(false)
	expect(urgentEvent('not json')).toBe(false)
})

test('the morning digest says how many agent requests wait', async () => {
	const src = { mail: async () => [], events: async () => [], tasks: async () => [], todo: async () => [], approvals: async () => 2 }
	const d = await buildDigest(src, 'alice', { now: new Date('2026-11-17T07:00:00Z'), timezone: 'Europe/Paris' })
	expect(d.counts.approvals).toBe(2)
	expect(d.headline).toBe('2 agent requests wait for your OK')
})
