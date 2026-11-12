<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace Test\AppFramework\Middleware\Security;

use OC\AppFramework\Middleware\MiddlewareUtils;
use OC\AppFramework\Middleware\Security\Exceptions\NotInScopeException;
use OC\AppFramework\Middleware\Security\ScopeMiddleware;
use OC\AppFramework\Utility\ControllerMethodReflector;
use OC\Authentication\Scope\ScopeContext;
use OC\Authentication\Scope\ScopeSet;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\Attribute\RequireScope;
use OCP\IRequest;
use Psr\Log\LoggerInterface;
use Test\TestCase;

class ScopeTestController extends Controller {
	#[NoAdminRequired]
	public function plain(): void {
	}

	#[NoAdminRequired]
	#[RequireScope('mail', 'send')]
	public function send(): void {
	}

	public function adminOnly(): void {
	}

	#[RequireScope('security', 'write')]
	public function adminSecurity(): void {
	}

	#[PublicPage]
	public function open(): void {
	}
}

#[RequireScope('security', 'write')]
class ScopeTestSecurityController extends Controller {
	#[NoAdminRequired]
	public function listTokens(): void {
	}
}

class ScopeMiddlewareTest extends TestCase {
	private function check(string $class, string $method, string $verb, ?ScopeSet $scopes, string $app = 'mail'): void {
		$request = $this->createMock(IRequest::class);
		$request->method('getMethod')->willReturn($verb);
		$controller = new $class($app, $request);
		$reflector = new ControllerMethodReflector($this->createMock(LoggerInterface::class));
		$reflector->reflect($controller, $method);
		$context = $this->createMock(ScopeContext::class);
		$context->method('getScopeSet')->willReturn($scopes);
		$middleware = new ScopeMiddleware($context, new MiddlewareUtils($reflector, $this->createMock(LoggerInterface::class)), $request, $app);
		$middleware->beforeController($controller, $method);
	}

	private function denied(string $class, string $method, string $verb, ScopeSet $scopes, string $app = 'mail'): void {
		try {
			$this->check($class, $method, $verb, $scopes, $app);
			$this->fail("$class::$method $verb should be denied");
		} catch (NotInScopeException $e) {
			$this->assertSame(403, $e->getCode());
		}
	}

	public function testUnscopedPassesEverything(): void {
		foreach (['plain', 'send', 'adminOnly', 'adminSecurity', 'open'] as $m) {
			$this->check(ScopeTestController::class, $m, 'POST', null);
		}
		$this->addToAssertionCount(1);
	}

	public function testDefaultsFromHttpMethod(): void {
		$read = new ScopeSet(['mail:read']);
		$this->check(ScopeTestController::class, 'plain', 'GET', $read);
		$this->denied(ScopeTestController::class, 'plain', 'POST', $read);
		$this->denied(ScopeTestController::class, 'plain', 'DELETE', new ScopeSet(['mail:write']));
		$this->check(ScopeTestController::class, 'plain', 'DELETE', new ScopeSet(['mail:delete']));
		$this->check(ScopeTestController::class, 'plain', 'PUT', new ScopeSet(['mail:write']));
	}

	public function testAppAreaMapping(): void {
		// files_sharing routes belong to the files area.
		$this->check(ScopeTestController::class, 'plain', 'GET', new ScopeSet(['files:read']), 'files_sharing');
		$this->denied(ScopeTestController::class, 'plain', 'GET', new ScopeSet(['mail:read']), 'files_sharing');
	}

	public function testAttributeWins(): void {
		$this->denied(ScopeTestController::class, 'send', 'POST', new ScopeSet(['mail:write']));
		$this->check(ScopeTestController::class, 'send', 'POST', new ScopeSet(['mail:send']));
	}

	public function testClassAttribute(): void {
		$this->denied(ScopeTestSecurityController::class, 'listTokens', 'GET', new ScopeSet(['*'], true));
		$this->check(ScopeTestSecurityController::class, 'listTokens', 'GET', new ScopeSet(['security:write']), 'core');
	}

	public function testAdminRoutesNeedAdminScope(): void {
		$this->denied(ScopeTestController::class, 'adminOnly', 'GET', new ScopeSet(['mail:*']));
		$this->check(ScopeTestController::class, 'adminOnly', 'GET', new ScopeSet(['admin:read']));
		// Admin + attribute: both needed.
		$this->denied(ScopeTestController::class, 'adminSecurity', 'POST', new ScopeSet(['security:write']));
		$this->check(ScopeTestController::class, 'adminSecurity', 'POST', new ScopeSet(['security:write', 'admin:write']));
	}

	public function testAgentNeverReachesAdminOrSecurity(): void {
		$agent = new ScopeSet(['mail:read', 'mail:write', 'mail:send', 'mail:delete'], true);
		$this->denied(ScopeTestController::class, 'adminOnly', 'GET', $agent);
		$this->denied(ScopeTestController::class, 'adminSecurity', 'POST', $agent);
		$this->check(ScopeTestController::class, 'plain', 'POST', $agent);
	}

	public function testPublicPageNotChecked(): void {
		$this->check(ScopeTestController::class, 'open', 'POST', new ScopeSet([]));
		$this->addToAssertionCount(1);
	}

	public function testMailRouteOverrides(): void {
		$this->assertSame([['mail', 'send']], \OC\Authentication\Scope\RouteScopes::lookup('OCA\Mail\Controller\OutboxController', 'create'));
		$this->assertSame([['mail', 'send']], \OC\Authentication\Scope\RouteScopes::lookup('\OCA\Mail\Controller\MessageApiController', 'send'));
		$this->assertNull(\OC\Authentication\Scope\RouteScopes::lookup('OCA\Mail\Controller\DraftsController', 'create'));
		$this->assertSame([['mail', 'read'], ['files', 'write']], \OC\Authentication\Scope\RouteScopes::lookup('OCA\Mail\Controller\MessagesController', 'saveAttachment'));
		$this->assertSame([['mail', 'send']], \OC\Authentication\Scope\RouteScopes::lookup('OCA\Mail\Controller\FilterController', 'updateFilters'));
	}
}
