<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Atrium;

use Horde_Imap_Client_Exception;
use Horde_Imap_Client_Socket;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\IMAP\MessageMapper as ImapMapper;
use OCA\Mail\Service\MailManager;
use OCA\Mail\Service\PendingOps;
use OCP\Server;
use ReflectionClass;

/**
 * DB first for writes: a flag change is saved in Atrium even when the mail server is
 * unreachable, queued, and sent later; the newest change per mail and flag wins.
 */
class PendingOpsTest extends MailDbTestCase {
	private PendingOps $ops;

	protected function setUp(): void {
		parent::setUp();
		$this->ops = new PendingOps($this->db);
	}

	protected function tearDown(): void {
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_pending_ops WHERE account_id = ?', [$this->account->getId()]);
		parent::tearDown();
	}

	private function rowCount(): int {
		return (int)$this->db->executeQuery('SELECT COUNT(*) FROM *PREFIX*mail_pending_ops WHERE account_id = ?', [$this->account->getId()])->fetchOne();
	}

	public function testBackoffDoublesFromOneMinuteAndStopsAtAnHour(): void {
		$this->assertSame(60, PendingOps::backoff(1));
		$this->assertSame(120, PendingOps::backoff(2));
		$this->assertSame(240, PendingOps::backoff(3));
		$this->assertSame(3600, PendingOps::backoff(7));
		$this->assertSame(3600, PendingOps::backoff(40));
		$this->assertSame(60, PendingOps::backoff(0));
	}

	public function testNewestChangeForTheSameMailAndFlagWins(): void {
		$a = $this->account->getId();
		$this->ops->enqueueFlag($a, 5, 9, 'seen', true, '', 1000);
		$this->ops->enqueueFlag($a, 5, 9, 'seen', false, '', 1001);
		$this->ops->enqueueFlag($a, 5, 9, 'flagged', true, '', 1002);
		$this->ops->enqueueFlag($a, 5, 10, 'seen', true, '', 1003);

		$this->assertSame(3, $this->rowCount());
		$due = $this->ops->due(50, 1000 + 7200);
		$this->assertSame([['seen', false], ['flagged', true], ['seen', true]], array_map(fn ($o) => [$o['flag'], $o['value']], $due));
	}

	public function testNothingIsDueBeforeItsBackoffAndOldestComesFirst(): void {
		$a = $this->account->getId();
		$this->ops->enqueueFlag($a, 5, 1, 'seen', true, '', 1000);
		$this->ops->enqueueFlag($a, 5, 2, 'seen', true, '', 1000);

		$this->assertSame([], $this->ops->due(50, 1000 + 59));
		$due = $this->ops->due(50, 1000 + 60);
		$this->assertSame([1, 2], array_map(fn ($o) => $o['uid'], $due));
		$this->assertCount(1, $this->ops->due(1, 1000 + 60));
	}

	public function testFailedWaitsLongerAndGivesUpAfterMaxAttempts(): void {
		$a = $this->account->getId();
		$this->ops->enqueueFlag($a, 5, 1, 'seen', true, '', 1000);
		$op = $this->ops->due(50, 1060)[0];

		$this->ops->failed($op['id'], 0, 'down', 2000); // 1st failure: retry in 60s
		$this->assertSame([], $this->ops->due(50, 2059));
		$op = $this->ops->due(50, 2060)[0];
		$this->assertSame(1, $op['attempts']);

		$this->ops->failed($op['id'], PendingOps::MAX_ATTEMPTS - 1, 'still down', 3000);
		$this->assertSame([], $this->ops->due(50, 3000 + 7200), 'given up, not retried');
		$this->assertSame(1, $this->rowCount(), 'the row is kept for inspection');
		$this->assertSame(0, $this->ops->countPending($a));
	}

	public function testDoneRemovesTheChange(): void {
		$a = $this->account->getId();
		$this->ops->enqueueFlag($a, 5, 1, 'seen', true, '', 1000);
		$this->assertSame(1, $this->ops->countPending($a));
		$this->ops->done($this->ops->due(50, 1060)[0]['id']);
		$this->assertSame(0, $this->rowCount());
	}

	/** A MailManager whose IMAP side behaves as told (reflection: its constructor is large). */
	private function manager(?\Throwable $imapError): MailManager {
		$mm = Server::get(MailManager::class);
		$ref = new ReflectionClass($mm);
		$factory = $this->createMock(IMAPClientFactory::class);
		$factory->method('getClient')->willReturn($this->createMock(Horde_Imap_Client_Socket::class));
		$imap = $this->createMock(ImapMapper::class);
		if ($imapError !== null) {
			$imap->method('addFlag')->willThrowException($imapError);
			$imap->method('removeFlag')->willThrowException($imapError);
			// The real mapper wraps what Horde throws into a ServiceException.
			$imap->method('move')->willThrowException($imapError instanceof \OCA\Mail\Exception\ServiceException ? $imapError : new \OCA\Mail\Exception\ServiceException('move failed', 0, $imapError));
		}
		foreach (['imapClientFactory' => $factory, 'imapMessageMapper' => $imap] as $prop => $value) {
			$p = $ref->getProperty($prop);
			$p->setValue($mm, $value);
		}
		return $mm;
	}

	private function seen(int $messageRowId): bool {
		return (bool)$this->db->executeQuery('SELECT flag_seen FROM *PREFIX*mail_messages WHERE id = ?', [$messageRowId])->fetchOne();
	}

	public function testFlagIsSavedInAtriumAndQueuedWhenTheServerIsDown(): void {
		$inbox = $this->mailbox('INBOX');
		$m = $this->serverMail($inbox, 7, '<f@t>');
		$mm = $this->manager(new Horde_Imap_Client_Exception('connection refused', Horde_Imap_Client_Exception::SERVER_CONNECT));

		$mm->flagMessage($this->account, 'INBOX', 7, 'seen', true);

		$this->assertTrue($this->seen($m->getId()), 'Atrium has the change at once');
		$this->assertSame(1, $this->rowCount());
		$op = $this->ops->due(50, time() + 7200)[0];
		$this->assertSame(['seen', true, 7, $inbox->getId()], [$op['flag'], $op['value'], $op['uid'], $op['mailbox_id']]);
	}

	public function testFlagGoesStraightThroughWhenTheServerIsUp(): void {
		$inbox = $this->mailbox('INBOX');
		$m = $this->serverMail($inbox, 7, '<f@t>');
		$mm = $this->manager(null);

		$mm->flagMessage($this->account, 'INBOX', 7, 'seen', true);

		$this->assertTrue($this->seen($m->getId()));
		$this->assertSame(0, $this->rowCount(), 'nothing to catch up on');
	}

	public function testUndoWhileOfflineLeavesOnlyTheLastChangeQueued(): void {
		$inbox = $this->mailbox('INBOX');
		$m = $this->serverMail($inbox, 7, '<f@t>');
		$mm = $this->manager(new Horde_Imap_Client_Exception('connection refused', Horde_Imap_Client_Exception::SERVER_CONNECT));

		$mm->flagMessage($this->account, 'INBOX', 7, 'seen', true);
		$mm->flagMessage($this->account, 'INBOX', 7, 'seen', false);

		$this->assertFalse($this->seen($m->getId()));
		$this->assertSame(1, $this->rowCount());
		$this->assertFalse($this->ops->due(50, time() + 7200)[0]['value']);
	}

	public function testMailKeptOnlyInAtriumIsNeverQueued(): void {
		$inbox = $this->mailbox('INBOX');
		$m = $this->serverMail($inbox, 7, '<k@t>');
		$this->db->executeStatement('UPDATE *PREFIX*mail_messages SET uid = ?, server_gone_at = ? WHERE id = ?', [-$m->getId(), 1700000000, $m->getId()]);
		$mm = $this->manager(new Horde_Imap_Client_Exception('must not be called', Horde_Imap_Client_Exception::SERVER_CONNECT));

		$mm->flagMessage($this->account, 'INBOX', -$m->getId(), 'seen', true);

		$this->assertTrue($this->seen($m->getId()));
		$this->assertSame(0, $this->rowCount());
	}

	private function offline(): Horde_Imap_Client_Exception {
		return new Horde_Imap_Client_Exception('connection refused', Horde_Imap_Client_Exception::SERVER_CONNECT);
	}

	/** @return array{mailbox_id: int, uid: int, server_gone_at: ?int} */
	private function rowOf(int $id): array {
		$r = $this->db->executeQuery('SELECT mailbox_id, uid, server_gone_at FROM *PREFIX*mail_messages WHERE id = ?', [$id])->fetch();
		return ['mailbox_id' => (int)$r['mailbox_id'], 'uid' => (int)$r['uid'], 'server_gone_at' => $r['server_gone_at'] === null ? null : (int)$r['server_gone_at']];
	}

	public function testMoveWhileOfflineMovesTheMailInAtriumAndQueuesIt(): void {
		$inbox = $this->mailbox('INBOX');
		$archive = $this->mailbox('Archive');
		$m = $this->serverMail($inbox, 7, '<mv@t>');

		$this->manager($this->offline())->moveMessage($this->account, 'INBOX', 7, $this->account, 'Archive');

		$row = $this->rowOf($m->getId());
		$this->assertSame($archive->getId(), $row['mailbox_id'], 'it is in the target folder now');
		$this->assertSame(-$m->getId(), $row['uid'], 'with a stand-in uid, so nothing else touches the server');
		$this->assertNotNull($row['server_gone_at']);
		$op = $this->ops->due(50, time() + 7200)[0];
		$this->assertSame(['move', 7, $inbox->getId(), $archive->getId()], [$op['op'], $op['uid'], $op['mailbox_id'], $op['target_mailbox_id']]);
	}

	public function testStandInIsReplacedWhenTheMovedMailSyncsIntoTheTargetFolder(): void {
		$inbox = $this->mailbox('INBOX');
		$archive = $this->mailbox('Archive');
		$m = $this->serverMail($inbox, 7, '<mv@t>');
		$this->manager($this->offline())->moveMessage($this->account, 'INBOX', 7, $this->account, 'Archive');

		// Later the server has moved it and the Archive sync brings the real row in.
		$this->serverMail($archive, 31, '<mv@t>');

		$rows = $this->rows('<mv@t>');
		$this->assertCount(1, $rows, 'not listed twice');
		$this->assertSame(31, $rows[0]['uid']);
		$this->assertNull($rows[0]['server_gone_at']);
	}

	public function testMoveRefusedByTheServerIsNotQueuedAndNothingChanges(): void {
		$inbox = $this->mailbox('INBOX');
		$this->mailbox('Archive');
		$m = $this->serverMail($inbox, 7, '<mv@t>');
		$refused = new Horde_Imap_Client_Exception('no such folder', Horde_Imap_Client_Exception::NONEXISTENT);

		try {
			$this->manager($refused)->moveMessage($this->account, 'INBOX', 7, $this->account, 'Archive');
			$this->fail('a refusal must reach the caller');
		} catch (\OCA\Mail\Exception\ServiceException) {
		}

		$this->assertSame($inbox->getId(), $this->rowOf($m->getId())['mailbox_id']);
		$this->assertSame(0, $this->rowCount());
	}

	public function testDeleteWhileOfflineMovesToTrashInAtriumAndQueuesIt(): void {
		$inbox = $this->mailbox('INBOX');
		$trash = $this->mailbox('Trash', [\Horde_Imap_Client::SPECIALUSE_TRASH]);
		$this->account->getMailAccount()->setTrashMailboxId($trash->getId());
		$m = $this->serverMail($inbox, 7, '<del@t>');

		$this->manager($this->offline())->deleteMessage($this->account, 'INBOX', 7);

		$this->assertSame($trash->getId(), $this->rowOf($m->getId())['mailbox_id']);
		$op = $this->ops->due(50, time() + 7200)[0];
		$this->assertSame(['move', $trash->getId()], [$op['op'], $op['target_mailbox_id']]);
	}

	public function testFlagRefusedByTheServerIsNotQueued(): void {
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($inbox, 7, '<f@t>');
		$refused = new Horde_Imap_Client_Exception('no permission', Horde_Imap_Client_Exception::NOPERM);

		try {
			$this->manager($refused)->flagMessage($this->account, 'INBOX', 7, 'seen', true);
			$this->fail('a refusal must reach the caller');
		} catch (\OCA\Mail\Exception\ServiceException) {
		}
		$this->assertSame(0, $this->rowCount());
	}

	public function testUnreachableClassification(): void {
		$wrap = static fn (int $code) => new \OCA\Mail\Exception\ServiceException('x', 0, new Horde_Imap_Client_Exception('y', $code));
		$this->assertTrue(PendingOps::isUnreachable($wrap(Horde_Imap_Client_Exception::SERVER_CONNECT)));
		$this->assertTrue(PendingOps::isUnreachable($wrap(Horde_Imap_Client_Exception::DISCONNECT)));
		$this->assertTrue(PendingOps::isUnreachable($wrap(Horde_Imap_Client_Exception::SERVER_READTIMEOUT)));
		$this->assertFalse(PendingOps::isUnreachable($wrap(Horde_Imap_Client_Exception::LOGIN_AUTHENTICATIONFAILED)), 'bad login must not hammer Gmail');
		$this->assertFalse(PendingOps::isUnreachable($wrap(Horde_Imap_Client_Exception::NONEXISTENT)));
		$this->assertFalse(PendingOps::isUnreachable(new \RuntimeException('plain')));
	}

	public function testJobSendsQueuedMovesAndFlagsAndKeepsFailedOnes(): void {
		$inbox = $this->mailbox('INBOX');
		$archive = $this->mailbox('Archive');
		$this->ops->enqueueMove($this->account->getId(), $inbox->getId(), 7, $archive->getId(), '', 1000);
		$this->ops->enqueueFlag($this->account->getId(), $inbox->getId(), 8, 'seen', true, '', 1000);

		$sent = [];
		$mm = $this->createMock(MailManager::class);
		$mm->method('applyMoveOnServer')->willReturnCallback(function ($from, $uid, $to) use (&$sent) {
			$sent[] = ['move', $uid, $to->getName()];
			return 31;
		});
		$mm->method('applyFlagOnServer')->willReturnCallback(function ($a, $mb, $uid, $flag, $value) use (&$sent) {
			$sent[] = ['flag', $uid, $flag, $value];
		});
		$accounts = $this->createMock(\OCA\Mail\Service\AccountService::class);
		$accounts->method('findById')->willReturn($this->account);
		$factory = $this->createMock(IMAPClientFactory::class);
		$factory->method('getClient')->willReturn($this->createMock(Horde_Imap_Client_Socket::class));
		$time = $this->createMock(\OCP\AppFramework\Utility\ITimeFactory::class);
		$time->method('getTime')->willReturn(1000 + 7200);
		$job = new \OCA\Mail\BackgroundJob\PendingOpsJob($time, $this->ops, $accounts, $this->mailboxes, $mm, $factory, $this->createMock(\Psr\Log\LoggerInterface::class));

		$job->drain();

		$this->assertSame([['move', 7, 'Archive'], ['flag', 8, 'seen', true]], $sent);
		$this->assertSame(0, $this->rowCount(), 'sent changes leave the queue');
	}
}
