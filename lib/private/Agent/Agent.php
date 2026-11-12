<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Agent;

use OCP\Agent\IAgent;

final class Agent implements IAgent {
	public function __construct(
		private string $uid,
		private string $ownerUid,
		private string $description,
		private \DateTimeImmutable $createdAt,
	) {
	}

	#[\Override]
	public function getUid(): string {
		return $this->uid;
	}

	#[\Override]
	public function getOwnerUid(): string {
		return $this->ownerUid;
	}

	#[\Override]
	public function getDescription(): string {
		return $this->description;
	}

	#[\Override]
	public function getCreatedAt(): \DateTimeImmutable {
		return $this->createdAt;
	}
}
