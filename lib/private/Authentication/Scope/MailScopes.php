<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Authentication\Scope;

use OCP\IRequest;

/**
 * NC Mail routes whose scope depends on the request (Mail is not ours, so
 * this cannot be an attribute).
 *
 * Rule: anything that ends in a permanent delete needs mail:delete, also when
 * the delete is delayed. Gmail purges Trash and Spam by itself after 30 days,
 * so moving to Trash/Junk, flagging \Deleted or $junk, emptying a folder and
 * changing the trash/junk/retention settings all count as delete. Spam/ham
 * reports email the report address, so $junk/$notjunk also need mail:send.
 *
 * When the target mailbox cannot be identified the check fails closed
 * (mail:delete is required).
 */
final class MailScopes {
	private const DELETE = ['mail', 'delete'];
	private const SEND = ['mail', 'send'];

	/** Names treated as purging folders when no special-use flag is set. */
	private const PURGING_NAMES = '/(^|[\/.])(trash|bin|deleted|deleted items|deleted messages|junk|junk e-mail|junk email|spam|bulk mail)$/i';

	/**
	 * Extra scopes for a route (added to the static ones), or [] if none.
	 *
	 * @param callable(int): ?array{name: string, specialUse: list<string>, trashId: ?int, junkId: ?int} $mailbox
	 * @return list<array{0: string, 1: string}>
	 */
	public static function extra(string $class, string $method, IRequest $request, ?callable $mailbox = null): array {
		$key = strtolower(ltrim($class, '\\') . '::' . $method);
		$mailbox ??= self::lookupMailbox(...);
		switch ($key) {
			case 'oca\mail\controller\messagescontroller::move':
				return self::moveTo($request->getParam('destFolderId'), $mailbox);
			case 'oca\mail\controller\threadcontroller::move':
			case 'oca\mail\controller\messagescontroller::snooze':
			case 'oca\mail\controller\threadcontroller::snooze':
				return self::moveTo($request->getParam('destMailboxId'), $mailbox);
			case 'oca\mail\controller\messagescontroller::setflags':
				return self::flags($request->getParam('flags'));
			case 'oca\mail\controller\accountscontroller::patchaccount':
				foreach (['trashMailboxId', 'junkMailboxId', 'trashRetentionDays'] as $param) {
					if ($request->getParam($param) !== null) {
						return [self::DELETE];
					}
				}
				return [];
		}
		return [];
	}

	/**
	 * @return list<array{0: string, 1: string}>
	 */
	private static function moveTo(mixed $id, callable $mailbox): array {
		if (!is_numeric($id)) {
			return [self::DELETE];
		}
		$info = $mailbox((int)$id);
		return ($info === null || self::isPurging((int)$id, $info)) ? [self::DELETE] : [];
	}

	/**
	 * @param array{name: string, specialUse: list<string>, trashId: ?int, junkId: ?int} $info
	 */
	public static function isPurging(int $id, array $info): bool {
		$use = array_map('strtolower', $info['specialUse']);
		if (array_intersect($use, ['trash', 'junk']) !== []) {
			return true;
		}
		if ($id === $info['trashId'] || $id === $info['junkId']) {
			return true;
		}
		return preg_match(self::PURGING_NAMES, $info['name']) === 1;
	}

	/**
	 * @return list<array{0: string, 1: string}>
	 */
	private static function flags(mixed $flags): array {
		if (!is_array($flags)) {
			return [];
		}
		$required = [];
		foreach ($flags as $flag => $value) {
			$set = filter_var($value, FILTER_VALIDATE_BOOLEAN);
			$flag = strtolower((string)$flag);
			if (($flag === 'deleted' || $flag === '$junk') && $set) {
				$required[self::DELETE[1]] = self::DELETE;
			}
			if ($flag === '$junk' || $flag === '$notjunk') {
				$required[self::SEND[1]] = self::SEND;
			}
		}
		return array_values($required);
	}

	/**
	 * @return array{name: string, specialUse: list<string>, trashId: ?int, junkId: ?int}|null
	 */
	private static function lookupMailbox(int $id): ?array {
		try {
			$mailbox = \OCP\Server::get('OCA\Mail\Db\MailboxMapper')->findById($id);
			$account = \OCP\Server::get('OCA\Mail\Db\MailAccountMapper')->findById($mailbox->getAccountId());
			$use = json_decode((string)$mailbox->getSpecialUse(), true);
			return [
				'name' => (string)$mailbox->getName(),
				'specialUse' => is_array($use) ? array_map('strval', $use) : [],
				'trashId' => $account->getTrashMailboxId(),
				'junkId' => $account->getJunkMailboxId(),
			];
		} catch (\Throwable) {
			return null;
		}
	}
}
