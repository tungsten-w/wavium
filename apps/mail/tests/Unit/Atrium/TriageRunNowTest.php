<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Atrium;

use OCA\Mail\AppInfo\Application;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\MailManager;
use OCA\Mail\Service\Triage\TriageService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\IDBConnection;
use OCP\IMemcache;
use OCP\Server;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;

/**
 * "Run now" on the Mail status page (V4-37): the pipeline otherwise waits for
 * the five-minute cron tick, so turning classification on, adding a provider or
 * fixing a folder looked like nothing had happened.
 *
 * Both tests hold the run lock, so nothing is enqueued and no mail server is
 * ever reached: what is under test is the decision runNow() makes before the
 * work, not the work.
 */
class TriageRunNowTest extends TestCase {
	private IAppConfig $appConfig;
	private string $stateBefore;
	private bool $enabledBefore;

	protected function setUp(): void {
		parent::setUp();
		$this->appConfig = Server::get(IAppConfig::class);
		$this->stateBefore = $this->appConfig->getValueString(Application::APP_ID, 'triage_state', '');
		$this->enabledBefore = $this->appConfig->getValueBool(Application::APP_ID, 'triage_enabled', false);
	}

	protected function tearDown(): void {
		$this->appConfig->setValueString(Application::APP_ID, 'triage_state', $this->stateBefore);
		$this->appConfig->setValueBool(Application::APP_ID, 'triage_enabled', $this->enabledBefore);
		parent::tearDown();
	}

	/** A service whose run lock is already taken, so run() answers null. */
	private function serviceWithLockHeld(): TriageService {
		$lock = $this->createMock(IMemcache::class);
		$lock->method('add')->willReturn(false);
		$caches = $this->createMock(ICacheFactory::class);
		$caches->method('createLocking')->with('mail-triage')->willReturn($lock);
		return new TriageService(
			Server::get(IDBConnection::class), $this->appConfig, Server::get(IConfig::class),
			Server::get(ITimeFactory::class), Server::get(IClientService::class), Server::get(AccountService::class),
			Server::get(MailboxMapper::class), Server::get(MailManager::class), Server::get(IMAPClientFactory::class),
			Server::get(LoggerInterface::class), $caches,
		);
	}

	private function state(array $s): void {
		$this->appConfig->setValueString(Application::APP_ID, 'triage_state', json_encode($s));
	}

	/**
	 * A pause is there to stop the cron job hammering an AI that keeps failing.
	 * A person pressing a button once is not hammering, and it is precisely
	 * after a failure that they press it -- so the press must not be swallowed
	 * by a 30-minute backoff.
	 */
	public function testAPressClearsTheBackoffPause(): void {
		$this->appConfig->setValueBool(Application::APP_ID, 'triage_enabled', true);
		$this->state(['state' => 'backoff', 'pausedUntil' => time() + 1800, 'transientFailures' => 6, 'lastError' => 'AI unreachable']);
		$service = $this->serviceWithLockHeld();

		$r = $service->runNow();

		self::assertFalse($r['ran'], 'the lock is held, so this press does no work');
		self::assertSame('busy', $r['reason']);
		self::assertSame(0, (int)($service->state()['pausedUntil'] ?? -1), 'the pause must be lifted by the press');
		// What was learned before the press is kept, so the page still says why.
		self::assertSame('AI unreachable', $service->state()['lastError'] ?? null);
	}

	/** The run that is already going is not an error: the work is being done. */
	public function testARunAlreadyGoingIsReportedAsBusy(): void {
		$this->appConfig->setValueBool(Application::APP_ID, 'triage_enabled', true);
		$this->state(['state' => 'running']);

		$r = $this->serviceWithLockHeld()->runNow();

		self::assertSame(['ran' => false, 'reason' => 'busy', 'queued' => 0, 'classified' => 0], [
			'ran' => $r['ran'], 'reason' => $r['reason'], 'queued' => $r['queued'], 'classified' => $r['classified'],
		]);
		self::assertSame('running', $r['state']);
	}

	/**
	 * Classification off is a human's answer. The button is disabled in the UI,
	 * and refused here too -- so a stale page cannot classify behind the "no",
	 * and the refusal comes before the pause is touched.
	 */
	public function testItRefusesWhileClassificationIsOff(): void {
		$this->appConfig->setValueBool(Application::APP_ID, 'triage_enabled', false);
		$until = time() + 600;
		$this->state(['state' => 'disabled', 'pausedUntil' => $until]);
		$service = $this->serviceWithLockHeld();

		$r = $service->runNow();

		self::assertFalse($r['ran']);
		self::assertSame('disabled', $r['reason']);
		self::assertSame($until, (int)($service->state()['pausedUntil'] ?? 0), 'a refused press changes nothing');
	}
}
