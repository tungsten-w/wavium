<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCP\Agent;

/**
 * Registry of agent accounts. Sits next to the user manager: an agent is a user
 * account plus an entry here.
 *
 * @since 34.0.5
 */
interface IAgentManager {
	/**
	 * @since 34.0.5
	 */
	public function isAgent(string $uid): bool;

	/**
	 * @since 34.0.5
	 */
	public function getAgent(string $uid): ?IAgent;

	/**
	 * @return list<IAgent>
	 * @since 34.0.5
	 */
	public function getAgentsOwnedBy(string $ownerUid): array;

	/**
	 * Mark an existing user account as an agent owned by $ownerUid.
	 *
	 * @throws \InvalidArgumentException if either account does not exist, the
	 *                                   account is already an agent, the owner is
	 *                                   itself an agent, or both ids are the same
	 * @since 34.0.5
	 */
	public function registerAgent(string $uid, string $ownerUid, string $description = ''): IAgent;

	/**
	 * Remove the agent flag and every grant made to the agent. The user account stays.
	 *
	 * @since 34.0.5
	 */
	public function unregisterAgent(string $uid): void;
}
