<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Atrium;

use Horde_Imap_Client_Socket;
use OCA\Mail\Attachment;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\IMAP\MessageMapper as ImapMapper;
use OCA\Mail\Service\MailManager;
use OCA\Mail\Service\StoredAttachments;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\Server;
use ReflectionClass;

/**
 * Attachments are kept only after someone downloaded them: opening or syncing a mail stores
 * nothing, the first download stores one copy, the next needs no mail server.
 */
class StoredAttachmentsTest extends MailDbTestCase {
	private StoredAttachments $store;

	protected function setUp(): void {
		parent::setUp();
		$this->store = new StoredAttachments($this->db);
	}

	protected function tearDown(): void {
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_stored_attachments WHERE account_id = ?', [$this->account->getId()]);
		parent::tearDown();
	}

	private function stored(): int {
		return (int)$this->db->executeQuery('SELECT COUNT(*) FROM *PREFIX*mail_stored_attachments WHERE account_id = ?', [$this->account->getId()])->fetchOne();
	}

	private function att(string $id, string $content = 'PDFDATA', ?string $name = 'a.pdf', ?string $disposition = 'attachment'): Attachment {
		return new Attachment($id, $name, 'application/pdf', $content, strlen($content), null, $disposition);
	}

	/** @param list<Attachment> $fromServer what the (mock) mail server returns, counted in $calls */
	private function manager(array $fromServer, int &$calls): MailManager {
		$mm = Server::get(MailManager::class);
		$ref = new ReflectionClass($mm);
		$factory = $this->createMock(IMAPClientFactory::class);
		$factory->method('getClient')->willReturn($this->createMock(Horde_Imap_Client_Socket::class));
		$imap = $this->createMock(ImapMapper::class);
		$imap->method('getAttachment')->willReturnCallback(function ($c, $mb, $uid, $id) use ($fromServer, &$calls) {
			$calls++;
			foreach ($fromServer as $a) {
				if ($a->getId() === $id) {
					return $a;
				}
			}
			throw new DoesNotExistException('no such part');
		});
		$imap->method('getAttachments')->willReturnCallback(function () use ($fromServer, &$calls) {
			$calls++;
			return $fromServer;
		});
		foreach (['imapClientFactory' => $factory, 'imapMessageMapper' => $imap] as $prop => $value) {
			$ref->getProperty($prop)->setValue($mm, $value);
		}
		return $mm;
	}

	public function testStoreAndFindRoundTripKeepsBytesAndName(): void {
		$bytes = "%PDF\0binary\xff\xfe";
		$this->assertTrue($this->store->store($this->account->getId(), 'h1', $this->att('2', $bytes, 'Rechnung ü.pdf')));

		$a = $this->store->find($this->account->getId(), 'h1', '2');
		$this->assertSame($bytes, $a->getContent());
		$this->assertSame('Rechnung ü.pdf', $a->getName());
		$this->assertSame('application/pdf', $a->getType());
		$this->assertNull($this->store->find($this->account->getId(), 'h1', '3'));
		$this->assertNull($this->store->find($this->account->getId(), 'other', '2'));
	}

	public function testInlineAndOversizedAndPartlessAreNotKept(): void {
		$this->assertFalse($this->store->store($this->account->getId(), 'h', $this->att('2', 'x', 'logo.png', 'inline')));
		$this->assertFalse($this->store->store($this->account->getId(), 'h', $this->att('3', str_repeat('x', StoredAttachments::MAX_BYTES + 1))));
		$this->assertFalse($this->store->store($this->account->getId(), 'h', new Attachment(null, 'n', 'a/b', 'x', 1, null, null)));
		$this->assertSame(0, $this->stored());
	}

	public function testStoringTwiceKeepsOneCopy(): void {
		$this->assertTrue($this->store->store($this->account->getId(), 'h', $this->att('2')));
		$this->assertFalse($this->store->store($this->account->getId(), 'h', $this->att('2')));
		$this->assertSame(1, $this->stored());
	}

	public function testNothingIsStoredUntilADownloadAndTheSecondDownloadSkipsTheServer(): void {
		$inbox = $this->mailbox('INBOX');
		$m = $this->serverMail($inbox, 7, '<att@t>');
		$calls = 0;
		$mm = $this->manager([$this->att('2'), $this->att('3', 'OTHER', 'b.pdf')], $calls);
		$this->assertSame(0, $this->stored(), 'a synced mail has no attachment stored');

		$first = $mm->getMailAttachment($this->account, $inbox, $m, '2');
		$this->assertSame(1, $calls);
		$this->assertSame(1, $this->stored(), 'only the downloaded one');

		$second = $mm->getMailAttachment($this->account, $inbox, $m, '2');
		$this->assertSame(1, $calls, 'served from Atrium, no mail server');
		$this->assertSame($first->getContent(), $second->getContent());
	}

	public function testDownloadAllKeepsThemAndAGoneMailStillServesWhatWasDownloaded(): void {
		$inbox = $this->mailbox('INBOX');
		$m = $this->serverMail($inbox, 7, '<att@t>');
		$calls = 0;
		$mm = $this->manager([$this->att('2'), $this->att('3', 'OTHER', 'b.pdf')], $calls);
		$mm->getMailAttachments($this->account, $inbox, $m);
		$this->assertSame(2, $this->stored());

		// The mail leaves the server: Atrium keeps it (uid < 1) and still has the downloaded files.
		$this->db->executeStatement('UPDATE *PREFIX*mail_messages SET uid = ?, server_gone_at = ? WHERE id = ?', [-$m->getId(), 1700000000, $m->getId()]);
		$m->setUid(-$m->getId());
		$m->setServerGoneAt(1700000000);
		$calls = 0;

		$this->assertCount(2, $mm->getMailAttachments($this->account, $inbox, $m));
		$this->assertSame('OTHER', $mm->getMailAttachment($this->account, $inbox, $m, '3')->getContent());
		$this->assertSame(0, $calls, 'no mail server involved');
	}

	public function testGoneMailWithANeverDownloadedAttachmentSaysSo(): void {
		$inbox = $this->mailbox('INBOX');
		$m = $this->serverMail($inbox, 7, '<att@t>');
		$m->setUid(-$m->getId());
		$m->setServerGoneAt(1700000000);
		$calls = 0;
		$mm = $this->manager([$this->att('2')], $calls);

		$this->expectException(DoesNotExistException::class);
		$mm->getMailAttachment($this->account, $inbox, $m, '2');
	}
}
