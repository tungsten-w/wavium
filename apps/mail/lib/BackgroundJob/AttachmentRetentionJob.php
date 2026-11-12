<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\BackgroundJob;

use OCA\Mail\Service\StoredAttachments;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Atrium: attachments kept after a download are dropped after StoredAttachments::RETENTION_DAYS
 * when the mail is still on the server (they can be downloaded again). Copies of mail that
 * left the server stay: they are the only ones.
 */
class AttachmentRetentionJob extends TimedJob {
	public function __construct(
		ITimeFactory $time,
		private StoredAttachments $stored,
		private LoggerInterface $logger,
	) {
		parent::__construct($time);
		$this->setInterval(24 * 3600);
		$this->setAllowParallelRuns(false);
	}

	#[\Override]
	protected function run($argument): void {
		try {
			$n = $this->stored->purge($this->time->getTime());
			if ($n > 0) {
				$this->logger->info("Dropped $n stored attachments older than " . StoredAttachments::RETENTION_DAYS . ' days', ['app' => 'mail']);
			}
		} catch (Throwable $e) {
			$this->logger->warning('Attachment retention failed: ' . $e->getMessage(), ['app' => 'mail']);
		}
	}
}
