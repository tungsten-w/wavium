<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace Test\Authentication\Scope;

use OC\AppFramework\Middleware\Security\Exceptions\NotInScopeException;
use OC\Authentication\Scope\ScopeContext;
use OC\Authentication\Scope\ScopeGuard;
use OC\Authentication\Scope\ScopeSet;
use OCP\Authentication\Scope\IScopeRegistry;
use PHPUnit\Framework\MockObject\MockObject;
use Test\TestCase;

class ScopeGuardTest extends TestCase {
	private $userSession;
	private bool $loggedIn = true;
	private ScopeContext&MockObject $context;
	private ScopeGuard $guard;

	#[\Override]
	protected function setUp(): void {
		parent::setUp();
		$this->context = $this->createMock(ScopeContext::class);
		$registry = $this->createMock(IScopeRegistry::class);
		$registry->method('isValid')->willReturnCallback(fn (string $s) => $s !== 'nope:read');
		$user = $this->createMock(\OCP\IUser::class);
		$user->method('getUID')->willReturn('alice');
		$this->userSession = $this->createMock(\OCP\IUserSession::class);
		$this->userSession->method('getUser')->willReturnCallback(fn () => $this->loggedIn ? $user : null);
		$this->guard = new ScopeGuard($this->context, $registry, $this->userSession);
	}

	private function current(?ScopeSet $set): void {
		$this->context->method('getScopeSet')->willReturn($set);
		$this->context->method('allows')->willReturnCallback(fn ($a, $b) => $set === null || $set->allows($a, $b));
	}

	public function testUnscopedSessionCreatesAnything(): void {
		$this->current(null);
		$this->assertNull($this->guard->newTokenScope(null, false));
		$set = $this->guard->newTokenScope(['mail:write', 'calendar:delete'], true);
		$this->assertSame(['calendar:delete', 'mail:write'], $set->getScopes());
		$this->assertTrue($set->isAgent());
	}

	public function testAgentTokenCannotCreateAnyToken(): void {
		$this->current(new ScopeSet(['*'], true));
		$this->expectException(NotInScopeException::class);
		$this->guard->newTokenScope(['mail:read'], false);
	}

	public function testScopedTokenOnlyCreatesNarrower(): void {
		$this->current(new ScopeSet(['security:write', 'mail:write']));
		$this->assertSame(['mail:read'], $this->guard->newTokenScope(['mail:read'], false)->getScopes());
		$this->expectException(NotInScopeException::class);
		$this->guard->newTokenScope(['mail:send'], false);
	}

	public function testScopedTokenCannotCreateUnscoped(): void {
		$this->current(new ScopeSet(['security:write']));
		$this->expectException(NotInScopeException::class);
		$this->guard->newTokenScope(null, false);
	}

	public static function forbiddenAgentScopes(): array {
		return [[['*']], [['admin:read']], [['security:write']], [['mail:read', 'security:*']], [['mail:*']], [['mail:read', 'files:*']]];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider('forbiddenAgentScopes')]
	public function testAgentNeverGetsAdminOrSecurity(array $scopes): void {
		$this->current(null);
		$this->expectException(\InvalidArgumentException::class);
		$this->guard->newTokenScope($scopes, true);
	}

	public function testAgentNeedsScopes(): void {
		$this->current(null);
		$this->expectException(\InvalidArgumentException::class);
		$this->guard->newTokenScope(null, true);
	}

	public function testUnknownScopeRejected(): void {
		$this->current(null);
		$this->expectException(\InvalidArgumentException::class);
		$this->guard->newTokenScope(['nope:read'], false);
	}

	public function testRequire(): void {
		$this->current(new ScopeSet(['account:write']));
		$this->guard->require('account', 'write');
		$this->expectException(NotInScopeException::class);
		$this->guard->require('security', 'write');
	}

	public function testRequireForUser(): void {
		$this->current(new ScopeSet(['account:write', 'files:*'], true));
		$this->guard->requireForUser('alice', 'write');
		$this->guard->requireForUser('alice', 'read');
		$this->expectException(NotInScopeException::class);
		$this->guard->requireForUser('bob', 'read');
	}

	public function testRequireForUserNoSession(): void {
		$this->loggedIn = false;
		$this->current(new ScopeSet(['account:write']));
		$this->expectException(NotInScopeException::class);
		$this->guard->requireForUser('alice', 'read');
	}

	public function testRequireForUserWithoutSelfArea(): void {
		$this->current(new ScopeSet(['calendar:read'], true));
		$this->guard->requireForUser('alice', 'read', null);
		$this->expectException(NotInScopeException::class);
		$this->guard->requireForUser('bob', 'read', null);
	}

	public function testRequireForUserUnscopedSkipsLookup(): void {
		$this->current(null);
		$this->userSession->expects($this->never())->method('getUser');
		$this->guard->requireForUser('bob', 'write');
	}
}
