<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCP\Agent;

/**
 * Stores which agent may do what with which user's data.
 *
 * This only stores grants. Checking them on requests is done by the scope layer
 * (phase 3, see docs/architecture/0004-agent-grants.md).
 *
 * @since 34.0.5
 */
interface IAgentGrantManager {
	/**
	 * Every grant made to the agent, by any user.
	 *
	 * @return list<IAgentGrant>
	 * @since 34.0.5
	 */
	public function getGrantsForAgent(string $agentUid): array;

	/**
	 * Grants one user made to one agent.
	 *
	 * @return list<IAgentGrant>
	 * @since 34.0.5
	 */
	public function getGrantsFrom(string $grantorUid, string $agentUid): array;

	/**
	 * @since 34.0.5
	 */
	public function getGrant(string $grantorUid, string $agentUid, string $area): ?IAgentGrant;

	/**
	 * Create or replace the grant for (grantor, agent, area). For IAgentGrant::AREA_ALL
	 * the actions are ignored.
	 *
	 * @param list<string> $actions
	 * @throws \InvalidArgumentException if $agentUid is not an agent, the grantor
	 *                                   is the agent itself or another agent, the
	 *                                   area is admin/security or malformed, or no
	 *                                   valid action is given
	 * @since 34.0.5
	 */
	public function setGrant(string $grantorUid, string $agentUid, string $area, array $actions): IAgentGrant;

	/**
	 * @since 34.0.5
	 */
	public function revokeGrant(string $grantorUid, string $agentUid, string $area): void;

	/**
	 * @since 34.0.5
	 */
	public function revokeAllForAgent(string $agentUid): void;

	/**
	 * @since 34.0.5
	 */
	public function revokeAllFromGrantor(string $grantorUid): void;
}
