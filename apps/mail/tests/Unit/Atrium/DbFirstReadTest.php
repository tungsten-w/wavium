<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Atrium;

use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Controller\MessagesController;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\IMAP\MessageMapper as ImapMapper;
use OCA\Mail\IMAP\PreviewEnhancer;
use OCA\Mail\IMAP\Search\Provider as ImapSearchProvider;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\DelegationService;
use OCA\Mail\Service\Search\FilterStringParser;
use OCA\Mail\Service\Search\MailSearch;
use OCA\Mail\Service\Triage\TriageService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IRequest;
use OCP\Server;
use ReflectionClass;

/**
 * Atrium's DB first: listing, scrolling, searching and opening mail never ask
 * the mail server. Every IMAP entry point is a mock that fails if it is used.
 */
class DbFirstReadTest extends MailDbTestCase {
	private function storeText(string $messageId, string $text, ?string $readerBody = null, ?array $meta = null): void {
		$this->db->executeStatement(
			'INSERT INTO *PREFIX*mail_bodies (account_id, msg_hash, headers, body, attachments, has_unsubscribe, sent_at, fetched_at, reader_body, reader_meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			[$this->account->getId(), md5($messageId), "From: Sender\nSubject: Stored", $text, '', false, 1700000000, 1700000001, $readerBody, $meta === null ? null : json_encode($meta)],
		);
	}

	private function cached(\OCA\Mail\Db\Mailbox $mb): void {
		$mb->setSyncNewToken('x');
		$mb->setSyncChangedToken('x');
		$mb->setSyncVanishedToken('x');
		$this->mailboxes->update($mb);
	}

	private function noImapFactory(): IMAPClientFactory {
		$f = $this->createMock(IMAPClientFactory::class);
		$f->expects($this->never())->method('getClient');
		return $f;
	}

	public function testListingFillsPreviewsFromStoredTextWithoutTheServer(): void {
		$inbox = $this->mailbox('INBOX');
		$m = $this->serverMail($inbox, 5, '<p@test>');
		$this->storeText('<p@test>', "Hello   there,\n\nthis is the stored text.");
		$imap = $this->createMock(ImapMapper::class);
		$imap->expects($this->never())->method($this->anything());
		$enhancer = new PreviewEnhancer(
			$this->noImapFactory(), $imap, $this->messages,
			$this->createMock(\Psr\Log\LoggerInterface::class),
			$this->createMock(\OCA\Mail\Service\AvatarService::class),
			Server::get(\OCA\Mail\Service\Attachment\AttachmentService::class),
			$this->db,
		);

		$out = $enhancer->process($this->account, $inbox, [$m], true, $this->account->getUserId());

		$this->assertSame('Hello there, this is the stored text.', $out[0]->getPreviewText());
		$this->assertSame('Hello there, this is the stored text.', $this->db->executeQuery('SELECT preview_text FROM *PREFIX*mail_messages WHERE id = ?', [$m->getId()])->fetchOne());
	}

	public function testBodySearchUsesStoredTextNotTheServer(): void {
		$inbox = $this->mailbox('INBOX');
		$this->cached($inbox);
		$hit = $this->serverMail($inbox, 5, '<hit@test>');
		$this->serverMail($inbox, 6, '<miss@test>');
		$kept = $this->serverMail($inbox, 7, '<kept@test>');
		$this->messages->retireByUid($inbox, 7);
		$this->storeText('<hit@test>', 'The invoice for October is attached.');
		$this->storeText('<miss@test>', 'Nothing to see.');
		$this->storeText('<kept@test>', 'Old INVOICE from 2019.');
		$provider = $this->createMock(ImapSearchProvider::class);
		$provider->expects($this->never())->method('findMatches');
		$enhancer = $this->createMock(PreviewEnhancer::class);
		$enhancer->method('process')->willReturnArgument(2);
		$search = new MailSearch(Server::get(FilterStringParser::class), $provider, $this->messages, $enhancer, Server::get(ITimeFactory::class), $this->db);

		$found = $search->findMessages($this->account, $inbox, 'DESC', 'body:invoice', null, 20, $this->account->getUserId(), 'singleton');
		$ids = array_map(static fn ($m) => $m->getId(), $found);
		sort($ids);
		$this->assertSame([$hit->getId(), $kept->getId()], $ids, 'kept mail is searchable too');
	}

	public function testListIsNotBlockedByARunningSync(): void {
		$inbox = $this->mailbox('INBOX');
		$inbox->setSyncNewLock(time());
		$this->cached($inbox);
		$this->serverMail($inbox, 5, '<a@test>');
		$enhancer = $this->createMock(PreviewEnhancer::class);
		$enhancer->method('process')->willReturnArgument(2);
		$search = new MailSearch(Server::get(FilterStringParser::class), $this->createMock(ImapSearchProvider::class), $this->messages, $enhancer, Server::get(ITimeFactory::class), $this->db);
		$this->assertCount(1, $search->findMessages($this->account, $inbox, 'DESC', null, null, 20, $this->account->getUserId(), 'singleton'));
	}

	private function controller(\OCA\Mail\Db\Message $message, \OCA\Mail\Db\Mailbox $mailbox): MessagesController {
		$userId = $this->account->getUserId();
		$mm = $this->createMock(IMailManager::class);
		$mm->method('getMessage')->willReturn($message);
		$mm->method('getMailbox')->willReturn($mailbox);
		$mm->expects($this->never())->method('getImapMessage');
		$as = $this->createMock(AccountService::class);
		$as->method('find')->willReturn($this->account);
		$ds = $this->createMock(DelegationService::class);
		$ds->method('resolveMessageUserId')->willReturn($userId);
		$given = [
			'appName' => 'mail', 'request' => $this->createMock(IRequest::class), 'userId' => $userId, 'userFolder' => null,
			'accountService' => $as, 'mailManager' => $mm, 'delegationService' => $ds,
			'clientFactory' => $this->noImapFactory(), 'triage' => Server::get(TriageService::class),
		];
		$args = [];
		foreach ((new ReflectionClass(MessagesController::class))->getConstructor()->getParameters() as $p) {
			$args[] = $given[$p->getName()] ?? $this->createMock($p->getType()->getName());
		}
		return new MessagesController(...$args);
	}

	private function loadedMessage(int $id): \OCA\Mail\Db\Message {
		return $this->messages->findByUserId($this->account->getUserId(), $id);
	}

	public function testOpeningAKeptMailServesAtriumsCopy(): void {
		$inbox = $this->mailbox('INBOX');
		$m = $this->serverMail($inbox, 5, '<k@test>', 'Kept subject');
		$this->storeText('<k@test>', "Line <one>\nline two");
		$this->messages->retireByUid($inbox, 5);
		$this->db->executeStatement('INSERT INTO *PREFIX*mail_accounts (id, user_id, name, email, inbound_host, inbound_port, inbound_ssl_mode, inbound_user, inbound_password, outbound_host, outbound_port, outbound_ssl_mode, outbound_user, outbound_password) VALUES (?, ?, ?, ?, ?, 993, ?, ?, ?, ?, 587, ?, ?, ?)', [$this->account->getId(), $this->account->getUserId(), 'T', 'test@atrium.invalid', 'h', 'ssl', 'u', 'p', 'h', 'tls', 'u', 'p']);
		try {
			$json = $this->controller($this->loadedMessage($m->getId()), $inbox)->getBody($m->getId())->getData();
		} finally {
			$this->db->executeStatement('DELETE FROM *PREFIX*mail_accounts WHERE id = ?', [$this->account->getId()]);
		}
		$this->assertSame('atrium', $json['atriumCopy']['source']);
		$this->assertTrue($json['atriumCopy']['goneFromServer']);
		$this->assertStringContainsString('Line &lt;one&gt;', $json['body'], 'plain text is escaped');
		$this->assertSame('Kept subject', $json['subject']);
		$this->assertSame('sender@atrium.invalid', $json['from'][0]['email']);
	}

	public function testOpeningAMailWithAFullStoredCopyNeverAsksTheServer(): void {
		$inbox = $this->mailbox('INBOX');
		$m = $this->serverMail($inbox, 5, '<f@test>', 'On server');
		$this->storeText('<f@test>', 'plain', '<p>Sanitized <b>html</b></p>', ['hasHtmlBody' => true, 'replyTo' => [], 'attachments' => [], 'inlineAttachments' => [], 'messageId' => '<f@test>']);
		$this->db->executeStatement('INSERT INTO *PREFIX*mail_accounts (id, user_id, name, email, inbound_host, inbound_port, inbound_ssl_mode, inbound_user, inbound_password, outbound_host, outbound_port, outbound_ssl_mode, outbound_user, outbound_password) VALUES (?, ?, ?, ?, ?, 993, ?, ?, ?, ?, 587, ?, ?, ?)', [$this->account->getId(), $this->account->getUserId(), 'T', 'test@atrium.invalid', 'h', 'ssl', 'u', 'p', 'h', 'tls', 'u', 'p']);
		try {
			$json = $this->controller($this->loadedMessage($m->getId()), $inbox)->getBody($m->getId())->getData();
		} finally {
			$this->db->executeStatement('DELETE FROM *PREFIX*mail_accounts WHERE id = ?', [$this->account->getId()]);
		}
		$this->assertSame('atrium', $json['atriumCopy']['source']);
		$this->assertFalse($json['atriumCopy']['goneFromServer']);
		$this->assertTrue($json['hasHtmlBody']);
		$this->assertSame('<p>Sanitized <b>html</b></p>', $json['body']);
	}

	public function testKeptMailWithoutStoredTextSaysSoInsteadOfFailing(): void {
		$inbox = $this->mailbox('INBOX');
		$m = $this->serverMail($inbox, 5, '<n@test>');
		$this->messages->retireByUid($inbox, 5);
		$this->db->executeStatement('INSERT INTO *PREFIX*mail_accounts (id, user_id, name, email, inbound_host, inbound_port, inbound_ssl_mode, inbound_user, inbound_password, outbound_host, outbound_port, outbound_ssl_mode, outbound_user, outbound_password) VALUES (?, ?, ?, ?, ?, 993, ?, ?, ?, ?, 587, ?, ?, ?)', [$this->account->getId(), $this->account->getUserId(), 'T', 'test@atrium.invalid', 'h', 'ssl', 'u', 'p', 'h', 'tls', 'u', 'p']);
		try {
			$json = $this->controller($this->loadedMessage($m->getId()), $inbox)->getBody($m->getId())->getData();
		} finally {
			$this->db->executeStatement('DELETE FROM *PREFIX*mail_accounts WHERE id = ?', [$this->account->getId()]);
		}
		$this->assertFalse($json['atriumCopy']['text']);
		$this->assertSame('', $json['body']);
	}

	public function testKeptMailListsOnlyWhatWasDownloadedBeforeItLeftTheServer(): void {
		$inbox = $this->mailbox('INBOX');
		$m = $this->serverMail($inbox, 5, '<att@test>', 'With files');
		$this->storeText('<att@test>', 'text', '<p>x</p>', ['hasHtmlBody' => true, 'replyTo' => [], 'attachments' => [['id' => '2', 'fileName' => 'orig.pdf'], ['id' => '3', 'fileName' => 'never.pdf']], 'inlineAttachments' => [], 'messageId' => '<att@test>']);
		(new \OCA\Mail\Service\StoredAttachments($this->db))->store($this->account->getId(), md5('<att@test>'), new \OCA\Mail\Attachment('2', 'orig.pdf', 'application/pdf', 'PDF', 3, null, 'attachment'));
		$this->messages->retireByUid($inbox, 5);
		$this->db->executeStatement('INSERT INTO *PREFIX*mail_accounts (id, user_id, name, email, inbound_host, inbound_port, inbound_ssl_mode, inbound_user, inbound_password, outbound_host, outbound_port, outbound_ssl_mode, outbound_user, outbound_password) VALUES (?, ?, ?, ?, ?, 993, ?, ?, ?, ?, 587, ?, ?, ?)', [$this->account->getId(), $this->account->getUserId(), 'T', 'test@atrium.invalid', 'h', 'ssl', 'u', 'p', 'h', 'tls', 'u', 'p']);
		try {
			$json = $this->controller($this->loadedMessage($m->getId()), $inbox)->getBody($m->getId())->getData();
		} finally {
			$this->db->executeStatement('DELETE FROM *PREFIX*mail_accounts WHERE id = ?', [$this->account->getId()]);
			$this->db->executeStatement('DELETE FROM *PREFIX*mail_stored_attachments WHERE account_id = ?', [$this->account->getId()]);
		}
		$this->assertTrue($json['atriumCopy']['goneFromServer']);
		$this->assertCount(1, $json['attachments'], 'the one that was downloaded, not the names from the original mail');
		$this->assertSame(['2', 'orig.pdf', 'application/pdf', 3], [$json['attachments'][0]['id'], $json['attachments'][0]['fileName'], $json['attachments'][0]['mime'], $json['attachments'][0]['size']]);
	}

	public function testMailStillOnTheServerKeepsItsFullAttachmentList(): void {
		$inbox = $this->mailbox('INBOX');
		$m = $this->serverMail($inbox, 5, '<att2@test>', 'On server');
		$this->storeText('<att2@test>', 'text', '<p>x</p>', ['hasHtmlBody' => true, 'replyTo' => [], 'attachments' => [['id' => '2', 'fileName' => 'a.pdf'], ['id' => '3', 'fileName' => 'b.pdf']], 'inlineAttachments' => [], 'messageId' => '<att2@test>']);
		$this->db->executeStatement('INSERT INTO *PREFIX*mail_accounts (id, user_id, name, email, inbound_host, inbound_port, inbound_ssl_mode, inbound_user, inbound_password, outbound_host, outbound_port, outbound_ssl_mode, outbound_user, outbound_password) VALUES (?, ?, ?, ?, ?, 993, ?, ?, ?, ?, 587, ?, ?, ?)', [$this->account->getId(), $this->account->getUserId(), 'T', 'test@atrium.invalid', 'h', 'ssl', 'u', 'p', 'h', 'tls', 'u', 'p']);
		try {
			$json = $this->controller($this->loadedMessage($m->getId()), $inbox)->getBody($m->getId())->getData();
		} finally {
			$this->db->executeStatement('DELETE FROM *PREFIX*mail_accounts WHERE id = ?', [$this->account->getId()]);
		}
		$this->assertCount(2, $json['attachments']);
	}
}
