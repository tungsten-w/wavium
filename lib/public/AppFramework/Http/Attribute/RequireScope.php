<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCP\AppFramework\Http\Attribute;

use Attribute;

/**
 * Declares which token scope a controller method needs, as "<area>:<action>".
 *
 * Only requests made with a scoped app password are checked; normal browser
 * sessions and legacy app passwords keep full access. Without this attribute
 * the scope defaults to "<appid>:read" for GET/HEAD/OPTIONS, "<appid>:delete"
 * for DELETE and "<appid>:write" otherwise.
 *
 * May be put on a class (applies to all its methods) or on a method.
 *
 * @since 34.0.5
 */
#[Attribute(Attribute::TARGET_CLASS | Attribute::TARGET_METHOD)]
class RequireScope {
	/**
	 * @param string $area e.g. "mail", "files", "security"
	 * @param string $action e.g. "read", "write", "send", "delete", "share"
	 * @since 34.0.5
	 */
	public function __construct(
		protected string $area,
		protected string $action,
	) {
	}

	/** @since 34.0.5 */
	public function getArea(): string {
		return $this->area;
	}

	/** @since 34.0.5 */
	public function getAction(): string {
		return $this->action;
	}
}
