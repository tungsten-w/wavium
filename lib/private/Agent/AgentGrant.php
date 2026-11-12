<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Agent;

use OCP\Agent\IAgentGrant;
use OCP\Authentication\Scope\IScopeRegistry;

final class AgentGrant implements IAgentGrant {
	/**
	 * @param list<string> $actions
	 */
	public function __construct(
		private string $agentUid,
		private string $grantorUid,
		private string $area,
		private array $actions,
		private \DateTimeImmutable $createdAt,
	) {
	}

	#[\Override]
	public function getAgentUid(): string {
		return $this->agentUid;
	}

	#[\Override]
	public function getGrantorUid(): string {
		return $this->grantorUid;
	}

	#[\Override]
	public function getArea(): string {
		return $this->area;
	}

	#[\Override]
	public function getActions(): array {
		return $this->actions;
	}

	#[\Override]
	public function isFullAccess(): bool {
		return $this->area === self::AREA_ALL;
	}

	#[\Override]
	public function allows(string $action): bool {
		if ($this->isFullAccess()) {
			return true;
		}
		if (in_array($action, $this->actions, true)) {
			return true;
		}
		return $action === IScopeRegistry::ACTION_READ
			&& in_array(IScopeRegistry::ACTION_WRITE, $this->actions, true);
	}

	#[\Override]
	public function getCreatedAt(): \DateTimeImmutable {
		return $this->createdAt;
	}
}
