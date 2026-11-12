<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Atrium;

use OCA\Mail\Account;
use OCA\Mail\AddressList;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper;
use OCP\IDBConnection;
use OCP\Server;
use PHPUnit\Framework\TestCase;

/**
 * Tests on the real database with a throwaway account id (no mail_accounts
 * row, nothing on any mail server). Everything it creates is removed again.
 */
abstract class MailDbTestCase extends TestCase {
	protected IDBConnection $db;
	protected MessageMapper $messages;
	protected MailboxMapper $mailboxes;
	protected Account $account;
	/** @var Mailbox[] */
	private array $created = [];

	protected function setUp(): void {
		parent::setUp();
		$this->db = Server::get(IDBConnection::class);
		$this->messages = Server::get(MessageMapper::class);
		$this->mailboxes = Server::get(MailboxMapper::class);
		$ma = new MailAccount();
		$ma->setId(900000 + random_int(0, 99999));
		$ma->setUserId('atrium-test-' . bin2hex(random_bytes(3)));
		$ma->setEmail('test@atrium.invalid');
		$this->account = new Account($ma);
	}

	protected function tearDown(): void {
		foreach ($this->created as $mb) {
			$ids = $this->db->executeQuery('SELECT id FROM *PREFIX*mail_messages WHERE mailbox_id = ?', [$mb->getId()])->fetchAll(\PDO::FETCH_COLUMN);
			if ($ids !== []) {
				$this->messages->deleteByIds(...array_map('intval', $ids));
			}
			$this->db->executeStatement('DELETE FROM *PREFIX*mail_mailboxes WHERE id = ?', [$mb->getId()]);
		}
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_bodies WHERE account_id = ?', [$this->account->getId()]);
		parent::tearDown();
	}

	protected function mailbox(string $name, array $specialUse = []): Mailbox {
		$mb = new Mailbox();
		$mb->setName($name);
		$mb->setNameHash(md5($name));
		$mb->setAccountId($this->account->getId());
		$mb->setAttributes('[]');
		$mb->setDelimiter('/');
		$mb->setMessages(0);
		$mb->setUnseen(0);
		$mb->setSelectable(true);
		$mb->setSpecialUse(json_encode($specialUse));
		$mb->setSyncInBackground(false);
		$mb = $this->mailboxes->insert($mb);
		$this->created[] = $mb;
		return $mb;
	}

	/** Insert server rows the way the sync does (MessageMapper::insertBulk). */
	protected function serverMail(Mailbox $mb, int $uid, string $messageId, string $subject = 'Test'): Message {
		$m = new Message();
		$m->setUid($uid);
		$m->setMessageId($messageId);
		$m->setMailboxId($mb->getId());
		$m->setSubject($subject);
		$m->setSentAt(1700000000 + $uid);
		foreach (['Answered', 'Deleted', 'Draft', 'Flagged', 'Seen', 'Forwarded', 'Junk', 'Notjunk', 'Important', 'Mdnsent'] as $f) {
			$m->{'setFlag' . $f}(false);
		}
		$m->setFrom(AddressList::parse('Sender <sender@atrium.invalid>'));
		$m->setTo(AddressList::parse('test@atrium.invalid'));
		$m->setCc(new AddressList([]));
		$m->setBcc(new AddressList([]));
		$this->messages->insertBulk($this->account, $m);
		return $m;
	}

	/** @return list<array{id: int, uid: int, mailbox_id: int, server_gone_at: ?int}> */
	protected function rows(string $messageId): array {
		$rows = $this->db->executeQuery(
			'SELECT m.id, m.uid, m.mailbox_id, m.server_gone_at FROM *PREFIX*mail_messages m JOIN *PREFIX*mail_mailboxes mb ON mb.id = m.mailbox_id WHERE mb.account_id = ? AND m.message_id = ? ORDER BY m.id',
			[$this->account->getId(), $messageId],
		)->fetchAll();
		return array_map(static fn ($r) => ['id' => (int)$r['id'], 'uid' => (int)$r['uid'], 'mailbox_id' => (int)$r['mailbox_id'], 'server_gone_at' => $r['server_gone_at'] === null ? null : (int)$r['server_gone_at']], $rows);
	}

	protected function recipients(int $messageRowId): int {
		return (int)$this->db->executeQuery('SELECT COUNT(*) FROM *PREFIX*mail_recipients WHERE message_id = ?', [$messageRowId])->fetchOne();
	}
}
