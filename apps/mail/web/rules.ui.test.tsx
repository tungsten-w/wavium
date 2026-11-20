// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mail > Rules (P5-3) against a fake server: the AI proposes, nothing is saved
// until the click; save and file now; toggle, apply, delete.
import '../../../core/web/testing/dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { fakeServer, type FakeServer } from '../../../core/web/testing/fakeServer'
import { cleanup, click, getButton, getByText, getField, queryByText, render, type, waitFor } from '../../../core/web/testing/render'
import { MailRules, type RuleView } from './Rules'

let server: FakeServer
let rules: RuleView[]
const saved: RuleView = { id: 7, name: 'Factures EDF', account: 1, when: { from_domain: 'edf.fr' }, then: { move_to: 13, mark_read: true }, enabled: true, description: 'from edf.fr → move to Admin, mark read' }

beforeEach(() => {
	rules = []
	server = fakeServer()
		.on('GET', '/agent/v1/rules', () => ({ rules, accounts: [{ id: 1, email: 'alice@atrium.test' }], recent: rules.length ? [{ rule_id: 7, subject: 'Facture novembre', at: 1_800_000_000 }] : [] }))
		.on('POST', '/agent/v1/rules/propose', () => ({
			rule: { name: 'Factures EDF', account: 1, when: { from_domain: 'edf.fr' }, then: { move_to: 13, mark_read: true }, source_text: 'factures EDF dans Admin' },
			description: 'from edf.fr → move to Admin, mark read',
			preview: { scanned: 200, count: 2, sample: [{ subject: 'Facture novembre', from: 'factures@edf.fr' }] },
		}))
		.on('POST', '/agent/v1/rules', () => { rules = [saved]; return saved })
		.on('POST', '/agent/v1/rules/7/apply', () => ({ applied: 2 }))
		.on('PATCH', '/agent/v1/rules/7', (req) => { rules = [{ ...saved, ...(req.body as object) }]; return rules[0] })
		.on('DELETE', '/agent/v1/rules/7', () => { rules = []; return { deleted: true } })
})
afterEach(() => { cleanup(); server.restore() })

test('the AI proposes; nothing is saved before the click; save and file now', async () => {
	const { container } = await render(<MailRules />)
	await waitFor(() => getByText(container, 'No rules yet.'))
	await type(getField(container, 'Describe it in your own words'), 'factures EDF dans Admin')
	await click(getButton(container, 'Propose'))
	const p = await waitFor(() => container.querySelector('[aria-label="Proposed rule"]'))
	expect(server.calls('POST', '/agent/v1/rules/propose')[0].body).toEqual({ text: 'factures EDF dans Admin', account: 1 })
	expect(p.textContent).toContain('from edf.fr → move to Admin, mark read')
	expect(p.textContent).toContain('Matches 2 of the last 200 mails')
	expect(getByText(p, 'Facture novembre')).toBeTruthy()
	expect(server.calls('POST', '/agent/v1/rules')).toHaveLength(0)

	await click(getButton(p, 'Save and file these 2 now'))
	await waitFor(() => server.calls('POST', '/agent/v1/rules/7/apply').length === 1)
	expect(server.calls('POST', '/agent/v1/rules')[0].body).toMatchObject({ name: 'Factures EDF', account: 1, when: { from_domain: 'edf.fr' } })
	expect(server.calls('POST', '/agent/v1/rules')[0].headers.get('ocs-apirequest')).toBe('true')
	await waitFor(() => container.querySelector('[data-rule="7"]'))
	expect(container.querySelector('[aria-label="Proposed rule"]')).toBeNull()
	expect(getByText(container, 'Recently filed')).toBeTruthy()
})

test('cancel keeps nothing; toggle, apply and delete a saved rule', async () => {
	rules = [saved]
	const { container } = await render(<MailRules />)
	const row = await waitFor(() => container.querySelector<HTMLElement>('[data-rule="7"]'))
	await click(row.querySelector('input')!)
	await waitFor(() => server.calls('PATCH', '/agent/v1/rules/7').length === 1)
	expect(server.calls('PATCH', '/agent/v1/rules/7')[0].body).toEqual({ enabled: false })
	await click(getButton(row, 'Apply now'))
	await waitFor(() => server.calls('POST', '/agent/v1/rules/7/apply').length === 1)
	await click(getButton(container.querySelector('[data-rule="7"]')!, 'Delete rule Factures EDF'))
	await waitFor(() => getByText(container, 'No rules yet.'))

	await type(getField(container, 'Describe it in your own words'), 'x')
	await click(getButton(container, 'Propose'))
	await click(getButton(await waitFor(() => container.querySelector<HTMLElement>('[aria-label="Proposed rule"]')), 'Cancel'))
	expect(queryByText(container, /Matches 2/)).toBeNull()
	expect(server.calls('POST', '/agent/v1/rules')).toHaveLength(0)
})

test('all my accounts: the default with two accounts; saving makes one rule per account and files on each', async () => {
	const two = { rules: [] as RuleView[], accounts: [{ id: 1, email: 'alice@atrium.test' }, { id: 3, email: 'alice@gmail.com' }], recent: [] }
	server.restore()
	server = fakeServer()
		.on('GET', '/agent/v1/rules', () => two)
		.on('POST', '/agent/v1/rules/propose', () => ({
			rule: { name: 'Factures EDF', account: 1, when: { from_domain: 'edf.fr' }, then: { move_to: 13 }, source_text: 'factures EDF dans Archive' },
			description: 'from edf.fr → move to Archive', preview: { scanned: 40, count: 3, sample: [] }, all_accounts: true,
		}))
		.on('POST', '/agent/v1/rules', () => ({ rules: [{ ...saved, id: 7 }, { ...saved, id: 8, account: 3 }], skipped: [] }))
		.on('POST', /^\/agent\/v1\/rules\/\d+\/apply$/, () => ({ applied: 1 }))
	const { container } = await render(<MailRules />)
	await waitFor(() => getButton(container, 'Propose'))
	expect((getField(container, 'Account') as HTMLSelectElement).value).toBe('all')
	await type(getField(container, 'Describe it in your own words'), 'factures EDF dans Archive')
	await click(getButton(container, 'Propose'))
	expect(server.calls('POST', '/agent/v1/rules/propose')[0].body).toEqual({ text: 'factures EDF dans Archive', all_accounts: true })
	await waitFor(() => queryByText(container, 'Matches 3 of the last 40 mails in your inboxes, e.g.:'))
	await click(getButton(container, 'Save and file these 3 now'))
	await waitFor(() => server.calls('POST', '/agent/v1/rules/8/apply').length === 1 || null)
	expect(server.calls('POST', '/agent/v1/rules')[0].body).toMatchObject({ all_accounts: true, account: 1 })
	expect(server.calls('POST', '/agent/v1/rules/7/apply')).toHaveLength(1)
})
