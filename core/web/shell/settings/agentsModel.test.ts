import { describe, expect, it } from 'vitest'
import { applyCell, describeModes, modesFor, payloadView, sortAreas } from './agentsModel'

const mail = ['read', 'write', 'send', 'delete', 'share'] as const

describe('permission table cells', () => {
	it('read off removes the area; read only offers off/allowed', () => {
		expect(applyCell({ read: 'allowed', write: 'allowed' }, 'read', 'off', [...mail])).toBeNull()
		expect(modesFor('read')).toEqual(['off', 'allowed'])
		expect(modesFor('send')).toEqual(['off', 'allowed', 'approval'])
	})
	it('turning an action on without access grants read too', () => {
		expect(applyCell(undefined, 'send', 'approval', [...mail])).toEqual({ read: 'allowed', send: 'approval' })
		expect(applyCell(undefined, 'write', 'off', [...mail])).toBeNull()
	})
	it('keeps the other cells and drops actions the area lacks', () => {
		expect(applyCell({ read: 'allowed', write: 'allowed', delete: 'approval' }, 'delete', 'allowed', ['read', 'write', 'delete']))
			.toEqual({ read: 'allowed', write: 'allowed', delete: 'allowed' })
		expect(applyCell({ read: 'allowed' }, 'share', 'allowed', ['read', 'write'])).toEqual({ read: 'allowed' })
	})
	it('describes an area in words', () => {
		expect(describeModes(undefined)).toBe('No access')
		expect(describeModes({ read: 'allowed', write: 'allowed', send: 'approval', delete: 'approval', share: 'off' })).toBe('Read, write · send and delete ask you')
		expect(describeModes({ read: 'allowed', send: 'approval' })).toBe('Read · send asks you')
	})
	it('areas with tools come first', () => {
		expect(sortAreas(['notes', 'files', 'mail', 'calendar'], { mail: 12 })).toEqual(['mail', 'calendar', 'files', 'notes'])
	})
})

describe('approval payloads', () => {
	it('shows a mail to send as a mail', () => {
		const v = payloadView('mail_send', {
			draft_key: '1:d:5', from: 'me@x', to: [{ name: 'Jane', address: 'j@x' }, { name: '', address: 'k@x' }], cc: [], bcc: [],
			subject: '', body: 'Hi', attachments: [{ filename: 'a.pdf' }],
		})
		expect(v.rows).toEqual([
			{ label: 'From', value: 'me@x' }, { label: 'To', value: 'Jane <j@x>, k@x' },
			{ label: 'Subject', value: '(no subject)' }, { label: 'Attachments', value: 'a.pdf' },
		])
		expect(v.body).toBe('Hi')
	})
	it('shows other payloads as fields plus JSON', () => {
		expect(payloadView('mail_message_delete', { message_key: '1:abc' })).toEqual({ rows: [{ label: 'message_key', value: '1:abc' }], body: null })
		expect(payloadView('x', { a: 1, b: { c: 2 } }).body).toBe('{\n  "b": {\n    "c": 2\n  }\n}')
	})
})
