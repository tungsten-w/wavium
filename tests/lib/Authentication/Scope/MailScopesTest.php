<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace Test\Authentication\Scope;

use OC\Authentication\Scope\MailScopes;
use OCP\IRequest;
use Test\TestCase;

class MailScopesTest extends TestCase {
	private const DELETE = [['mail', 'delete']];

	/** Mailboxes like a Gmail account: 4 = [Gmail]/Bin (trash), 8 = [Gmail]/Spam (junk), 1 = INBOX, 3 = All Mail, 20 = "Trash" without flags, 21 = Archive. */
	private function mailbox(int $id): ?array {
		$boxes = [
			1 => ['INBOX', ['inbox']],
			3 => ['[Gmail]/All Mail', ['all']],
			4 => ['[Gmail]/Bin', ['trash']],
			8 => ['[Gmail]/Spam', ['junk']],
			20 => ['Trash', []],
			21 => ['Archive', []],
			22 => ['Projects/Old', []],
		];
		if (!isset($boxes[$id])) {
			return null;
		}
		return ['name' => $boxes[$id][0], 'specialUse' => $boxes[$id][1], 'trashId' => 4, 'junkId' => ($id === 22 ? 22 : 8)];
	}

	private function extra(string $class, string $method, array $params): array {
		$request = $this->createMock(IRequest::class);
		$request->method('getParam')->willReturnCallback(fn (string $k) => $params[$k] ?? null);
		return MailScopes::extra($class, $method, $request, fn (int $id) => $this->mailbox($id));
	}

	public static function moves(): array {
		return [
			'to trash (special use)' => [4, self::DELETE],
			'to spam (special use)' => [8, self::DELETE],
			'to trash by name' => [20, self::DELETE],
			'to configured junk id' => [22, self::DELETE],
			'unknown mailbox fails closed' => [999, self::DELETE],
			'to inbox' => [1, []],
			'to all mail (archive)' => [3, []],
			'to archive' => [21, []],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider('moves')]
	public function testMoves(int $dest, array $expected): void {
		$this->assertSame($expected, $this->extra('OCA\Mail\Controller\MessagesController', 'move', ['destFolderId' => $dest]));
		$this->assertSame($expected, $this->extra('OCA\Mail\Controller\ThreadController', 'move', ['destMailboxId' => $dest]));
		$this->assertSame($expected, $this->extra('OCA\Mail\Controller\ThreadController', 'snooze', ['destMailboxId' => $dest]));
	}

	public function testMoveWithoutDestinationFailsClosed(): void {
		$this->assertSame(self::DELETE, $this->extra('OCA\Mail\Controller\MessagesController', 'move', []));
	}

	public function testFlags(): void {
		$c = 'OCA\Mail\Controller\MessagesController';
		$this->assertSame([], $this->extra($c, 'setFlags', ['flags' => ['seen' => true, 'flagged' => 'false']]));
		$this->assertSame(self::DELETE, $this->extra($c, 'setFlags', ['flags' => ['deleted' => 'true']]));
		$this->assertSame([], $this->extra($c, 'setFlags', ['flags' => ['deleted' => false]]));
		$this->assertSame([['mail', 'delete'], ['mail', 'send']], $this->extra($c, 'setFlags', ['flags' => ['$junk' => true]]));
		$this->assertSame([['mail', 'send']], $this->extra($c, 'setFlags', ['flags' => ['$notjunk' => true]]));
	}

	public function testAccountSettings(): void {
		$c = 'OCA\Mail\Controller\AccountsController';
		$this->assertSame(self::DELETE, $this->extra($c, 'patchAccount', ['trashRetentionDays' => 1]));
		$this->assertSame(self::DELETE, $this->extra($c, 'patchAccount', ['trashMailboxId' => 1]));
		$this->assertSame(self::DELETE, $this->extra($c, 'patchAccount', ['junkMailboxId' => 1]));
		$this->assertSame([], $this->extra($c, 'patchAccount', ['signatureAboveQuote' => true]));
	}

	public function testOtherRoutesUntouched(): void {
		$this->assertSame([], $this->extra('OCA\Mail\Controller\MessagesController', 'show', ['destFolderId' => 4]));
	}
}
