<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace Test\Authentication\Scope;

use OC\Authentication\Scope\ScopeSet;
use OC\Authentication\Token\PublicKeyTokenMapper;
use OC\Authentication\Token\PublicKeyTokenProvider;
use OC\Authentication\Token\RemoteWipe;
use OCP\Authentication\Token\IToken;
use OCP\Server;
use Test\TestCase;

/**
 * Every path that writes oc_authtoken.scope or rebuilds a token must carry
 * the "atrium" key through unchanged (otherwise a scoped token silently
 * becomes a full-access legacy token). Uses the real provider and database.
 */
#[\PHPUnit\Framework\Attributes\Group('DB')]
class ScopePreservationTest extends TestCase {
	private const UID = 'atrium-scope-preservation';

	private PublicKeyTokenProvider $provider;
	private PublicKeyTokenMapper $mapper;
	private array $scope;

	#[\Override]
	protected function setUp(): void {
		parent::setUp();
		$this->provider = Server::get(PublicKeyTokenProvider::class);
		$this->mapper = Server::get(PublicKeyTokenMapper::class);
		$this->scope = (new ScopeSet(['mail:read', 'mail:write', 'mail:send', 'files:read'], true))->toTokenScope();
	}

	#[\Override]
	protected function tearDown(): void {
		foreach ($this->mapper->getTokenByUser(self::UID) as $token) {
			$this->mapper->delete($token);
		}
		parent::tearDown();
	}

	private function create(string $secret, int $type = IToken::PERMANENT_TOKEN): IToken {
		return $this->provider->generateToken($secret, self::UID, self::UID, 'old-password', 'agent', $type, scope: $this->scope);
	}

	private function assertScopeKept(int $id): void {
		$stored = $this->mapper->getTokenById($id)->getScopeAsArray();
		$this->assertSame($this->scope, $stored);
		$this->assertNotNull(ScopeSet::fromTokenScope($stored));
	}

	public function testGenerate(): void {
		$this->assertScopeKept($this->create(str_repeat('a', 72))->getId());
	}

	public function testRotate(): void {
		$token = $this->create(str_repeat('b', 72));
		$this->provider->rotate($token, str_repeat('b', 72), str_repeat('c', 72));
		$this->assertScopeKept($token->getId());
	}

	public function testRenewSessionToken(): void {
		$this->create(str_repeat('d', 72), IToken::TEMPORARY_TOKEN);
		$new = $this->provider->renewSessionToken(str_repeat('d', 72), str_repeat('e', 72));
		$this->assertScopeKept($new->getId());
	}

	public function testPasswordChangeReencryption(): void {
		$token = $this->create(str_repeat('f', 72));
		$this->provider->updatePasswords(self::UID, 'new-password');
		$this->assertScopeKept($token->getId());
		$this->assertSame('new-password', $this->provider->getPassword($this->mapper->getTokenById($token->getId()), str_repeat('f', 72)));
	}

	public function testSetPasswordAndMarkInvalid(): void {
		$token = $this->create(str_repeat('g', 72));
		$this->provider->setPassword($token, str_repeat('g', 72), 'other');
		$this->assertScopeKept($token->getId());
		$this->provider->markPasswordInvalid($this->mapper->getTokenById($token->getId()), str_repeat('g', 72));
		$this->assertScopeKept($token->getId());
	}

	public function testActivityUpdate(): void {
		$token = $this->create(str_repeat('h', 72));
		$token->setLastActivity(1);
		$this->provider->updateTokenActivity($token);
		$this->provider->updateToken($this->mapper->getTokenById($token->getId()));
		$this->assertScopeKept($token->getId());
	}

	public function testRemoteWipe(): void {
		$token = $this->create(str_repeat('i', 72));
		Server::get(RemoteWipe::class)->markTokenForWipe($token);
		$this->assertScopeKept($token->getId());
		$this->assertSame(IToken::WIPE_TOKEN, $this->mapper->getTokenById($token->getId())->getType());
	}

	public function testOneTimeTokenCarriesScopes(): void {
		// What AppPasswordController::getAppPasswordWithOneTimePassword stores.
		$oneTime = $this->create(str_repeat('j', 72), IToken::ONETIME_TOKEN);
		$scope = ScopeSet::fromTokenScope($oneTime->getScopeAsArray())?->toTokenScope();
		$permanent = $this->provider->generateToken(str_repeat('k', 72), self::UID, self::UID, null, 'ua', IToken::PERMANENT_TOKEN, scope: $scope);
		$this->assertScopeKept($permanent->getId());
	}

	public function testPasswordlessLogin(): void {
		// OC_User::loginWithApache
		$token = $this->create(str_repeat('l', 72), IToken::TEMPORARY_TOKEN);
		$token->setScope(ScopeSet::withSkipPasswordValidation($token->getScopeAsArray()));
		$this->provider->updateToken($token);
		$stored = $this->mapper->getTokenById($token->getId())->getScopeAsArray();
		$this->assertTrue($stored[IToken::SCOPE_SKIP_PASSWORD_VALIDATION]);
		unset($stored[IToken::SCOPE_SKIP_PASSWORD_VALIDATION]);
		$this->assertSame($this->scope, $stored);
	}

	public function testPasswordlessLoginLegacyUnchanged(): void {
		$this->assertSame(
			[IToken::SCOPE_FILESYSTEM => true, IToken::SCOPE_SKIP_PASSWORD_VALIDATION => true],
			ScopeSet::withSkipPasswordValidation([IToken::SCOPE_FILESYSTEM => true]),
		);
	}
}
