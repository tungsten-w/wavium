<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\DAV\Tests\unit\Connector\Sabre;

use OC\Authentication\Scope\ScopeContext;
use OC\Authentication\Scope\ScopeSet;
use OCA\DAV\Connector\Sabre\ScopePlugin;
use Sabre\DAV\Exception\Forbidden;
use Sabre\HTTP\Request;
use Test\TestCase;

class ScopePluginTest extends TestCase {
	private function plugin(?ScopeSet $set, bool $legacyFiles = false): ScopePlugin {
		$context = $this->createMock(ScopeContext::class);
		$context->method('getScopeSet')->willReturn($set);
		return new ScopePlugin($context, $legacyFiles);
	}

	private function request(string $method, string $path, string $body = ''): Request {
		$request = new Request($method, '/remote.php/dav/' . $path, [], $body);
		$request->setBaseUrl('/remote.php/dav/');
		return $request;
	}

	public function testUnscoped(): void {
		$this->plugin(null)->checkScope($this->request('DELETE', 'files/u/a.txt'));
		$this->addToAssertionCount(1);
	}

	public function testFiles(): void {
		$p = $this->plugin(new ScopeSet(['files:read']));
		$p->checkScope($this->request('PROPFIND', 'files/u/'));
		$p->checkScope($this->request('GET', 'files/u/a.txt'));
		$this->assertSame([['files', 'write']], $p->requiredScopes($this->request('PUT', 'files/u/a.txt')));
		$this->assertSame([['files', 'delete']], $p->requiredScopes($this->request('DELETE', 'files/u/a.txt')));
		$this->assertSame([['files', 'write']], $p->requiredScopes($this->request('MOVE', 'files/u/a.txt')));
		$this->expectException(Forbidden::class);
		$p->checkScope($this->request('PUT', 'files/u/a.txt'));
	}

	public function testDeleteNeedsDeleteEvenWithWrite(): void {
		$this->expectException(Forbidden::class);
		$this->plugin(new ScopeSet(['files:write']))->checkScope($this->request('DELETE', 'files/u/a.txt'));
	}

	public function testLegacyWebdavIsFiles(): void {
		$p = $this->plugin(new ScopeSet(['mail:read']), true);
		$this->assertSame([['files', 'read']], $p->requiredScopes($this->request('PROPFIND', '')));
	}

	public function testContactsAndSharing(): void {
		$p = $this->plugin(new ScopeSet(['contacts:write']));
		$this->assertSame([['contacts', 'write']], $p->requiredScopes($this->request('PUT', 'addressbooks/users/u/contacts/x.vcf', "BEGIN:VCARD\r\nEND:VCARD")));
		$share = '<?xml version="1.0"?><o:share xmlns:o="http://owncloud.org/ns"><o:set/></o:share>';
		$this->assertSame([['contacts', 'share']], $p->requiredScopes($this->request('POST', 'addressbooks/users/u/contacts', $share)));
	}

	public function testCalendarObjectComponents(): void {
		$p = $this->plugin(new ScopeSet(['calendar:write']));
		$event = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
		$todo = "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
		$both = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nBEGIN:VTODO\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
		$journal = "BEGIN:VCALENDAR\r\nBEGIN:VJOURNAL\r\nEND:VJOURNAL\r\nEND:VCALENDAR\r\n";
		$this->assertSame([['calendar', 'write']], $p->requiredScopes($this->request('PUT', 'calendars/u/personal/e.ics', $event)));
		$this->assertSame([['tasks', 'write']], $p->requiredScopes($this->request('PUT', 'calendars/u/personal/t.ics', $todo)));
		$this->assertSame([['calendar', 'write'], ['tasks', 'write']], $p->requiredScopes($this->request('PUT', 'calendars/u/personal/b.ics', $both)));
		$this->assertSame([['calendar_other', 'write']], $p->requiredScopes($this->request('PUT', 'calendars/u/personal/j.ics', $journal)));
		$p->checkScope($this->request('PUT', 'calendars/u/personal/e.ics', $event));
		$this->expectException(Forbidden::class);
		$p->checkScope($this->request('PUT', 'calendars/u/personal/b.ics', $both));
	}

	public function testBodyStillReadableAfterCheck(): void {
		$event = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
		$request = $this->request('PUT', 'calendars/u/personal/e.ics', $event);
		$this->plugin(new ScopeSet(['calendar:write']))->checkScope($request);
		$this->assertSame($event, $request->getBodyAsString());
	}

	public function testUnknownCollectionNeedsFullScope(): void {
		$p = $this->plugin(new ScopeSet(['files:*', 'calendar:*']));
		$this->assertSame([['*', '*']], $p->requiredScopes($this->request('GET', 'something-new/x')));
		$this->expectException(Forbidden::class);
		$p->checkScope($this->request('GET', 'something-new/x'));
	}

	public function testDiscovery(): void {
		$p = $this->plugin(new ScopeSet(['mail:read']));
		$p->checkScope($this->request('PROPFIND', ''));
		$p->checkScope($this->request('PROPFIND', 'principals/users/u'));
		$this->addToAssertionCount(1);
	}
}
