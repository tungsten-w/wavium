<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\AppFramework\Middleware\Security;

use OC\AppFramework\Middleware\MiddlewareUtils;
use OC\AppFramework\Middleware\Security\Exceptions\NotInScopeException;
use OC\Authentication\Scope\MailScopes;
use OC\Authentication\Scope\RouteScopes;
use OC\Authentication\Scope\ScopeContext;
use OC\Authentication\Scope\ScopeRegistry;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\AuthorizedAdminSetting;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\Attribute\RequireScope;
use OCP\AppFramework\Http\Attribute\SubAdminRequired;
use OCP\AppFramework\Middleware;
use OCP\Authentication\Scope\IScopeRegistry;
use OCP\IRequest;
use ReflectionClass;
use ReflectionMethod;

/**
 * Enforces token scopes on every AppFramework route (apps, OCS, core).
 * Unscoped requests (browser sessions, legacy app passwords) pass untouched.
 */
class ScopeMiddleware extends Middleware {
	public function __construct(
		private ScopeContext $scopeContext,
		private MiddlewareUtils $middlewareUtils,
		private IRequest $request,
		private string $appName,
	) {
	}

	#[\Override]
	public function beforeController(Controller $controller, string $methodName) {
		$scopes = $this->scopeContext->getScopeSet();
		if ($scopes === null) {
			return;
		}
		foreach ($this->requiredScopes($controller, $methodName) as [$area, $action]) {
			if (!$scopes->allows($area, $action)) {
				throw new NotInScopeException($area . ':' . $action);
			}
		}
	}

	/**
	 * Every scope the route needs; empty for public pages.
	 *
	 * Admin routes (everything not opened to normal users) always need
	 * "admin:<action>", so agents never reach them, in addition to the
	 * route's own scope from #[RequireScope] or RouteScopes. Without either,
	 * a normal route needs "<app area>:<action from HTTP method>".
	 *
	 * @return list<array{0: string, 1: string}>
	 */
	public function requiredScopes(Controller $controller, string $methodName): array {
		$method = new ReflectionMethod($controller, $methodName);
		if ($this->middlewareUtils->hasAnnotationOrAttribute($method, 'PublicPage', PublicPage::class)) {
			return [];
		}
		$required = [];
		if ($this->middlewareUtils->hasAnnotationOrAttribute($method, 'AuthorizedAdminSetting', AuthorizedAdminSetting::class)
			|| $this->middlewareUtils->hasAnnotationOrAttribute($method, 'SubAdminRequired', SubAdminRequired::class)
			|| !$this->middlewareUtils->hasAnnotationOrAttribute($method, 'NoAdminRequired', NoAdminRequired::class)) {
			$required[] = [IScopeRegistry::AREA_ADMIN, $this->actionForMethod()];
		}

		$attribute = $method->getAttributes(RequireScope::class)[0]
			?? (new ReflectionClass($controller))->getAttributes(RequireScope::class)[0]
			?? null;
		$override = RouteScopes::lookup(get_class($controller), $methodName);
		if ($attribute !== null) {
			$scope = $attribute->newInstance();
			$required[] = [$scope->getArea(), $scope->getAction()];
		} elseif ($override !== null) {
			array_push($required, ...$override);
		} elseif ($required === []) {
			$required[] = [ScopeRegistry::areaForApp($this->appName), $this->actionForMethod()];
		}
		array_push($required, ...MailScopes::extra(get_class($controller), $methodName, $this->request));
		return $required;
	}

	private function actionForMethod(): string {
		return match (strtoupper($this->request->getMethod())) {
			'GET', 'HEAD', 'OPTIONS' => IScopeRegistry::ACTION_READ,
			'DELETE' => IScopeRegistry::ACTION_DELETE,
			default => IScopeRegistry::ACTION_WRITE,
		};
	}
}
