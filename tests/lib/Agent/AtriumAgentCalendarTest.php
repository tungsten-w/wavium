<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace Test\Agent;

use OC\Agent\InternalAuth;
use OCA\Calendar\Controller\AtriumAgentController;
use OCA\Calendar\Service\AtriumAgentCalendar;
use OCA\Calendar\Service\AtriumAgentError;
use OCA\DAV\CalDAV\CalDavBackend;
use OCP\IUserManager;
use Test\TestCase;

/**
 * P3-2: calendar and tasks for agents, on the real CalDAV backend (test instance).
 *
 *
 */
#[\PHPUnit\Framework\Attributes\Group('DB')]
class AtriumAgentCalendarTest extends TestCase {
	private CalDavBackend $backend;
	private AtriumAgentCalendar $cal;
	private string $alice;
	private string $bob;
	/** @var list<int> */
	private array $calendars = [];

	protected function setUp(): void {
		parent::setUp();
		$this->backend = \OCP\Server::get(CalDavBackend::class);
		$this->cal = new AtriumAgentCalendar($this->backend);
		$users = \OCP\Server::get(IUserManager::class);
		$this->alice = 'cal-alice-' . bin2hex(random_bytes(4));
		$this->bob = 'cal-bob-' . bin2hex(random_bytes(4));
		$users->createUser($this->alice, 'pass-' . bin2hex(random_bytes(8)));
		$users->createUser($this->bob, 'pass-' . bin2hex(random_bytes(8)));
	}

	protected function tearDown(): void {
		foreach ($this->calendars as $id) {
			$this->backend->deleteCalendar($id, true);
		}
		$users = \OCP\Server::get(IUserManager::class);
		foreach ([$this->alice, $this->bob] as $uid) {
			$users->get($uid)?->delete();
		}
		parent::tearDown();
	}

	private function newCalendar(string $uid, string $uri, array $comps = ['VEVENT', 'VTODO']): string {
		$id = $this->backend->createCalendar('principals/users/' . $uid, $uri, [
			'{DAV:}displayname' => ucfirst($uri),
			'{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set' => new \Sabre\CalDAV\Xml\Property\SupportedCalendarComponentSet($comps),
		]);
		$this->calendars[] = $id;
		return (string) $id;
	}

	private function utc(string $s): \DateTimeImmutable {
		return new \DateTimeImmutable($s, new \DateTimeZone('UTC'));
	}

	public function testEventLifecycleAndRecurrence(): void {
		$home = $this->newCalendar($this->alice, 'home');
		$e = $this->cal->createEvent($this->alice, null, [
			'title' => 'Standup', 'start' => '2026-11-16T09:00:00+01:00', 'end' => '2026-11-16T09:15:00+01:00',
			'location' => 'Room 1', 'rrule' => 'FREQ=DAILY;COUNT=5',
		]);
		$this->assertSame($home, $e['calendar_id']);
		$this->assertSame('2026-11-16T08:00:00Z', $e['start']);
		$this->assertSame('2026-11-16T08:15:00Z', $e['end']);
		$this->assertTrue($e['recurring']);

		// Expanded in range: 3 of the 5 occurrences, sorted.
		$list = $this->cal->events($this->alice, $this->utc('2026-11-17'), $this->utc('2026-11-20'));
		$this->assertSame(['2026-11-17T08:00:00Z', '2026-11-18T08:00:00Z', '2026-11-19T08:00:00Z'], array_column($list['events'], 'start'));
		$this->assertSame($e['event_id'], $list['events'][0]['event_id']);
		$this->assertSame('Home', $list['events'][0]['calendar_name']);
		$this->assertSame([], $this->cal->events($this->alice, $this->utc('2026-11-17'), $this->utc('2026-11-20'), null, 'lunch')['events']);

		// Moving the start keeps the duration; a stale etag is refused.
		$u = $this->cal->updateEvent($this->alice, $e['event_id'], ['start' => '2026-11-16T10:00:00Z'], $e['etag']);
		$this->assertSame('2026-11-16T10:15:00Z', $u['end']);
		try {
			$this->cal->updateEvent($this->alice, $e['event_id'], ['title' => 'x'], $e['etag']);
			$this->fail('stale etag accepted');
		} catch (AtriumAgentError $err) {
			$this->assertSame(409, $err->status);
		}
		$this->assertSame('Room 1', $this->cal->event($this->alice, $e['event_id'])['location']);
		$this->cal->updateEvent($this->alice, $e['event_id'], ['location' => null, 'rrule' => null], null);
		$g = $this->cal->event($this->alice, $e['event_id']);
		$this->assertNull($g['location']);
		$this->assertFalse($g['recurring']);

		// All-day: dates, end defaults to the next day.
		$a = $this->cal->createEvent($this->alice, $home, ['title' => 'Holiday', 'all_day' => true, 'start' => '2026-12-24']);
		$this->assertSame(['2026-12-24', '2026-12-25', true], [$a['start'], $a['end'], $a['all_day']]);

		// Delete goes to the trash bin (the object is restorable), not a hard delete.
		$this->assertTrue($this->cal->delete($this->alice, $a['event_id'], 'VEVENT')['trash']);
		try {
			$this->cal->event($this->alice, $a['event_id']);
			$this->fail('a deleted event is still readable');
		} catch (AtriumAgentError $err) {
			$this->assertSame(404, $err->status);
		}
		[, $uri] = AtriumAgentCalendar::splitId($a['event_id']);
		$trashed = array_filter($this->backend->getDeletedCalendarObjectsByPrincipal('principals/users/' . $this->alice), fn($o) => $o['uri'] === preg_replace('/\.ics$/', '-deleted.ics', $uri));
		$this->assertCount(1, $trashed);
	}

	public function testInputErrors(): void {
		$this->newCalendar($this->alice, 'home');
		foreach ([
			[['start' => '2026-11-16T09:00:00Z'], 'title is required'],
			[['title' => 'x', 'start' => '2026-11-16T09:00:00'], 'time zone offset'],
			[['title' => 'x', 'start' => '2026-11-16T09:00:00Z', 'end' => '2026-11-16T08:00:00Z'], 'end must be after start'],
			[['title' => 'x', 'start' => '2026-11-16T09:00:00Z', 'rrule' => 'EVERY DAY'], 'rrule'],
		] as [$fields, $msg]) {
			try {
				$this->cal->createEvent($this->alice, null, $fields);
				$this->fail("accepted: $msg");
			} catch (\InvalidArgumentException $e) {
				$this->assertStringContainsString($msg, $e->getMessage());
			}
		}
		$this->expectException(\InvalidArgumentException::class);
		$this->cal->events($this->alice, $this->utc('2026-01-01'), $this->utc('2027-06-01'));
	}

	public function testSharedCalendarsAreDiscoverableAndReadOnlyIsEnforced(): void {
		$bobCal = $this->newCalendar($this->bob, 'family');
		$bobWork = $this->newCalendar($this->bob, 'work');
		$this->newCalendar($this->alice, 'home');
		$this->backend->updateShares(
			new \OCA\DAV\CalDAV\Calendar($this->backend, $this->backend->getCalendarById((int) $bobCal), \OCP\Server::get(\OCP\L10N\IFactory::class)->get('dav'), \OCP\Server::get(\OCP\IConfig::class), \OCP\Server::get(\Psr\Log\LoggerInterface::class)),
			[['href' => 'principal:principals/users/' . $this->alice, 'readOnly' => false, 'commonName' => '', 'summary' => '']], [],
		);
		$this->backend->updateShares(
			new \OCA\DAV\CalDAV\Calendar($this->backend, $this->backend->getCalendarById((int) $bobWork), \OCP\Server::get(\OCP\L10N\IFactory::class)->get('dav'), \OCP\Server::get(\OCP\IConfig::class), \OCP\Server::get(\Psr\Log\LoggerInterface::class)),
			[['href' => 'principal:principals/users/' . $this->alice, 'readOnly' => true, 'commonName' => '', 'summary' => '']], [],
		);
		$cals = array_column($this->cal->calendars($this->alice), null, 'calendar_id');
		$this->assertSame($this->bob, $cals[$bobCal]['shared_by']);
		$this->assertTrue($cals[$bobCal]['writable']);
		$this->assertFalse($cals[$bobWork]['writable']);

		$e = $this->cal->createEvent($this->alice, $bobCal, ['title' => 'Dinner', 'start' => '2026-11-20T18:00:00Z']);
		$this->assertSame('Dinner', $this->cal->event($this->bob, $e['event_id'])['title']); // bob sees it in his calendar
		try {
			$this->cal->createEvent($this->alice, $bobWork, ['title' => 'Nope', 'start' => '2026-11-20T18:00:00Z']);
			$this->fail('wrote into a read-only share');
		} catch (AtriumAgentError $err) {
			$this->assertSame(403, $err->status);
		}
		// The default calendar for new events is one of alice's own, never a share.
		$this->assertNotContains($this->cal->createEvent($this->alice, null, ['title' => 'Mine', 'start' => '2026-11-20T18:00:00Z'])['calendar_id'], [$bobCal, $bobWork]);
		// A calendar that is not visible to the user does not exist for them.
		$hidden = $this->newCalendar($this->bob, 'private');
		try {
			$this->cal->events($this->alice, $this->utc('2026-11-01'), $this->utc('2026-12-01'), $hidden);
			$this->fail('read a calendar not shared');
		} catch (AtriumAgentError $err) {
			$this->assertSame(404, $err->status);
		}
	}

	public function testTasks(): void {
		$todo = $this->newCalendar($this->alice, 'todo', ['VTODO']);
		$this->newCalendar($this->alice, 'home', ['VEVENT']);
		$p = $this->cal->createTask($this->alice, null, ['title' => 'Taxes', 'due' => '2026-11-30', 'priority' => 1, 'categories' => ['admin']], null);
		$this->assertSame($todo, $p['calendar_id']); // the calendar that takes tasks
		$this->assertSame(['2026-11-30', 1, ['admin'], false], [$p['due'], $p['priority'], $p['categories'], $p['done']]);
		$c = $this->cal->createTask($this->alice, null, ['title' => 'Find receipts', 'due' => '2026-11-20T12:00:00Z'], $p['task_id']);
		$this->assertSame($p['uid'], $c['parent_uid']);
		$this->cal->createTask($this->alice, null, ['title' => 'Someday'], null);

		$open = $this->cal->tasks($this->alice, null, 'open', null, null);
		$this->assertSame(['Find receipts', 'Taxes', 'Someday'], array_column($open['tasks'], 'title')); // by due, undated last
		$this->assertSame(['Find receipts'], array_column($this->cal->tasks($this->alice, null, 'open', $this->utc('2026-11-25'), null)['tasks'], 'title'));

		$done = $this->cal->updateTask($this->alice, $c['task_id'], ['done' => true], null);
		$this->assertTrue($done['done']);
		$this->assertNotNull($done['completed_at']);
		$this->assertSame(['Find receipts'], array_column($this->cal->tasks($this->alice, null, 'completed', null, null)['tasks'], 'title'));
		$undone = $this->cal->updateTask($this->alice, $c['task_id'], ['done' => false, 'due' => null], null);
		$this->assertSame([false, null, null], [$undone['done'], $undone['completed_at'], $undone['due']]);

		$this->cal->delete($this->alice, $c['task_id'], 'VTODO');
		$this->assertCount(2, $this->cal->tasks($this->alice, null, 'all', null, null)['tasks']);
		try {
			$this->cal->delete($this->alice, $p['task_id'], 'VEVENT');
			$this->fail('deleted a task as an event');
		} catch (AtriumAgentError $err) {
			$this->assertSame(404, $err->status);
		}
	}

	public function testControllerIsInternalOnly(): void {
		$this->newCalendar($this->alice, 'home');
		$req = fn(bool $internal) => new \OC\AppFramework\Http\Request(
			['server' => $internal ? ['HTTP_X_ATRIUM_INTERNAL' => \OCP\Server::get(InternalAuth::class)->expected()] : []],
			\OCP\Server::get(\OCP\IRequestId::class), \OCP\Server::get(\OCP\IConfig::class),
		);
		$log = \OCP\Server::get(\Psr\Log\LoggerInterface::class);
		$out = new AtriumAgentController('calendar', $req(false), $this->cal, $log);
		$this->assertSame(403, $out->call('calendars', $this->alice)->getStatus());
		$session = \OCP\Server::get(\OCP\IUserSession::class);
		$in = new AtriumAgentController('calendar', $req(true), $this->cal, $log, \OCP\Server::get(IUserManager::class), $session);
		$this->assertSame(404, $in->call('calendars', 'nobody-' . bin2hex(random_bytes(3)))->getStatus());
		$res = $in->call('calendars', $this->alice);
		$this->assertSame(200, $res->getStatus());
		$this->assertSame(['Home'], array_column($res->getData()['calendars'], 'name'));
		$this->assertSame(400, $in->call('events', $this->alice, ['from' => 'soon', 'to' => 'later'])->getStatus());
		$this->assertSame(404, $in->call('event', $this->alice, ['event_id' => '999999/x.ics'])->getStatus());
		$this->assertSame(400, $in->call('nope', $this->alice)->getStatus());
		$created = $in->call('event_create', $this->alice, ['fields' => ['title' => 'Via controller', 'start' => '2026-11-20T18:00:00Z']]);
		$this->assertSame(200, $created->getStatus());
		$this->assertSame('Via controller', $created->getData()['title']);
		$this->assertNull($session->getUser()); // the grantor was the session user only during the call
	}
}
