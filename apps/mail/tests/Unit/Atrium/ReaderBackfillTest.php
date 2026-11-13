<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Atrium;

use OCA\Mail\Attachment;
use OCA\Mail\Service\PendingOps;
use OCA\Mail\Service\ReaderBackfill;
use OCA\Mail\Service\StoredAttachments;

/**
 * The reader-copy backfill picks only live mail without a reader copy, tries each mail a few
 * times, then marks it unavailable; attachments outlive their retention only when the mail is gone.
 */
class ReaderBackfillTest extends MailDbTestCase {
	private ReaderBackfill $rb;

	protected function setUp(): void {
		parent::setUp();
		$this->rb = new ReaderBackfill($this->db);
	}

	protected function tearDown(): void {
		$a = $this->account->getId();
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_reader_backfill WHERE account_id = ?', [$a]);
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_stored_attachments WHERE account_id = ?', [$a]);
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_pending_ops WHERE account_id = ?', [$a]);
		parent::tearDown();
	}

	private function body(string $messageId, ?string $reader): void {
		$this->db->executeStatement(
			'INSERT INTO *PREFIX*mail_bodies (account_id, msg_hash, headers, body, attachments, has_unsubscribe, sent_at, fetched_at, reader_body) VALUES (?, ?, ?, ?, ?, false, ?, ?, ?)',
			[$this->account->getId(), md5($messageId), 'h', 'b', '', 1, 1, $reader],
		);
	}

	/** @return string[] */
	private function todo(int $limit = 50, ?int $now = null): array {
		return array_map(fn ($r) => $r['message_id'], $this->rb->candidates($this->account->getId(), $limit, $now));
	}

	public function testPicksLiveMailWithoutAReaderCopyNewestFirst(): void {
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($inbox, 1, '<old@t>');
		$this->serverMail($inbox, 2, '<new@t>');
		$this->serverMail($inbox, 3, '<done@t>');
		$this->body('<done@t>', '<p>has copy</p>');
		$this->serverMail($inbox, 4, '<textonly@t>');
		$this->body('<textonly@t>', null);

		$this->assertSame(['<textonly@t>', '<new@t>', '<old@t>'], $this->todo());
		$this->assertSame(['<textonly@t>'], $this->todo(1));
	}

	public function testKeptOnlyMailAndSameMailInTwoFoldersAreHandledOnce(): void {
		$inbox = $this->mailbox('INBOX');
		$all = $this->mailbox('[Gmail]/All Mail');
		$this->serverMail($inbox, 1, '<twice@t>');
		$this->serverMail($all, 9, '<twice@t>');
		$kept = $this->serverMail($inbox, 2, '<kept@t>');
		$this->db->executeStatement('UPDATE *PREFIX*mail_messages SET uid = ?, server_gone_at = ? WHERE id = ?', [-$kept->getId(), 1700000000, $kept->getId()]);

		$this->assertSame(['<twice@t>'], $this->todo());
	}

	public function testFailuresBackOffThenMarkTheMailUnavailable(): void {
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($inbox, 1, '<bad@t>');
		$this->serverMail($inbox, 2, '<ok@t>');
		$a = $this->account->getId();

		$this->rb->recordFailure($a, '<bad@t>', 'Could not load message', 1000);
		$this->assertSame(['<ok@t>'], $this->todo(50, 1000), 'waits an hour before the second try');
		$this->assertSame(['<ok@t>', '<bad@t>'], $this->todo(50, 1000 + 3600));

		$this->rb->recordFailure($a, '<bad@t>', 'Could not load message', 5000);
		$this->assertSame(['<ok@t>'], $this->todo(50, 5000 + 3599));
		$this->rb->recordFailure($a, '<bad@t>', 'Could not load message', 20000);

		$this->assertSame(['<ok@t>'], $this->todo(50, 20000 + 999999), 'after MAX_ATTEMPTS it is never tried again');
		$this->assertSame(['todo' => 1, 'unavailable' => 1], $this->rb->counts($a));
	}

	public function testPurgeDropsOldCopiesOfMailStillOnTheServerButKeepsTheOnlyCopies(): void {
		$inbox = $this->mailbox('INBOX');
		$live = $this->serverMail($inbox, 1, '<live@t>');
		$gone = $this->serverMail($inbox, 2, '<gone@t>');
		$this->db->executeStatement('UPDATE *PREFIX*mail_messages SET uid = ?, server_gone_at = ? WHERE id = ?', [-$gone->getId(), 1700000000, $gone->getId()]);
		$store = new StoredAttachments($this->db);
		$a = $this->account->getId();
		$att = fn (string $id) => new Attachment($id, 'f.pdf', 'application/pdf', 'x', 1, null, 'attachment');
		$day = 86400;
		$now = 1800000000;
		$store->store($a, md5('<live@t>'), $att('2'), $now - 100 * $day);   // old, mail on server: goes
		$store->store($a, md5('<live@t>'), $att('3'), $now - 10 * $day);    // recent: stays
		$store->store($a, md5('<gone@t>'), $att('2'), $now - 400 * $day);   // old, but the only copy: stays
		$store->store($a, md5('<nomail@t>'), $att('2'), $now - 400 * $day); // mail unknown here: stays

		$this->assertSame(1, $store->purge($now));
		$this->assertNull($store->find($a, md5('<live@t>'), '2'));
		$this->assertNotNull($store->find($a, md5('<live@t>'), '3'));
		$this->assertNotNull($store->find($a, md5('<gone@t>'), '2'));
		$this->assertNotNull($store->find($a, md5('<nomail@t>'), '2'));
		$this->assertSame(['count' => 3, 'bytes' => 3], $store->totals([$a]));
		$this->assertSame(['count' => 0, 'bytes' => 0], $store->totals([]));
	}

	public function testQueuedWritesCountPendingAndFailedSeparately(): void {
		$ops = new PendingOps($this->db);
		$a = $this->account->getId();
		$ops->enqueueFlag($a, 5, 1, 'seen', true, '', 1000);
		$ops->enqueueFlag($a, 5, 2, 'seen', true, '', 1000);
		$ops->failed($ops->due(50, 1060)[0]['id'], PendingOps::MAX_ATTEMPTS - 1, 'down', 2000);

		$this->assertSame(1, $ops->countPending($a));
		$this->assertSame(1, $ops->countFailed($a));
	}

	private function job(\Throwable $error): \OCA\Mail\BackgroundJob\ReaderBackfillJob {
		$mm = $this->createMock(\OCA\Mail\Service\MailManager::class);
		$mm->method('getMailbox')->willReturnCallback(fn ($u, $id) => $this->mailboxes->findById($id));
		$mm->method('getImapMessage')->willThrowException($error);
		$accounts = $this->createMock(\OCA\Mail\Service\AccountService::class);
		$accounts->method('find')->willReturn($this->account);
		$factory = $this->createMock(\OCA\Mail\IMAP\IMAPClientFactory::class);
		$factory->method('getClient')->willReturn($this->createMock(\Horde_Imap_Client_Socket::class));
		$time = $this->createMock(\OCP\AppFramework\Utility\ITimeFactory::class);
		$time->method('getTime')->willReturn(1000);
		return new \OCA\Mail\BackgroundJob\ReaderBackfillJob($time, $this->db, $this->rb, $accounts, $mm, \OCP\Server::get(\OCA\Mail\Service\Triage\TriageService::class), $factory, $this->createMock(\Psr\Log\LoggerInterface::class));
	}

	private function attempts(string $messageId): ?int {
		$r = $this->db->executeQuery('SELECT attempts FROM *PREFIX*mail_reader_backfill WHERE account_id = ? AND msg_hash = ?', [$this->account->getId(), md5($messageId)])->fetchOne();
		return $r === false ? null : (int)$r;
	}

	public function testJobRecordsMailsItCannotLoad(): void {
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($inbox, 1, '<gone@t>');

		$this->job(new \RuntimeException('Could not load message'))->drain([[$this->account->getId(), $this->account->getUserId()]]);

		$this->assertSame(1, $this->attempts('<gone@t>'));
	}

	public function testJobStopsOnLoginRefusalWithoutMarkingMails(): void {
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($inbox, 1, '<a@t>');
		$this->serverMail($inbox, 2, '<b@t>');

		$this->job(new \RuntimeException('Authentication failed (login)'))->drain([[$this->account->getId(), $this->account->getUserId()]]);

		$this->assertNull($this->attempts('<a@t>'));
		$this->assertNull($this->attempts('<b@t>'));
		$this->assertCount(2, $this->rb->candidates($this->account->getId(), 50, 1000), 'still to do next time');
	}

	public function testJobDoesNothingAndNeverConnectsWhenThereIsNothingToFill(): void {
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($inbox, 1, '<done@t>');
		$this->body('<done@t>', '<p>x</p>');
		$accounts = $this->createMock(\OCA\Mail\Service\AccountService::class);
		$accounts->expects($this->never())->method('find');
		$job = new \OCA\Mail\BackgroundJob\ReaderBackfillJob(
			$this->createMock(\OCP\AppFramework\Utility\ITimeFactory::class), $this->db, $this->rb, $accounts,
			$this->createMock(\OCA\Mail\Service\MailManager::class), \OCP\Server::get(\OCA\Mail\Service\Triage\TriageService::class),
			$this->createMock(\OCA\Mail\IMAP\IMAPClientFactory::class), $this->createMock(\Psr\Log\LoggerInterface::class),
		);

		$job->drain([[$this->account->getId(), $this->account->getUserId()]]);
	}
}
