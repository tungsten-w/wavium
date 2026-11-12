<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Agent;

use OCP\IConfig;
use OCP\IRequest;

/**
 * Calls from the Bun agent layer (server/agent/) to PHP carry the header
 * X-Atrium-Internal: HMAC-SHA256("atrium-agent-internal", instance secret).
 * Both sides read the instance secret from config.php. The Bun server strips
 * the header from every outside request (server/php.ts), so only it can send it.
 */
class InternalAuth {
	public const HEADER = 'X-Atrium-Internal';

	public function __construct(
		private IConfig $config,
	) {
	}

	public function expected(): string {
		$secret = (string)$this->config->getSystemValue('secret', '');
		if ($secret === '') {
			return '';
		}
		return hash_hmac('sha256', 'atrium-agent-internal', $secret);
	}

	public function isInternal(IRequest $request): bool {
		$expected = $this->expected();
		$given = $request->getHeader(self::HEADER);
		return $expected !== '' && $given !== '' && hash_equals($expected, $given);
	}
}
