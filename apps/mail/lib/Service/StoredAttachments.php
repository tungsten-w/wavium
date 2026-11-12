<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service;

use OCA\Mail\Attachment;
use OCA\Mail\Service\Triage\TriageService;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use Throwable;

/**
 * Attachments Atrium keeps after someone downloaded them (never in bulk, never just because
 * a mail was synced or opened). A later download needs no mail server, also when the mail has
 * left it. Inline parts (images in the body) are not kept: viewing a mail already loads those.
 */
class StoredAttachments {
	/** Bigger attachments are always read from the server. */
	public const MAX_BYTES = 25 * 1024 * 1024;

	public function __construct(
		private IDBConnection $db,
	) {
	}

	public static function key(?string $messageId, int $dbId): string {
		return TriageService::hash($messageId, $dbId);
	}

	/** Kept for this long when the mail is still on the server (a new download gets it again). */
	public const RETENTION_DAYS = 90;

	/**
	 * Drop attachments older than the retention that can be downloaded again. A copy of a mail
	 * that left the server is the only one there is, so it is never dropped.
	 *
	 * @return int rows removed
	 */
	public function purge(?int $now = null): int {
		$cutoff = ($now ?? time()) - self::RETENTION_DAYS * 86400;
		return $this->db->executeStatement(
			'DELETE FROM *PREFIX*mail_stored_attachments WHERE fetched_at < ? AND EXISTS ('
			. 'SELECT 1 FROM *PREFIX*mail_messages m JOIN *PREFIX*mail_mailboxes mb ON mb.id = m.mailbox_id'
			. ' WHERE mb.account_id = *PREFIX*mail_stored_attachments.account_id AND MD5(m.message_id) = *PREFIX*mail_stored_attachments.msg_hash'
			. ' AND m.server_gone_at IS NULL AND m.uid > 0)',
			[$cutoff],
		);
	}

	/** @return array{count: int, bytes: int} */
	public function totals(array $accountIds): array {
		if ($accountIds === []) {
			return ['count' => 0, 'bytes' => 0];
		}
		$q = $this->db->getQueryBuilder();
		$r = $q->selectAlias($q->func()->count('*'), 'n')->selectAlias($q->func()->sum('size'), 'bytes')->from('mail_stored_attachments')
			->where($q->expr()->in('account_id', $q->createNamedParameter($accountIds, IQueryBuilder::PARAM_INT_ARRAY)))
			->executeQuery()->fetch();
		return ['count' => (int)($r['n'] ?? 0), 'bytes' => (int)($r['bytes'] ?? 0)];
	}

	public function find(int $accountId, string $hash, string $partId): ?Attachment {
		$q = $this->db->getQueryBuilder();
		$r = $q->select('part_id', 'name', 'mime', 'size', 'content')->from('mail_stored_attachments')
			->where($q->expr()->eq('account_id', $q->createNamedParameter($accountId, IQueryBuilder::PARAM_INT)))
			->andWhere($q->expr()->eq('msg_hash', $q->createNamedParameter($hash)))
			->andWhere($q->expr()->eq('part_id', $q->createNamedParameter($partId)))
			->executeQuery()->fetch();
		return $r === false ? null : self::toAttachment($r);
	}

	/**
	 * What was downloaded of a mail, without the bytes (for the reader's attachment list).
	 *
	 * @return list<array{id: string, fileName: string, mime: string, size: int, isImage: bool, isCalendarEvent: bool}>
	 */
	public function listFor(int $accountId, string $hash): array {
		$q = $this->db->getQueryBuilder();
		$rows = $q->select('part_id', 'name', 'mime', 'size')->from('mail_stored_attachments')
			->where($q->expr()->eq('account_id', $q->createNamedParameter($accountId, IQueryBuilder::PARAM_INT)))
			->andWhere($q->expr()->eq('msg_hash', $q->createNamedParameter($hash)))
			->orderBy('part_id')
			->executeQuery()->fetchAll();
		return array_map(static fn (array $r) => [
			'id' => (string)$r['part_id'], 'fileName' => (string)($r['name'] ?? ($r['part_id'] . '.eml')), 'mime' => (string)$r['mime'],
			'size' => (int)$r['size'], 'isImage' => str_starts_with((string)$r['mime'], 'image/'), 'isCalendarEvent' => false,
		], $rows);
	}
	/** @return Attachment[] */
	public function forMessage(int $accountId, string $hash): array {
		$q = $this->db->getQueryBuilder();
		$rows = $q->select('part_id', 'name', 'mime', 'size', 'content')->from('mail_stored_attachments')
			->where($q->expr()->eq('account_id', $q->createNamedParameter($accountId, IQueryBuilder::PARAM_INT)))
			->andWhere($q->expr()->eq('msg_hash', $q->createNamedParameter($hash)))
			->orderBy('part_id')
			->executeQuery()->fetchAll();
		return array_map(self::toAttachment(...), $rows);
	}

	/** Keep a downloaded attachment. Returns whether it was stored. */
	public function store(int $accountId, string $hash, Attachment $a, ?int $now = null): bool {
		$partId = $a->getId();
		if ($partId === null || $partId === '' || $a->disposition === 'inline' || strlen($a->getContent()) > self::MAX_BYTES) {
			return false;
		}
		try {
			$i = $this->db->getQueryBuilder();
			$i->insert('mail_stored_attachments')->values([
				'account_id' => $i->createNamedParameter($accountId, IQueryBuilder::PARAM_INT),
				'msg_hash' => $i->createNamedParameter($hash),
				'part_id' => $i->createNamedParameter($partId),
				'name' => $i->createNamedParameter($a->getName() === null ? null : mb_substr($a->getName(), 0, 255)),
				'mime' => $i->createNamedParameter(mb_substr($a->getType(), 0, 255)),
				'size' => $i->createNamedParameter($a->getSize(), IQueryBuilder::PARAM_INT),
				'content' => $i->createNamedParameter($a->getContent(), IQueryBuilder::PARAM_LOB),
				'fetched_at' => $i->createNamedParameter($now ?? time(), IQueryBuilder::PARAM_INT),
			])->executeStatement();
			return true;
		} catch (Throwable) {
			// Already stored by another request.
			return false;
		}
	}

	/** @param array<string, mixed> $r */
	private static function toAttachment(array $r): Attachment {
		$content = $r['content'];
		if (is_resource($content)) {
			$content = stream_get_contents($content);
		}
		return new Attachment((string)$r['part_id'], $r['name'] === null ? null : (string)$r['name'], (string)$r['mime'], (string)$content, (int)$r['size'], null, null);
	}
}
