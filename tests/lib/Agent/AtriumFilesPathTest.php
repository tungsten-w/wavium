<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace Test\Agent;

use OCA\Files\Controller\AtriumAgentController;
use Test\TestCase;

/** P3-4: agent paths stay inside the user's home. */
class AtriumFilesPathTest extends TestCase {
	public static function good(): array {
		return [
			['/', ''], ['', ''], ['/Documents/a.md', 'Documents/a.md'], ['Documents//a.md', 'Documents/a.md'],
			['./x/./y/', 'x/y'], ['\\win\\path.txt', 'win/path.txt'], ['/Été/ünï côde.md', 'Été/ünï côde.md'], ['/a..b/c..', 'a..b/c..'],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider('good')]
	public function testClean(string $in, string $out): void {
		$this->assertSame($out, AtriumAgentController::cleanPath($in));
	}

	public static function bad(): array {
		return [['../etc/passwd'], ['/a/../../b'], ['a/..'], ['..\\x'], ["a\0b"], ["a\nb"]];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider('bad')]
	public function testRefused(string $in): void {
		$this->expectException(\InvalidArgumentException::class);
		AtriumAgentController::cleanPath($in);
	}
}
