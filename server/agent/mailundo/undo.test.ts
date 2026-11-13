// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Undo delete (P4-1): the mail is found in Trash by Message-ID and moved back.
import { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { type Db, migrate, wrap } from '../db'
import { seedMail } from '../mail/fixture'
import { undoDelete } from './index'

let db: Db
let moves: Array<[string, number, number]>
const bridge = { move: async (u: string, id: number, dest: number) => { moves.push([u, id, dest]) } }

beforeEach(async () => {
	db = wrap(new SQL('sqlite://:memory:'), 'sqlite', 'oc_')
	await migrate(db)
	await seedMail(db)
	moves = []
})

test('the mail in Trash goes back to its folder', async () => {
	// Fixture: mail 5 <d@x> is in Trash (12) of account 1 (ann).
	expect(await undoDelete(db, bridge, 'ann', { account: 1, message_id: '<d@x>', to: 10 })).toEqual({ restored: true, to: 10 })
	expect(moves).toEqual([['ann', 5, 10]])
})

test('not in Trash yet, already back, wrong folder, other user, bad input', async () => {
	await expect(undoDelete(db, bridge, 'ann', { account: 1, message_id: '<nope@x>', to: 10 })).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('try again') })
	// <c@x> is in INBOX 10, not in Trash: asking to put it back in INBOX is a no-op.
	expect(await undoDelete(db, bridge, 'ann', { account: 1, message_id: '<c@x>', to: 10 })).toEqual({ restored: false, to: 10 })
	await expect(undoDelete(db, bridge, 'ann', { account: 1, message_id: '<d@x>', to: 20 })).rejects.toMatchObject({ code: 'invalid_input' })
	await expect(undoDelete(db, bridge, 'bob', { account: 1, message_id: '<d@x>', to: 10 })).rejects.toMatchObject({ code: 'not_found' })
	await expect(undoDelete(db, bridge, 'ann', { account: 1, to: 10 })).rejects.toMatchObject({ code: 'invalid_input' })
	expect(moves).toEqual([])
})
