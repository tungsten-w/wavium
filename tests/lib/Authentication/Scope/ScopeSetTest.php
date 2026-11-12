<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace Test\Authentication\Scope;

use OC\Authentication\Scope\ScopeSet;
use OCP\Authentication\Token\IToken;
use Test\TestCase;

class ScopeSetTest extends TestCase {
	public function testLegacyTokenIsUnscoped(): void {
		$this->assertNull(ScopeSet::fromTokenScope([]));
		$this->assertNull(ScopeSet::fromTokenScope([IToken::SCOPE_FILESYSTEM => true]));
		$this->assertNull(ScopeSet::fromTokenScope([IToken::SCOPE_FILESYSTEM => false, IToken::SCOPE_SKIP_PASSWORD_VALIDATION => true]));
	}

	public function testWriteImpliesReadOnly(): void {
		$set = new ScopeSet(['mail:write']);
		$this->assertTrue($set->allows('mail', 'read'));
		$this->assertTrue($set->allows('mail', 'write'));
		$this->assertFalse($set->allows('mail', 'send'));
		$this->assertFalse($set->allows('mail', 'delete'));
		$this->assertFalse($set->allows('calendar', 'read'));
	}

	public function testNamedActionsAreExplicit(): void {
		$set = new ScopeSet(['calendar:delete']);
		$this->assertTrue($set->allows('calendar', 'delete'));
		$this->assertFalse($set->allows('calendar', 'read'));
		$this->assertFalse($set->allows('calendar', 'write'));
		$this->assertFalse((new ScopeSet(['mail:send']))->allows('mail', 'write'));
	}

	public function testWildcards(): void {
		$area = new ScopeSet(['files:*']);
		$this->assertTrue($area->allows('files', 'share'));
		$this->assertFalse($area->allows('mail', 'read'));
		$all = new ScopeSet(['*']);
		$this->assertTrue($all->allows('admin', 'write'));
		$this->assertTrue($all->allows('security', 'write'));
	}

	public function testCoreReadAlwaysAllowed(): void {
		$set = new ScopeSet(['mail:read']);
		$this->assertTrue($set->allows('core', 'read'));
		$this->assertFalse($set->allows('core', 'write'));
	}

	public function testAgentNeverGetsAdminOrSecurity(): void {
		$agent = new ScopeSet(['mail:read', 'admin:read', 'security:write'], true);
		$this->assertFalse($agent->allows('admin', 'read'));
		$this->assertFalse($agent->allows('security', 'write'));
		$this->assertTrue($agent->allows('mail', 'read'));
	}

	public function testAgentWildcardsGrantNothing(): void {
		// Even if a wildcard ends up stored, an agent only gets explicit actions.
		$agent = new ScopeSet(['*', 'mail:*', 'files:write'], true);
		$this->assertFalse($agent->allows('mail', 'read'));
		$this->assertFalse($agent->allows('mail', 'send'));
		$this->assertFalse($agent->allows('calendar', 'read'));
		$this->assertFalse($agent->allows('files', 'delete'));
		$this->assertTrue($agent->allows('files', 'write'));
		$this->assertTrue($agent->allows('files', 'read'));
		$this->assertTrue($agent->allows('core', 'read'));
		// Humans keep wildcards.
		$this->assertTrue((new ScopeSet(['mail:*']))->allows('mail', 'send'));
	}

	public function testRoundTripKeepsVersionAndDerivesFilesystem(): void {
		$stored = (new ScopeSet(['mail:write'], true))->toTokenScope();
		$this->assertFalse($stored[IToken::SCOPE_FILESYSTEM]);
		$this->assertSame(1, $stored['atrium']['v']);
		$this->assertTrue($stored['atrium']['agent']);
		$this->assertTrue((new ScopeSet(['files:read']))->toTokenScope()[IToken::SCOPE_FILESYSTEM]);
		$this->assertTrue((new ScopeSet(['files:write']))->toTokenScope()[IToken::SCOPE_FILESYSTEM]);

		$back = ScopeSet::fromTokenScope(json_decode(json_encode($stored), true));
		$this->assertSame(['mail:write'], $back->getScopes());
		$this->assertTrue($back->isAgent());
	}

	public function testInvalidStoredEntriesGrantNothing(): void {
		$set = ScopeSet::fromTokenScope(['atrium' => ['v' => 1, 'scopes' => ['bogus', 'files:read', 'a:b:c']]]);
		$this->assertSame(['files:read'], $set->getScopes());
		$empty = ScopeSet::fromTokenScope(['atrium' => ['v' => 1]]);
		$this->assertNotNull($empty);
		$this->assertFalse($empty->allows('files', 'read'));
	}

	public function testNormalizeRejectsGarbage(): void {
		$this->expectException(\InvalidArgumentException::class);
		ScopeSet::normalize('mail');
	}

	public function testCovers(): void {
		$wide = new ScopeSet(['mail:write', 'calendar:*']);
		$this->assertTrue($wide->covers(new ScopeSet(['mail:read'])));
		$this->assertTrue($wide->covers(new ScopeSet(['calendar:delete', 'calendar:*'])));
		$this->assertFalse($wide->covers(new ScopeSet(['mail:send'])));
		$this->assertFalse($wide->covers(new ScopeSet(['*'])));
		$this->assertFalse((new ScopeSet(['mail:read'], true))->covers(new ScopeSet(['mail:read'])), 'agent cannot vouch for a human token');
	}
}
