<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Atrium;

use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\Listener\ClassifyOnArrivalListener;
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
use Psr\Log\LoggerInterface;
use PHPUnit\Framework\TestCase;

/**
 * Classify on arrival (ADR 0009): one triage run at a time, and the listener
 * retries briefly while another run holds the lock.
 */
class ClassifyOnArrivalTest extends TestCase {
	private function service(IMemcache $lock): TriageService {
		$caches = $this->createMock(ICacheFactory::class);
		$caches->method('createLocking')->with('mail-triage')->willReturn($lock);
		return new TriageService(
			Server::get(IDBConnection::class), Server::get(IAppConfig::class), Server::get(IConfig::class),
			Server::get(ITimeFactory::class), Server::get(IClientService::class), Server::get(AccountService::class),
			Server::get(MailboxMapper::class), Server::get(MailManager::class), Server::get(IMAPClientFactory::class),
			Server::get(LoggerInterface::class), $caches,
		);
	}

	public function testRunRefusesWhileAnotherRunHoldsTheLock(): void {
		$lock = $this->createMock(IMemcache::class);
		$lock->expects($this->once())->method('add')->with('run', $this->anything(), 300)->willReturn(false);
		$lock->expects($this->never())->method('cad');
		$this->assertNull($this->service($lock)->run(time() + 1));
	}

	public function testRunReleasesItsOwnLock(): void {
		$token = null;
		$lock = $this->createMock(IMemcache::class);
		$lock->method('add')->willReturnCallback(function ($key, $value) use (&$token) {
			$token = $value;
			return true;
		});
		$lock->expects($this->once())->method('cad')->willReturnCallback(function ($key, $value) use (&$token) {
			$this->assertSame('run', $key);
			$this->assertSame($token, $value);
			return true;
		});
		$r = $this->service($lock)->run(time() - 1); // deadline passed: queue only
		$this->assertSame(0, $r['classified']);
		$this->assertIsInt($r['queued']);
	}

	public function testListenerRetriesWhileLockedThenRuns(): void {
		$triage = $this->createMock(TriageService::class);
		$triage->expects($this->exactly(2))->method('run')->willReturnOnConsecutiveCalls(null, ['queued' => 1, 'classified' => 1]);
		$time = $this->createMock(ITimeFactory::class);
		$time->method('getTime')->willReturn(1000);
		$listener = new ClassifyOnArrivalListener($triage, $time, $this->createMock(LoggerInterface::class));
		$listener->runNow();
	}
}
