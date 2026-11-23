<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Atrium;

use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\MailAccountMapper;
use OCA\Mail\Service\Triage\TriageService;
use OCP\Server;

/**
 * Label filters (idsByLabel), stored copies (storeReaderCopy/loadCopy) and the
 * pure helpers of the triage service. Database only, no network, no mail server.
 */
class TriageServiceTest extends MailDbTestCase {
	private TriageService $triage;
	private MailAccount $row;

	protected function setUp(): void {
		parent::setUp();
		$this->triage = Server::get(TriageService::class);
		// idsByLabel joins mail_accounts on the user id, so this account needs a real row.
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
	}

	protected function tearDown(): void {
		$id = $this->row->getId();
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_triage WHERE account_id = ?', [$id]);
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_bodies WHERE account_id = ?', [$id]);
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_pending_ops WHERE account_id = ?', [$id]);
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_stored_attachments WHERE account_id = ?', [$id]);
		parent::tearDown();
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_accounts WHERE id = ?', [$id]);
	}

	private function classify(string $messageId, ?string $category, ?float $needsAction = null): void {
		$this->db->executeStatement(
			'INSERT INTO *PREFIX*mail_triage (account_id, msg_hash, version, model, category, needs_action, classified_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			[$this->row->getId(), md5($messageId), 't', 't', $category, $needsAction, 1700000000],
		);
	}

	/** @return int[] */
	private function ids(array $mailboxes, array $categories = [], bool $needsAction = false, ?int $cursor = null, int $limit = 50, array $exclude = []): array {
		return $this->triage->idsByLabel($this->row->getUserId(), array_map(fn ($m) => $m->getId(), $mailboxes), $categories, $needsAction, $cursor, $limit, $exclude);
	}

	public function testUncachedMailboxIdsNamesTheFoldersWithNoLocalCopy(): void {
		$fresh = $this->mailbox('Fresh');
		$synced = $this->mailbox('Synced');
		$this->db->executeStatement(
			'UPDATE *PREFIX*mail_mailboxes SET sync_new_token = ?, sync_changed_token = ?, sync_vanished_token = ? WHERE id = ?',
			['n', 'c', 'v', $synced->getId()],
		);
		$uid = $this->row->getUserId();

		$this->assertSame([$fresh->getId()], $this->triage->uncachedMailboxIds($uid, [$fresh->getId(), $synced->getId()]));
		$this->assertSame([], $this->triage->uncachedMailboxIds($uid, [$synced->getId()]));
		$this->assertSame([], $this->triage->uncachedMailboxIds($uid, []), 'no folder asked, nothing to sync');
		$this->assertSame([], $this->triage->uncachedMailboxIds('someone-else', [$fresh->getId()]), 'another user\'s folder is not ours to report');
	}

	public function testAHalfSyncedFolderStillCountsAsUncached(): void {
		$half = $this->mailbox('Half');
		$this->db->executeStatement('UPDATE *PREFIX*mail_mailboxes SET sync_new_token = ? WHERE id = ?', ['n', $half->getId()]);

		$this->assertSame(
			[$half->getId()],
			$this->triage->uncachedMailboxIds($this->row->getUserId(), [$half->getId()]),
			'one token out of three is not a local copy (Mailbox::isCached wants all three)',
		);
	}

	public function testCategoryFilterReturnsOnlyThatCategoryNewestFirst(): void {
		$inbox = $this->mailbox('INBOX');
		$a = $this->serverMail($inbox, 1, '<a@t>');
		$b = $this->serverMail($inbox, 2, '<b@t>');
		$c = $this->serverMail($inbox, 3, '<c@t>');
		$this->classify('<a@t>', 'receipts');
		$this->classify('<b@t>', 'newsletters');
		$this->classify('<c@t>', 'receipts');

		$this->assertSame([$c->getId(), $a->getId()], $this->ids([$inbox], ['receipts']));
		$this->assertSame([$b->getId()], $this->ids([$inbox], ['newsletters']));
		$this->assertSame([], $this->ids([$inbox], ['nothing']));
	}

	public function testNoCategoryMeansAnyClassifiedOrNotAndNoFoldersMeansNothing(): void {
		$inbox = $this->mailbox('INBOX');
		$a = $this->serverMail($inbox, 1, '<a@t>');
		$b = $this->serverMail($inbox, 2, '<b@t>');
		$this->classify('<a@t>', 'receipts');

		$this->assertSame([$b->getId(), $a->getId()], $this->ids([$inbox]));
		$this->assertSame([], $this->ids([]));
	}

	public function testExcludeHidesCategoriesButKeepsUnclassifiedMail(): void {
		$inbox = $this->mailbox('INBOX');
		$a = $this->serverMail($inbox, 1, '<a@t>');
		$b = $this->serverMail($inbox, 2, '<b@t>');
		$c = $this->serverMail($inbox, 3, '<c@t>');
		$this->classify('<a@t>', 'promos');
		$this->classify('<b@t>', 'personal');

		$this->assertSame([$c->getId(), $b->getId()], $this->ids([$inbox], [], false, null, 50, ['promos']));
	}

	public function testFlaggedListsStarredMailWhateverItsCategory(): void {
		$inbox = $this->mailbox('INBOX');
		$plain = $this->serverMail($inbox, 1, '<p@t>');
		$star = $this->serverMail($inbox, 2, '<s@t>');
		$starAd = $this->serverMail($inbox, 3, '<sa@t>');
		$this->classify('<sa@t>', 'ads');
		$this->db->executeStatement('UPDATE *PREFIX*mail_messages SET flag_flagged = true WHERE id IN (?, ?)', [$star->getId(), $starAd->getId()]);

		$flagged = fn (array $exclude = []) => $this->triage->idsByLabel($this->row->getUserId(), [$inbox->getId()], [], false, null, 50, $exclude, true);
		$this->assertSame([$starAd->getId(), $star->getId()], $flagged(), 'starred mail, newest first');
		$this->assertNotContains($plain->getId(), $flagged());
		// Favorites ignores Curated: a starred ad is still a favourite.
		$this->assertSame([$star->getId()], $flagged(['ads']), 'the exclude list still applies when asked for');
	}

	public function testNeedsActionThreshold(): void {
		$inbox = $this->mailbox('INBOX');
		$a = $this->serverMail($inbox, 1, '<a@t>');
		$b = $this->serverMail($inbox, 2, '<b@t>');
		$this->serverMail($inbox, 3, '<c@t>');
		$this->classify('<a@t>', 'personal', 0.5);
		$this->classify('<b@t>', 'personal', 0.49);

		$this->assertSame([$a->getId()], $this->ids([$inbox], [], true));
	}

	public function testCursorAndLimitPage(): void {
		$inbox = $this->mailbox('INBOX');
		$m = [];
		for ($i = 1; $i <= 5; $i++) {
			$m[$i] = $this->serverMail($inbox, $i, "<p$i@t>");
		}
		$page1 = $this->ids([$inbox], [], false, null, 2);
		$this->assertSame([$m[5]->getId(), $m[4]->getId()], $page1);
		$page2 = $this->ids([$inbox], [], false, $m[4]->getSentAt(), 2);
		$this->assertSame([$m[3]->getId(), $m[2]->getId()], $page2);
		$this->assertCount(5, $this->ids([$inbox], [], false, null, 1000), 'limit is capped, not ignored');
	}

	public function testDeletedMailAndOtherFoldersAndOtherUsersAreLeftOut(): void {
		$inbox = $this->mailbox('INBOX');
		$other = $this->mailbox('Other');
		$a = $this->serverMail($inbox, 1, '<a@t>');
		$gone = $this->serverMail($inbox, 2, '<gone@t>');
		$this->serverMail($other, 3, '<o@t>');
		$this->db->executeStatement('UPDATE *PREFIX*mail_messages SET flag_deleted = true WHERE id = ?', [$gone->getId()]);

		$this->assertSame([$a->getId()], $this->ids([$inbox]));
		$this->assertSame([], $this->triage->idsByLabel('someone-else', [$inbox->getId()], [], false, null, 50));
	}

	public function testImportantIdsUseTheDigestBarAndSkipSpamJunkAndOthers(): void {
		$inbox = $this->mailbox('INBOX');
		$junk = $this->mailbox('Junk');
		$reply = $this->serverMail($inbox, 1, '<r@t>');
		$act = $this->serverMail($inbox, 2, '<a@t>');
		$urgent = $this->serverMail($inbox, 3, '<u@t>');
		$this->serverMail($inbox, 4, '<plain@t>');
		$this->serverMail($inbox, 5, '<spam@t>');
		$this->serverMail($inbox, 6, '<phish@t>');
		$this->serverMail($junk, 7, '<j@t>');
		$this->serverMail($inbox, 8, '<unclassified@t>');
		$set = function (string $id, array $cols): void {
			$this->classify($id, $cols['category'] ?? 'personal');
			foreach ($cols as $k => $v) {
				if ($k !== 'category') {
					$this->db->executeStatement("UPDATE *PREFIX*mail_triage SET $k = ? WHERE account_id = ? AND msg_hash = ?", [$v, $this->row->getId(), md5($id)]);
				}
			}
		};
		$set('<r@t>', ['needs_reply' => 0.9]);
		$set('<a@t>', ['needs_action' => 0.5]);
		$set('<u@t>', ['urgency' => 'today']);
		$set('<plain@t>', ['needs_reply' => 0.2, 'urgency' => 'later']);
		$set('<spam@t>', ['category' => 'spam', 'needs_reply' => 0.9]);
		$set('<phish@t>', ['needs_reply' => 0.9, 'suspicious' => 0.8]);
		$set('<j@t>', ['needs_reply' => 0.9]);

		$uid = $this->row->getUserId();
		$this->assertSame([$urgent->getId(), $act->getId(), $reply->getId()], $this->triage->importantIds($uid, [$junk->getId()], 0, 10));
		$this->assertCount(2, $this->triage->importantIds($uid, [$junk->getId()], 0, 2));
		$this->assertSame([], $this->triage->importantIds('someone-else', [], 0, 10));
		$this->assertSame([], $this->triage->importantIds($uid, [$junk->getId()], 2000000000, 10), 'only recent mail');
	}

	public function testClassificationFollowsTheMailAcrossFoldersByMessageId(): void {
		$all = $this->mailbox('[Gmail]/All Mail');
		$inbox = $this->mailbox('INBOX');
		$a = $this->serverMail($all, 40, '<same@t>');
		$this->classify('<same@t>', 'receipts');
		// The same Message-ID in another folder keeps its label (db ids differ, the hash does not).
		$b = $this->serverMail($inbox, 7, '<same@t>');

		$this->assertSame([$b->getId()], $this->ids([$inbox], ['receipts']));
		$this->assertSame([$a->getId()], $this->ids([$all], ['receipts']));
	}

	public function testReaderCopyRoundTrip(): void {
		$hash = TriageService::hash('<r@t>', 1);
		$this->db->executeStatement(
			'INSERT INTO *PREFIX*mail_bodies (account_id, msg_hash, headers, body, attachments, has_unsubscribe, sent_at, fetched_at) VALUES (?, ?, ?, ?, ?, false, ?, ?)',
			[$this->row->getId(), $hash, 'From: A', 'plain text', '', 1700000000, 1700000001],
		);
		$this->assertNull($this->triage->loadCopy($this->row->getId(), $hash)['reader_body']);

		$this->triage->storeReaderCopy($this->row->getId(), $hash, [
			'body' => "<p>Hi\0 there</p>", 'subject' => 'S', 'databaseId' => 9, 'accountId' => 1, 'flags' => ['seen' => true],
		]);

		$copy = $this->triage->loadCopy($this->row->getId(), $hash);
		$this->assertSame('<p>Hi there</p>', $copy['reader_body'], 'NUL bytes are stripped');
		$this->assertSame(['subject' => 'S'], $copy['reader_meta'], 'per-row fields are not kept');
		$this->assertSame('plain text', $copy['body']);
	}

	public function testReaderCopyTooBigIsNotKeptAndMissingRowIsNull(): void {
		$hash = TriageService::hash('<big@t>', 1);
		$this->db->executeStatement(
			'INSERT INTO *PREFIX*mail_bodies (account_id, msg_hash, headers, body, attachments, has_unsubscribe, sent_at, fetched_at) VALUES (?, ?, ?, ?, ?, false, ?, ?)',
			[$this->row->getId(), $hash, 'h', 'b', '', 1, 1],
		);
		$this->triage->storeReaderCopy($this->row->getId(), $hash, ['body' => str_repeat('x', TriageService::MAX_READER_CHARS + 1)]);
		$this->assertNull($this->triage->loadCopy($this->row->getId(), $hash)['reader_body']);
		$this->assertNull($this->triage->loadCopy($this->row->getId(), 'nope'));
	}

	public function testHashIsStablePerMessageIdAndFallsBackToDbId(): void {
		$this->assertSame(md5('<x@t>'), TriageService::hash('<x@t>', 1));
		$this->assertSame(TriageService::hash('<x@t>', 1), TriageService::hash('<x@t>', 2));
		$this->assertSame(md5('db:7'), TriageService::hash(null, 7));
		$this->assertSame(md5('db:7'), TriageService::hash('', 7));
	}

	public function testCleanTextShortensLinksAndDropsInvisibleAndBlobs(): void {
		$in = "See https://www.example.com/a/b?x=1 now\u{200B}\u{034F}   ok\n\n\n\nbye " . str_repeat('A', 80) . ' www.foo.org/x';
		$out = TriageService::cleanText($in);
		$this->assertStringContainsString('[link: example.com]', $out);
		$this->assertStringContainsString('[link: foo.org]', $out);
		$this->assertStringContainsString('[data]', $out);
		$this->assertStringNotContainsString("\u{200B}", $out);
		$this->assertStringNotContainsString("\n\n\n", $out);
		$this->assertStringNotContainsString('https://', $out);
	}

	public function testSummarizeReadsChoicePredicateAndScoreAnswers(): void {
		$out = TriageService::summarize(['answers' => [
			['name' => 'category', 'type' => 'choice', 'choice' => 'receipts', 'confidence' => 0.9],
			['name' => 'needs_action', 'type' => 'predicate', 'probability' => 0.7],
			['name' => 'urgency', 'type' => 'score', 'score' => 3.5, 'probabilities' => [
				['label' => 'low', 'probability' => 0.2], ['label' => 'high', 'probability' => 0.8],
			]],
			['name' => 'ignored_unknown', 'type' => 'choice', 'choice' => 'x'],
			['type' => 'choice'],
		]]);
		$this->assertSame('receipts', $out['category']);
		$this->assertSame(0.9, $out['category_confidence']);
		$this->assertSame(0.7, $out['needs_action']);
		$this->assertSame('high', $out['urgency']);
		$this->assertSame(3.5, $out['urgency_score']);
		$this->assertNull($out['suspicious']);
		$this->assertArrayNotHasKey('ignored_unknown', $out);
	}

	public function testStatusReportsQueuedWritesReaderCopiesAndKeptAttachments(): void {
		$inbox = $this->mailbox('INBOX');
		$this->serverMail($inbox, 1, '<s1@t>');
		$this->serverMail($inbox, 2, '<s2@t>');
		(new \OCA\Mail\Service\PendingOps($this->db))->enqueueFlag($this->row->getId(), $inbox->getId(), 1, 'seen', true);
		(new \OCA\Mail\Service\StoredAttachments($this->db))->store($this->row->getId(), md5('<s1@t>'), new \OCA\Mail\Attachment('2', 'a.pdf', 'application/pdf', 'abcd', 4, null, 'attachment'));

		$sync = $this->triage->status($this->row->getUserId())['sync'];

		$this->assertSame(['pendingWrites' => 1, 'failedWrites' => 0, 'readerTodo' => 2, 'readerUnavailable' => 0, 'attachments' => 1, 'attachmentBytes' => 4], $sync);
	}
}
