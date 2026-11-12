<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCP\Agent;

/**
 * What one user lets one agent do with that user's data in one area.
 *
 * Areas and actions use the scope grammar of OCP\Authentication\Scope
 * (`<area>:<action>`). See docs/architecture/0004-agent-grants.md.
 *
 * @since 34.0.5
 */
interface IAgentGrant {
	/**
	 * Area of a full-access grant. Expanded when checked to every area the grantor
	 * has except admin and security, so an agent never holds a wildcard.
	 *
	 * @since 34.0.5
	 */
	public const AREA_ALL = '*';

	/**
	 * @since 34.0.5
	 */
	public function getAgentUid(): string;

	/**
	 * The user whose data this grant covers.
	 *
	 * @since 34.0.5
	 */
	public function getGrantorUid(): string;

	/**
	 * A scope area (`contacts`, `calendar`, `mail`, ...) or AREA_ALL.
	 *
	 * @since 34.0.5
	 */
	public function getArea(): string;

	/**
	 * Granted actions, sorted, for example `['read', 'write']`. Empty for AREA_ALL.
	 *
	 * @return list<string>
	 * @since 34.0.5
	 */
	public function getActions(): array;

	/**
	 * @since 34.0.5
	 */
	public function isFullAccess(): bool;

	/**
	 * Whether $action is covered: listed, implied (`write` implies `read`), or
	 * granted by full access.
	 *
	 * @since 34.0.5
	 */
	public function allows(string $action): bool;

	/**
	 * @since 34.0.5
	 */
	public function getCreatedAt(): \DateTimeImmutable;
}
