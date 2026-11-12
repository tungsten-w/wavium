<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCP\Agent\Tool;

/**
 * One page of IAgentResourceProvider::list() results.
 *
 * @since 34.0.5
 */
final class ResourcePage {
	/**
	 * @param list<array<string, mixed>> $items
	 * @param ?string $nextCursor pass to list() for the next page; null on the last page
	 * @since 34.0.5
	 */
	public function __construct(
		public readonly array $items,
		public readonly ?string $nextCursor = null,
	) {
	}
}
