<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Wavium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Atrium;

use OCA\Mail\Controller\TriageController;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\MailAccountMapper;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Exception\MailboxNotCachedException;
use OCA\Mail\Service\Triage\TriageService;
use OCP\AppFramework\Http;
use OCP\IGroupManager;
use OCP\IRequest;
use OCP\Server;

/**
 * V4-23: what /api/triage/list answers for a folder Wavium has no local copy of.
 *
 * It used to answer 200 and an empty array, because the query found no mail --
 * which the UI showed as "This folder is empty" on an account connected a minute
 * ago, while All showed everything (the plain list answers "not cached", and
 * that is what makes the client run the initial sync). The label list has to
 * give the same answer.
 */
class TriageListControllerTest extends MailDbTestCase {
	private TriageController $controller;
	private MailAccount $row;

	protected function setUp(): void {
		parent::setUp();
		$ma = new MailAccount();
		$ma->setUserId($this->account->getMailAccount()->getUserId());
		$ma->setName('Test');
		$ma->setEmail('test@atrium.invalid');
		$ma->setInboundHost('imap.atrium.invalid');
		$ma->setInboundPort(993);
		$ma->setInboundSslMode('ssl');
		$ma->setInboundUser('test@atrium.invalid');
		$ma->setInboundPassword('x');
		$ma->setOutboundHost('smtp.atrium.invalid');
		$ma->setOutboundPort(465);
		$ma->setOutboundSslMode('ssl');
		$ma->setOutboundUser('test@atrium.invalid');
		$ma->setOutboundPassword('x');
		$this->row = Server::get(MailAccountMapper::class)->insert($ma);
		$this->account = new \OCA\Mail\Account($this->row);
		$this->controller = new TriageController(
			Server::get(IRequest::class),
			Server::get(TriageService::class),
			Server::get(MessageMapper::class),
			Server::get(IGroupManager::class),
			$this->row->getUserId(),
		);
	}

	protected function tearDown(): void {
		$id = $this->row->getId();
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_triage WHERE account_id = ?', [$id]);
		parent::tearDown();
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_accounts WHERE id = ?', [$id]);
	}

	private function markCached(int $mailboxId): void {
		$this->db->executeStatement(
			'UPDATE *PREFIX*mail_mailboxes SET sync_new_token = ?, sync_changed_token = ?, sync_vanished_token = ? WHERE id = ?',
			['n', 'c', 'v', $mailboxId],
		);
	}

	public function testAFolderWithNoLocalCopyAnswersNotCachedAndNamesItself(): void {
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($inbox, 1, '<a@t>');

		$res = $this->controller->list((string)$inbox->getId(), '', 'ads,spam,newsletter,social');

		$this->assertSame(Http::STATUS_BAD_REQUEST, $res->getStatus(), 'not 200: the client has to know there is nothing to read yet');
		$data = $res->getData();
		$this->assertSame('fail', $data['status']);
		$this->assertSame(MailboxNotCachedException::class, $data['data']['type'], 'the type the client matches on');
		$this->assertSame([$inbox->getId()], $data['data']['mailboxIds'], 'and which folder to sync');
	}

	public function testOnlyTheFoldersWithNoLocalCopyAreNamed(): void {
		$inbox = $this->mailbox('INBOX');
		$archive = $this->mailbox('Archive');
		$this->markCached($archive->getId());

		$res = $this->controller->list("{$inbox->getId()},{$archive->getId()}", '', 'ads');
		$this->assertSame([$inbox->getId()], $res->getData()['data']['mailboxIds']);
	}

	public function testOnceSyncedTheSameCallListsTheMailIncludingWhatIsNotClassifiedYet(): void {
		$inbox = $this->mailbox('INBOX');
		$this->markCached($inbox->getId());
		$old = $this->serverMail($inbox, 1, '<old@t>', 'Older');
		$new = $this->serverMail($inbox, 2, '<new@t>', 'Newer');
		// One mail classified into a category Curated hides, two left unclassified.
		$this->db->executeStatement(
			'INSERT INTO *PREFIX*mail_triage (account_id, msg_hash, version, model, category, classified_at) VALUES (?, ?, ?, ?, ?, ?)',
			[$this->row->getId(), md5('<hidden@t>'), 't', 't', 'ads', 1700000000],
		);
		$hidden = $this->serverMail($inbox, 3, '<hidden@t>', 'SALE');

		$res = $this->controller->list((string)$inbox->getId(), '', 'ads,spam,newsletter,social');
		$this->assertSame(Http::STATUS_OK, $res->getStatus());
		$subjects = array_map(static fn ($m) => $m->getSubject(), $res->getData());
		$this->assertSame(['Newer', 'Older'], $subjects, 'unclassified mail stays visible under Curated');
		$this->assertNotContains('SALE', $subjects, 'and a hidden category stays hidden');
		unset($new, $old, $hidden);
	}

	public function testAnEmptyFolderListIsStillAnEmptyAnswerNotAFailure(): void {
		$res = $this->controller->list('', '', 'ads');
		$this->assertSame(Http::STATUS_OK, $res->getStatus());
		$this->assertSame([], $res->getData());
	}
}
