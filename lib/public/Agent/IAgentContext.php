<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCP\Agent;

/**
 * Who is calling an agent tool and on whose data.
 *
 * Providers act as getActingForUid() and attribute the change to getAgentUid().
 * The grant check has already passed when a provider is called.
 *
 * @since 34.0.5
 */
interface IAgentContext {
	/**
	 * The agent account making the call.
	 *
	 * @since 34.0.5
	 */
	public function getAgentUid(): string;

	/**
	 * The user whose data the call works on (the grantor). Equals getAgentUid()
	 * when the agent works on its own data.
	 *
	 * @since 34.0.5
	 */
	public function getActingForUid(): string;
}
