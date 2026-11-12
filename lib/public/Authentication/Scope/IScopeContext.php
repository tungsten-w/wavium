<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCP\Authentication\Scope;

/**
 * The token scope of the current request.
 *
 * A request is "scoped" when it authenticated with an app password created
 * with explicit scopes. Unscoped requests (browser sessions, legacy app
 * passwords, CLI) are allowed everything, as before scopes existed.
 *
 * @since 34.0.5
 */
interface IScopeContext {
	/**
	 * Whether the current request is limited by scopes.
	 * @since 34.0.5
	 */
	public function isScoped(): bool;

	/**
	 * Whether the current request comes from an agent token.
	 * @since 34.0.5
	 */
	public function isAgent(): bool;

	/**
	 * The name of the agent token ("lia"), or null if not an agent.
	 * @since 34.0.5
	 */
	public function getAgentName(): ?string;

	/**
	 * Granted scopes, or null when unscoped (everything allowed).
	 * @return list<string>|null
	 * @since 34.0.5
	 */
	public function getScopes(): ?array;

	/**
	 * Whether the current request may perform $action in $area.
	 * Always true for unscoped requests.
	 * @since 34.0.5
	 */
	public function allows(string $area, string $action): bool;
}
