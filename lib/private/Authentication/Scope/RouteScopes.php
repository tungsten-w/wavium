<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Authentication\Scope;

/**
 * Scopes for controller methods in apps we do not maintain (so no
 * #[RequireScope] attribute). Keyed by "<class>::<method>"; each entry lists
 * every scope the route needs (all are required).
 *
 * Rule: anything outward-facing or destructive gets its own action.
 */
final class RouteScopes {
	private const MAIL_SEND = [['mail', 'send']];
	private const MAIL_SHARE = [['mail', 'share']];
	private const MAIL_WRITE = [['mail', 'write']];

	public const OVERRIDES = [
		// NC Mail: queueing a message in the outbox sends it (background job),
		// so every outbox write is "send". DELETE verbs already map to delete.
		'OCA\Mail\Controller\OutboxController::create' => self::MAIL_SEND,
		'OCA\Mail\Controller\OutboxController::createFromDraft' => self::MAIL_SEND,
		'OCA\Mail\Controller\OutboxController::update' => self::MAIL_SEND,
		'OCA\Mail\Controller\OutboxController::send' => self::MAIL_SEND,
		'OCA\Mail\Controller\MessageApiController::send' => self::MAIL_SEND,
		// Read receipt: an outgoing message.
		'OCA\Mail\Controller\MessagesController::mdn' => self::MAIL_SEND,
		// Server-side rules that send on their own: filters can redirect
		// (forward), raw sieve scripts can redirect/vacation, out-of-office
		// auto-replies.
		'OCA\Mail\Controller\FilterController::updateFilters' => self::MAIL_SEND,
		'OCA\Mail\Controller\SieveController::updateActiveScript' => self::MAIL_SEND,
		'OCA\Mail\Controller\OutOfOfficeController::update' => self::MAIL_SEND,
		'OCA\Mail\Controller\OutOfOfficeController::followSystem' => self::MAIL_SEND,
		// Giving other users access to the mailbox or to text blocks.
		'OCA\Mail\Controller\DelegationController::delegate' => self::MAIL_SHARE,
		'OCA\Mail\Controller\DelegationController::unDelegate' => self::MAIL_SHARE,
		'OCA\Mail\Controller\TextBlockSharesController::create' => self::MAIL_SHARE,
		'OCA\Mail\Controller\TextBlockSharesController::destroy' => self::MAIL_SHARE,
		// Saving attachments writes into Files.
		'OCA\Mail\Controller\MessagesController::saveAttachment' => [['mail', 'read'], ['files', 'write']],
		// OAuth callbacks store new account credentials (GET with side effects).
		'OCA\Mail\Controller\GoogleIntegrationController::oauthRedirect' => self::MAIL_WRITE,
		'OCA\Mail\Controller\MicrosoftIntegrationController::oauthRedirect' => self::MAIL_WRITE,
		// Emptying a folder is a delete (MailScopes covers moves to Trash/Junk).
		'OCA\Mail\Controller\MailboxesController::clearMailbox' => [['mail', 'delete']],
		// DELETE verbs that delete nothing: mark all read, drop the local cache, remove a tag.
		'OCA\Mail\Controller\MailboxesController::markAllAsRead' => self::MAIL_WRITE,
		'OCA\Mail\Controller\MailboxesController::clearCache' => self::MAIL_WRITE,
		'OCA\Mail\Controller\MessagesController::removeTag' => self::MAIL_WRITE,
		// Notes: GET route that creates a note.
		'OCA\Notes\Controller\PageController::createGet' => [['notes', 'write']],
		// Agent layer (ADR 0009): any token may ask who it belongs to.
		'OC\Core\Controller\AtriumAgentController::whoami' => [],
	];

	/** @return list<array{0: string, 1: string}>|null */
	public static function lookup(string $class, string $method): ?array {
		$key = ltrim($class, '\\') . '::' . $method;
		foreach (self::OVERRIDES as $k => $scopes) {
			if (strcasecmp($k, $key) === 0) {
				return $scopes;
			}
		}
		return null;
	}
}
