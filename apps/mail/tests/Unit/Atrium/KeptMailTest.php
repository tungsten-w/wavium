<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Atrium;

use Horde_Imap_Client;

/**
 * Atrium's copy is the source of truth: mail that leaves the server stays.
 * See docs/lessons.md for the rule.
 */
class KeptMailTest extends MailDbTestCase {
	public function testVanishedMailWithoutOtherCopyIsKeptAndMarked(): void {
		$inbox = $this->mailbox('INBOX');
		$m = $this->serverMail($inbox, 5, '<a@test>');

		$r = $this->messages->retireByUid($inbox, 5);

		$this->assertSame(['kept' => 1, 'dropped' => 0], $r);
		$rows = $this->rows('<a@test>');
		$this->assertCount(1, $rows);
		$this->assertSame($inbox->getId(), $rows[0]['mailbox_id'], 'stays listed in its folder');
		$this->assertNotNull($rows[0]['server_gone_at']);
		$this->assertSame(-$rows[0]['id'], $rows[0]['uid'], 'uid becomes -id');
		$this->assertSame(2, $this->recipients($m->getId()), 'sender and recipient rows are kept');
	}

	public function testKeptRowsAreNeverReportedAsServerUids(): void {
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($inbox, 5, '<a@test>');
		$this->serverMail($inbox, 7, '<b@test>');
		$this->messages->retireByUid($inbox, 7);

		$this->assertSame([5], $this->messages->findAllUids($inbox));
		$this->assertSame(5, $this->messages->findHighestUid($inbox));
		$this->messages->retireByUid($inbox, 5);
		$this->assertNull($this->messages->findHighestUid($inbox), 'only kept rows: nothing known on the server');
	}

	public function testRetiringTwiceIsHarmless(): void {
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($inbox, 5, '<a@test>');
		$this->messages->retireByUid($inbox, 5);
		$this->assertSame(['kept' => 0, 'dropped' => 0], $this->messages->retireByUid($inbox, 5));
		$this->assertCount(1, $this->rows('<a@test>'));
	}

	public function testMovedMailLeavesNoGhost(): void {
		$inbox = $this->mailbox('INBOX');
		$other = $this->mailbox('Folder');
		$this->serverMail($inbox, 5, '<a@test>');
		$this->serverMail($other, 9, '<a@test>');

		$r = $this->messages->retireByUid($inbox, 5);

		$this->assertSame(['kept' => 0, 'dropped' => 1], $r);
		$rows = $this->rows('<a@test>');
		$this->assertCount(1, $rows);
		$this->assertSame($other->getId(), $rows[0]['mailbox_id']);
		$this->assertNull($rows[0]['server_gone_at']);
	}

	public function testSameMessageIdTwiceInOneBatchKeepsOne(): void {
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($inbox, 5, '<a@test>');
		$this->serverMail($inbox, 6, '<a@test>');
		$this->assertSame(['kept' => 1, 'dropped' => 1], $this->messages->retireByUid($inbox, 5, 6));
		$this->assertCount(1, $this->rows('<a@test>'));
	}

	public function testAlreadyKeptCopyElsewhereMeansNoSecondGhost(): void {
		$trash = $this->mailbox('Trash');
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($trash, 3, '<a@test>');
		$this->messages->retireByUid($trash, 3);
		$this->serverMail($inbox, 5, '<a@test>');
		// The new server row replaced the kept one (it came back).
		$this->assertCount(1, $this->rows('<a@test>'));
		$this->messages->retireByUid($inbox, 5);
		$this->assertCount(1, $this->rows('<a@test>'));
	}

	public function testMailComingBackReplacesTheKeptRow(): void {
		$inbox = $this->mailbox('INBOX');
		$trash = $this->mailbox('Trash');
		$this->serverMail($inbox, 5, '<a@test>');
		$this->messages->retireByUid($inbox, 5);
		$this->assertNotNull($this->rows('<a@test>')[0]['server_gone_at']);

		// Synced later in another folder (moved to Trash, Trash synced after INBOX).
		$this->serverMail($trash, 11, '<a@test>');

		$rows = $this->rows('<a@test>');
		$this->assertCount(1, $rows, 'no duplicate');
		$this->assertSame($trash->getId(), $rows[0]['mailbox_id']);
		$this->assertNull($rows[0]['server_gone_at']);
		$this->assertSame(11, $rows[0]['uid']);
	}

	public function testOtherAccountsDoNotCount(): void {
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($inbox, 5, '<shared@test>');
		// Same Message-ID in another account must not make this one a "move".
		$otherId = $this->account->getId() + 1;
		$this->db->executeStatement('INSERT INTO *PREFIX*mail_mailboxes (name, name_hash, account_id, attributes, delimiter, messages, unseen, selectable, special_use, sync_in_background) VALUES (?, ?, ?, ?, ?, 0, 0, true, ?, false)', ['INBOX', md5('INBOX'), $otherId, '[]', '/', '[]']);
		$otherBox = (int)$this->db->lastInsertId('*PREFIX*mail_mailboxes');
		$this->db->executeStatement('INSERT INTO *PREFIX*mail_messages (uid, message_id, mailbox_id, subject, sent_at, flag_answered, flag_deleted, flag_draft, flag_flagged, flag_seen, flag_forwarded, flag_junk, flag_notjunk, flag_important, flag_mdnsent) VALUES (1, ?, ?, ?, 0, false, false, false, false, false, false, false, false, false, false)', ['<shared@test>', $otherBox, 'x']);
		try {
			$this->assertSame(['kept' => 1, 'dropped' => 0], $this->messages->retireByUid($inbox, 5));
		} finally {
			$this->db->executeStatement('DELETE FROM *PREFIX*mail_messages WHERE mailbox_id = ?', [$otherBox]);
			$this->db->executeStatement('DELETE FROM *PREFIX*mail_mailboxes WHERE id = ?', [$otherBox]);
		}
	}

	public function testDeleteAllKeepsWhatIsOnlyInAtrium(): void {
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($inbox, 5, '<a@test>');
		$this->serverMail($inbox, 6, '<b@test>');
		$this->messages->retireByUid($inbox, 6);
		$this->messages->deleteAll($inbox);
		$this->assertCount(0, $this->rows('<a@test>'));
		$this->assertCount(1, $this->rows('<b@test>'));
	}

	public function testCacheResetRetiresThenTheResyncRestores(): void {
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($inbox, 5, '<a@test>');
		$this->serverMail($inbox, 6, '<gone@test>');
		// UID validity changed: everything is retired, nothing deleted.
		$this->assertSame(['kept' => 2, 'dropped' => 0], $this->messages->retireMailbox($inbox));
		// The initial sync brings back what the server still has, under new UIDs.
		$this->serverMail($inbox, 100, '<a@test>');
		$a = $this->rows('<a@test>');
		$this->assertCount(1, $a);
		$this->assertSame(100, $a[0]['uid']);
		$this->assertNotNull($this->rows('<gone@test>')[0]['server_gone_at'], 'what the server lost stays kept');
	}

	public function testVanishedFolderMovesItsLastCopiesToAFolderThatStays(): void {
		$archive = $this->mailbox('Archive', [Horde_Imap_Client::SPECIALUSE_ARCHIVE]);
		$label = $this->mailbox('Label');
		$this->serverMail($label, 1, '<only@test>');
		$this->serverMail($label, 2, '<both@test>');
		$this->serverMail($archive, 3, '<both@test>');

		$r = $this->messages->retireMailbox($label, $archive);

		$this->assertSame(['kept' => 1, 'dropped' => 1], $r);
		$only = $this->rows('<only@test>');
		$this->assertSame($archive->getId(), $only[0]['mailbox_id']);
		$this->assertNotNull($only[0]['server_gone_at']);
		$this->assertCount(1, $this->rows('<both@test>'));
	}
}
