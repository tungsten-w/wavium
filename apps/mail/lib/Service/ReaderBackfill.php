<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service;

use OCP\IDBConnection;

/**
 * Which mails still need a reader copy (mail_bodies.reader_body), and the retry bookkeeping:
 * a mail that cannot be loaded is retried (1 h, 2 h) and after MAX_ATTEMPTS marked unavailable.
 */
class ReaderBackfill {
	public const MAX_ATTEMPTS = 3;

	public function __construct(
		private IDBConnection $db,
	) {
	}

	/**
	 * Live mails of an account without a reader copy, newest first. Mails on the server only
	 * (uid > 0, not kept-only), with a Message-ID, not marked unavailable, not waiting for a retry.
	 *
	 * @return list<array{id: int, uid: int, mailbox_id: int, message_id: string}>
	 */
	public function candidates(int $accountId, int $limit, ?int $now = null): array {
		$now ??= time();
		$rows = $this->db->executeQuery(
			'SELECT m.id, m.uid, m.mailbox_id, m.message_id FROM *PREFIX*mail_messages m'
			. ' JOIN *PREFIX*mail_mailboxes x ON x.id = m.mailbox_id'
			. ' LEFT JOIN *PREFIX*mail_bodies b ON b.account_id = x.account_id AND b.msg_hash = MD5(m.message_id)'
			. ' LEFT JOIN *PREFIX*mail_reader_backfill r ON r.account_id = x.account_id AND r.msg_hash = MD5(m.message_id)'
			. ' WHERE x.account_id = ? AND m.server_gone_at IS NULL AND m.uid > 0 AND m.message_id IS NOT NULL'
			. ' AND b.reader_body IS NULL AND (r.id IS NULL OR (r.status = ? AND r.next_try <= ?))'
			. ' ORDER BY m.sent_at DESC',
			[$accountId, 'retry', $now],
			[\PDO::PARAM_INT, \PDO::PARAM_STR, \PDO::PARAM_INT],
		)->fetchAll();
		$seen = [];
		$out = [];
		foreach ($rows as $r) {
			// The same mail in several folders is one mail: try it once.
			if (isset($seen[$r['message_id']])) {
				continue;
			}
			$seen[$r['message_id']] = true;
			$out[] = ['id' => (int)$r['id'], 'uid' => (int)$r['uid'], 'mailbox_id' => (int)$r['mailbox_id'], 'message_id' => (string)$r['message_id']];
			if (count($out) >= $limit) {
				break;
			}
		}
		return $out;
	}

	public function recordFailure(int $accountId, string $messageId, string $error, ?int $now = null): void {
		$now ??= time();
		$hash = md5($messageId);
		$attempts = 1 + (int)$this->db->executeQuery('SELECT attempts FROM *PREFIX*mail_reader_backfill WHERE account_id = ? AND msg_hash = ?', [$accountId, $hash])->fetchOne();
		$status = $attempts >= self::MAX_ATTEMPTS ? 'unavailable' : 'retry';
		$next = $now + 3600 * $attempts;
		$err = mb_substr($error, 0, 500);
		$updated = $this->db->executeStatement(
			'UPDATE *PREFIX*mail_reader_backfill SET status = ?, attempts = ?, last_error = ?, next_try = ?, updated_at = ? WHERE account_id = ? AND msg_hash = ?',
			[$status, $attempts, $err, $next, $now, $accountId, $hash],
		);
		if ($updated === 0) {
			$this->db->executeStatement(
				'INSERT INTO *PREFIX*mail_reader_backfill (account_id, msg_hash, status, attempts, last_error, next_try, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
				[$accountId, $hash, $status, $attempts, $err, $next, $now],
			);
		}
	}

	/** Counts for the status page: mails still to fill, and mails given up on. */
	public function counts(int $accountId): array {
		$todo = (int)$this->db->executeQuery(
			'SELECT COUNT(DISTINCT m.message_id) FROM *PREFIX*mail_messages m'
			. ' JOIN *PREFIX*mail_mailboxes x ON x.id = m.mailbox_id'
			. ' LEFT JOIN *PREFIX*mail_bodies b ON b.account_id = x.account_id AND b.msg_hash = MD5(m.message_id)'
			. ' LEFT JOIN *PREFIX*mail_reader_backfill r ON r.account_id = x.account_id AND r.msg_hash = MD5(m.message_id)'
			. ' WHERE x.account_id = ? AND m.server_gone_at IS NULL AND m.uid > 0 AND m.message_id IS NOT NULL'
			. ' AND b.reader_body IS NULL AND (r.id IS NULL OR r.status = ?)',
			[$accountId, 'retry'],
		)->fetchOne();
		$gone = (int)$this->db->executeQuery('SELECT COUNT(*) FROM *PREFIX*mail_reader_backfill WHERE account_id = ? AND status = ?', [$accountId, 'unavailable'])->fetchOne();
		return ['todo' => $todo, 'unavailable' => $gone];
	}
}
