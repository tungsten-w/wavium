<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCP\Authentication\Scope;

/**
 * Valid scope areas and their actions.
 *
 * Core areas: files, calendar, contacts, tasks, account, security, admin.
 * Apps declare theirs in appinfo/info.xml:
 *
 *   <scopes>
 *     <scope area="mail" actions="read,write,send,delete"/>
 *   </scopes>
 *
 * Every enabled app without a declaration gets area "<appid>" with actions
 * read, write and delete.
 *
 * Actions "read" and "write" are the base pair; "write" implies "read".
 * Every other action (send, delete, share, ...) is outward-facing or
 * destructive and must be granted explicitly.
 *
 * @since 34.0.5
 */
interface IScopeRegistry {
	/** @since 34.0.5 */
	public const ACTION_READ = 'read';
	/** @since 34.0.5 */
	public const ACTION_WRITE = 'write';
	/** @since 34.0.5 */
	public const ACTION_SEND = 'send';
	/** @since 34.0.5 */
	public const ACTION_DELETE = 'delete';
	/** @since 34.0.5 */
	public const ACTION_SHARE = 'share';

	/** Profile and personal settings. @since 34.0.5 */
	public const AREA_ACCOUNT = 'account';
	/** App passwords, sessions, 2FA, email/password change. Never granted to agents. @since 34.0.5 */
	public const AREA_SECURITY = 'security';
	/** Admin-only routes. Never granted to agents. @since 34.0.5 */
	public const AREA_ADMIN = 'admin';

	/**
	 * @return array<string, list<string>> area => actions
	 * @since 34.0.5
	 */
	public function getAreas(): array;

	/**
	 * Whether "<area>:<action>" (or "<area>:*", or "*") is a valid scope.
	 * @since 34.0.5
	 */
	public function isValid(string $scope): bool;
}
