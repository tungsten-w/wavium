<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Authentication\Scope;

use OC\Lockdown\LockdownManager;
use OCP\Authentication\Scope\IScopeContext;

class ScopeContext implements IScopeContext {
	public function __construct(
		private LockdownManager $lockdownManager,
	) {
	}

	public function getScopeSet(): ?ScopeSet {
		$scope = $this->lockdownManager->getTokenScope();
		return $scope === null ? null : ScopeSet::fromTokenScope($scope);
	}

	#[\Override]
	public function isScoped(): bool {
		return $this->getScopeSet() !== null;
	}

	#[\Override]
	public function isAgent(): bool {
		return $this->getScopeSet()?->isAgent() ?? false;
	}

	#[\Override]
	public function getAgentName(): ?string {
		return $this->isAgent() ? $this->lockdownManager->getTokenName() : null;
	}

	#[\Override]
	public function getScopes(): ?array {
		return $this->getScopeSet()?->getScopes();
	}

	#[\Override]
	public function allows(string $area, string $action): bool {
		$set = $this->getScopeSet();
		return $set === null || $set->allows($area, $action);
	}
}
