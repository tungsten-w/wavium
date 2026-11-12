<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\BackgroundJob;

use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\MailManager;
use OCA\Mail\Service\PendingOps;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Atrium's DB first for writes: sends the flag changes that could not reach the mail
 * server when they were made. One login per account per run (Gmail locks out frequent
 * logins), backoff between tries, gives up after PendingOps::MAX_ATTEMPTS.
 */
class PendingOpsJob extends TimedJob {
	public function __construct(
		ITimeFactory $time,
		private PendingOps $ops,
		private AccountService $accounts,
		private MailboxMapper $mailboxes,
		private MailManager $mailManager,
		private IMAPClientFactory $imapFactory,
		private LoggerInterface $logger,
	) {
		parent::__construct($time);
		$this->setInterval(60);
		$this->setAllowParallelRuns(false);
	}

	#[\Override]
	protected function run($argument): void {
		$this->drain();
	}

	/** Send what is due; public so tests can call it. */
	public function drain(): void {
		$byAccount = [];
		foreach ($this->ops->due(100, $this->time->getTime()) as $op) {
			$byAccount[$op['account_id']][] = $op;
		}
		foreach ($byAccount as $accountId => $ops) {
			$this->runAccount($accountId, $ops);
		}
	}

	/** @param list<array{id: int, op: string, account_id: int, mailbox_id: int, uid: int, flag: string, value: bool, target_mailbox_id: ?int, attempts: int}> $ops */
	private function runAccount(int $accountId, array $ops): void {
		$now = $this->time->getTime();
		try {
			$account = $this->accounts->findById($accountId);
			$client = $this->imapFactory->getClient($account);
		} catch (Throwable $e) {
			foreach ($ops as $op) {
				$this->ops->failed($op['id'], $op['attempts'], $e->getMessage(), $now);
			}
			return;
		}
		try {
			foreach ($ops as $op) {
				try {
					$mb = $this->mailboxes->findById($op['mailbox_id']);
					if ($op['op'] === 'move') {
						$this->mailManager->applyMoveOnServer($mb, $op['uid'], $this->mailboxes->findById((int)$op['target_mailbox_id']), $client);
					} else {
						$this->mailManager->applyFlagOnServer($account, $mb, $op['uid'], $op['flag'], $op['value'], $client);
					}
					$this->ops->done($op['id']);
				} catch (DoesNotExistException) {
					// The folder is gone; nothing left to change on the server.
					$this->ops->done($op['id']);
				} catch (Throwable $e) {
					$this->logger->warning('Queued flag change still failing: ' . $e->getMessage(), ['app' => 'mail']);
					$this->ops->failed($op['id'], $op['attempts'], $e->getMessage(), $now);
					// The server is down for everything else of this account too: stop, retry next run.
					break;
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
