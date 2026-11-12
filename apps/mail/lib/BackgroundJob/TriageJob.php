<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\BackgroundJob;

use OCA\Mail\Service\Triage\TriageService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Atrium triage worker: queue new inbox/spam mail, then classify for up to
 * four minutes (cron runs every five). Caps and pauses live in TriageService.
 */
class TriageJob extends TimedJob {
	public function __construct(
		ITimeFactory $time,
		private TriageService $triage,
		private LoggerInterface $logger,
	) {
		parent::__construct($time);
		$this->setInterval(5 * 60);
		$this->setTimeSensitivity(self::TIME_SENSITIVE);
		$this->setAllowParallelRuns(false);
	}

	#[\Override]
	protected function run($argument): void {
		if (!$this->triage->settings()['enabled']) {
			return;
		}
		$start = $this->time->getTime();
		try {
			$r = $this->triage->run($start + 240);
			if ($r === null) {
				$this->logger->debug('Triage: another run is active');
				return;
			}
			$this->logger->debug("Triage: queued {$r['queued']}, classified {$r['classified']}");
		} catch (Throwable $e) {
			$this->logger->error('Triage run failed: ' . $e->getMessage(), ['exception' => $e]);
		}
	}
}
