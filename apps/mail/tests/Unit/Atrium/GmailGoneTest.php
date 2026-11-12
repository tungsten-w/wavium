<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Atrium;

use Horde_Imap_Client;

/**
 * Gmail: every mail sits in [Gmail]/All Mail plus one folder per label
 * (INBOX is a label). The user's case: Google data wiped, Atrium keeps all.
 */
class GmailGoneTest extends MailDbTestCase {
	public function testArchiveInGmailDropsOnlyTheInboxRow(): void {
		$all = $this->mailbox('[Gmail]/All Mail', [Horde_Imap_Client::SPECIALUSE_ALL]);
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($all, 40, '<m@gmail>');
		$this->serverMail($inbox, 7, '<m@gmail>');

		$this->messages->retireByUid($inbox, 7); // archived: leaves INBOX only

		$rows = $this->rows('<m@gmail>');
		$this->assertCount(1, $rows);
		$this->assertSame($all->getId(), $rows[0]['mailbox_id']);
		$this->assertNull($rows[0]['server_gone_at']);
	}

	public function testDeletedForeverInGmailKeepsExactlyOneCopy(): void {
		$all = $this->mailbox('[Gmail]/All Mail', [Horde_Imap_Client::SPECIALUSE_ALL]);
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($all, 40, '<m@gmail>');
		$this->serverMail($inbox, 7, '<m@gmail>');

		// Both folders lose it; they sync one after the other.
		$this->messages->retireByUid($all, 40);
		$this->messages->retireByUid($inbox, 7);

		$rows = $this->rows('<m@gmail>');
		$this->assertCount(1, $rows);
		$this->assertNotNull($rows[0]['server_gone_at']);
	}

	public function testWholeGoogleAccountWipedKeepsEveryMailOnce(): void {
		$all = $this->mailbox('[Gmail]/All Mail', [Horde_Imap_Client::SPECIALUSE_ALL]);
		$inbox = $this->mailbox('INBOX');
		$sent = $this->mailbox('[Gmail]/Sent Mail', [Horde_Imap_Client::SPECIALUSE_SENT]);
		$label = $this->mailbox('Receipts');
		$ids = [];
		for ($i = 1; $i <= 30; $i++) {
			$id = "<w$i@gmail>";
			$ids[] = $id;
			$this->serverMail($all, 100 + $i, $id);
			if ($i % 2 === 0) {
				$this->serverMail($inbox, $i, $id);
			}
			if ($i % 3 === 0) {
				$this->serverMail($label, $i, $id);
			}
			if ($i % 5 === 0) {
				$this->serverMail($sent, $i, $id);
			}
		}

		// Wipe: the label folder vanishes, then every folder empties.
		$this->messages->retireMailbox($label, $all);
		foreach ([$inbox, $all, $sent] as $mb) {
			$this->messages->retireByUid($mb, ...$this->messages->findAllUids($mb));
		}

		foreach ($ids as $id) {
			$rows = $this->rows($id);
			$this->assertCount(1, $rows, "$id kept exactly once");
			$this->assertNotNull($rows[0]['server_gone_at'], "$id marked gone");
		}
		foreach ([$inbox, $all, $sent] as $mb) {
			$this->assertSame([], $this->messages->findAllUids($mb), 'nothing left that the sync would ask the server about');
		}
	}
}
