<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Agent;

use OCP\Agent\IAgentContext;

final class AgentContext implements IAgentContext {
	public function __construct(
		private string $agentUid,
		private string $actingForUid,
	) {
	}

	#[\Override]
	public function getAgentUid(): string {
		return $this->agentUid;
	}

	#[\Override]
	public function getActingForUid(): string {
		return $this->actingForUid;
	}
}
