<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\AppFramework\Middleware\Security\Exceptions;

use OCP\AppFramework\Http;

/**
 * The app password used for this request does not grant the scope the route needs.
 */
class NotInScopeException extends SecurityException {
	public function __construct(string $scope) {
		parent::__construct('This app password does not grant "' . $scope . '"', Http::STATUS_FORBIDDEN);
	}
}
