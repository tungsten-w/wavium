<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\BackgroundJob;

use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\MailManager;
use OCA\Mail\Service\ReaderBackfill;
use OCA\Mail\Service\Triage\TriageService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;
use OCP\IDBConnection;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Atrium: gives every mail stored before the reader copy existed one, so opening it never
 * waits on the mail server. Small steps (25 mails, one login per account per run, every
 * 10 minutes) because Gmail locks out frequent logins; stops an account's run when the
 * server refuses the login. Mails that cannot be loaded are retried and then marked
 * unavailable (ReaderBackfill).
 */
class ReaderBackfillJob extends TimedJob {
	public const BATCH = 25;

	public function __construct(
		ITimeFactory $time,
		private IDBConnection $db,
		private ReaderBackfill $backfill,
		private AccountService $accounts,
		private MailManager $mailManager,
		private TriageService $triage,
		private IMAPClientFactory $imapFactory,
		private LoggerInterface $logger,
	) {
		parent::__construct($time);
		$this->setInterval(10 * 60);
		$this->setAllowParallelRuns(false);
	}

	#[\Override]
	protected function run($argument): void {
		$this->drain();
	}

	/**
	 * One step for every account (or just the given [id, userId] pairs, for tests).
	 *
	 * @param list<array{0: int, 1: string}>|null $only
	 */
	public function drain(?array $only = null): void {
		$accounts = $only ?? array_map(static fn (array $a) => [(int)$a['id'], (string)$a['user_id']], $this->db->executeQuery('SELECT id, user_id FROM *PREFIX*mail_accounts')->fetchAll());
		foreach ($accounts as [$id, $userId]) {
			$this->runAccount($id, $userId);
		}
	}

	private function runAccount(int $accountId, string $userId): void {
		$now = $this->time->getTime();
		$todo = $this->backfill->candidates($accountId, self::BATCH, $now);
		if ($todo === []) {
			return;
		}
		try {
			$account = $this->accounts->find($userId, $accountId);
			$client = $this->imapFactory->getClient($account);
		} catch (Throwable $e) {
			$this->logger->warning('Reader backfill: no mail server connection: ' . $e->getMessage(), ['app' => 'mail']);
			return;
		}
		$boxes = [];
		try {
			foreach ($todo as $row) {
				try {
					$mb = $boxes[$row['mailbox_id']] ??= $this->mailManager->getMailbox($userId, $row['mailbox_id']);
					$msg = $this->mailManager->getImapMessage($client, $account, $mb, $row['uid'], true);
					$json = $msg->getFullMessage($row['id']);
					$this->triage->storeBody($account, $mb, $msg, TriageService::hash($row['message_id'], $row['id']), $json);
				} catch (Throwable $e) {
					$m = $e->getMessage();
					if (stripos($m, 'auth') !== false || stripos($m, 'login') !== false) {
						$this->logger->warning('Reader backfill: login refused, stopping: ' . $m, ['app' => 'mail']);
						break;
					}
					$this->backfill->recordFailure($accountId, $row['message_id'], $m, $now);
				}
			}
		} finally {
			try {
				$client->logout();
			} catch (Throwable) {
			}
		}
	}
}
