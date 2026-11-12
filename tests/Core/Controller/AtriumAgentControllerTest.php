<?php

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

declare(strict_types=1);

namespace Tests\Core\Controller;

use OC\Core\Controller\AtriumAgentController;
use Test\TestCase;

class AtriumAgentControllerTest extends TestCase {
	public function testSlug(): void {
		$this->assertSame('nova', AtriumAgentController::slug('Nova'));
		$this->assertSame('mail-helper-2', AtriumAgentController::slug('  Mail helper #2! '));
		$this->assertSame('', AtriumAgentController::slug('---'));
		$this->assertSame(40, strlen(AtriumAgentController::slug(str_repeat('a', 80))));
	}

	public function testTokenScopesAlwaysIncludeAccountRead(): void {
		$this->assertSame(['account:read'], AtriumAgentController::tokenScopes([]));
		$this->assertSame(['account:read', 'mail:read'], AtriumAgentController::tokenScopes(['mail:read', 'account:read']));
	}
}
