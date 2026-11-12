<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Listener;

use Horde_Imap_Client;
use OCA\Mail\Events\NewMessagesSynchronized;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCA\Mail\Service\Triage\TriageService;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Atrium: classify new inbox/spam mail as soon as sync stores it, not only on
 * the 5-min TriageJob (ADR 0009: agents only ever see classified mail). Runs
 * once per request after the response went out (FPM) or at the end of the
 * cron process (CLI), so sync is never slowed down.
 *
 * @template-implements IEventListener<Event|NewMessagesSynchronized>
 */
class ClassifyOnArrivalListener implements IEventListener {
	public const BUDGET_SEC = 60;

	private static bool $scheduled = false;

	public function __construct(
		private TriageService $triage,
		private ITimeFactory $time,
		private LoggerInterface $logger,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof NewMessagesSynchronized) || self::$scheduled) {
			return;
		}
		$box = $event->getMailbox();
		if (!$box->isInbox() && !$box->isSpecialUse(Horde_Imap_Client::SPECIALUSE_JUNK)) {
			return;
		}
		if ($event->getMessages() === [] || !$this->triage->settings()['enabled']) {
			return;
		}
		self::$scheduled = true;
		register_shutdown_function(function (): void {
			if (function_exists('fastcgi_finish_request')) {
				fastcgi_finish_request();
			}
			$this->runNow();
		});
	}

	/** Public for tests. */
	public function runNow(): void {
		ignore_user_abort(true);
		set_time_limit(self::BUDGET_SEC + 120);
		// A run that is just finishing may have missed the new rows: retry briefly.
		for ($try = 0; $try < 5; $try++) {
			try {
				if ($this->triage->run($this->time->getTime() + self::BUDGET_SEC) !== null) {
					return;
				}
			} catch (Throwable $e) {
				$this->logger->error('Classify on arrival failed: ' . $e->getMessage(), ['exception' => $e]);
				return;
			}
			sleep(2);
		}
	}
}
