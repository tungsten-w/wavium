<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCP\Agent;

/**
 * An agent: a user account flagged as an agent and owned by a human user.
 *
 * The account itself is a normal user (display name, avatar, shares, activity);
 * this object only carries what makes it an agent. See
 * docs/architecture/0003-agent-principal.md.
 *
 * @since 34.0.5
 */
interface IAgent {
	/**
	 * User id of the agent's account.
	 *
	 * @since 34.0.5
	 */
	public function getUid(): string;

	/**
	 * User id of the human who owns the agent.
	 *
	 * @since 34.0.5
	 */
	public function getOwnerUid(): string;

	/**
	 * Free text set by the owner, for example what the agent is for.
	 *
	 * @since 34.0.5
	 */
	public function getDescription(): string;

	/**
	 * @since 34.0.5
	 */
	public function getCreatedAt(): \DateTimeImmutable;
}
