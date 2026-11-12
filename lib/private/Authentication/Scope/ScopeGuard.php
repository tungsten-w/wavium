<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Authentication\Scope;

use OC\AppFramework\Middleware\Security\Exceptions\NotInScopeException;
use OCP\Authentication\Scope\IScopeRegistry;
use OCP\IUserSession;

/**
 * Checks for code paths where one route does several things (e.g. a profile
 * endpoint that can also change the email) and for creating tokens.
 */
class ScopeGuard {
	public function __construct(
		private ScopeContext $context,
		private IScopeRegistry $registry,
		private IUserSession $userSession,
	) {
	}

	/** @throws NotInScopeException */
	public function require(string $area, string $action): void {
		if (!$this->context->allows($area, $action)) {
			throw new NotInScopeException($area . ':' . $action);
		}
	}

	/**
	 * For routes that take a target account: your own account needs
	 * "account:<action>", any other account is account management and needs
	 * "admin:<action>" (so agents never act on other accounts). With
	 * $selfArea null, acting on your own account needs nothing extra.
	 *
	 * @throws NotInScopeException
	 */
	public function requireForUser(string $targetUid, string $action, ?string $selfArea = IScopeRegistry::AREA_ACCOUNT): void {
		if ($this->context->getScopeSet() === null) {
			return;
		}
		$currentUid = $this->userSession->getUser()?->getUID();
		$self = $currentUid !== null && $currentUid === $targetUid;
		if ($self && $selfArea === null) {
			return;
		}
		$this->require($self ? $selfArea : IScopeRegistry::AREA_ADMIN, $action);
	}

	/**
	 * Validates scopes for a new token created during the current request.
	 *
	 * - Agent tokens cannot create tokens at all.
	 * - A scoped (human) token can only create tokens it covers.
	 * - Agent tokens can never be given admin or security.
	 * - Every scope must exist in the registry.
	 *
	 * @param list<string>|null $scopes null = unscoped (full) token
	 * @throws \InvalidArgumentException|NotInScopeException
	 */
	public function newTokenScope(?array $scopes, bool $agent): ?ScopeSet {
		$current = $this->context->getScopeSet();
		if ($current?->isAgent()) {
			throw new NotInScopeException('security:write (agent tokens cannot create tokens)');
		}
		if ($scopes === null) {
			if ($agent) {
				throw new \InvalidArgumentException('An agent token needs explicit scopes');
			}
			if ($current !== null && !$current->covers(new ScopeSet(['*']))) {
				throw new NotInScopeException('* (a scoped token cannot create an unscoped one)');
			}
			return null;
		}
		foreach ($scopes as $scope) {
			if (!$this->registry->isValid($scope)) {
				throw new \InvalidArgumentException('Unknown scope "' . $scope . '"');
			}
		}
		$set = new ScopeSet($scopes, $agent);
		if ($agent) {
			foreach ($set->getScopes() as $scope) {
				$area = explode(':', $scope, 2)[0];
				if ($scope === '*' || in_array($area, ScopeSet::AGENT_FORBIDDEN, true)) {
					throw new \InvalidArgumentException('Agent tokens cannot get "' . $scope . '" (admin and security are never granted to agents)');
				}
				if (str_ends_with($scope, ':*')) {
					// Every action is granted on its own, so send/delete/share never come in through a wildcard.
					throw new \InvalidArgumentException('Agent tokens need explicit actions, not "' . $scope . '" (e.g. ' . $area . ':read ' . $area . ':write)');
				}
			}
		}
		if ($current !== null && !$current->covers($set)) {
			throw new NotInScopeException('a scoped token can only create narrower tokens');
		}
		return $set;
	}
}
