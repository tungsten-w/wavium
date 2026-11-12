<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service;

use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * Writes the mail server has not received yet (it was unreachable). Atrium's own
 * copy is already changed; the queue only makes the server catch up. The newest
 * change for the same mail and flag wins.
 */
class PendingOps {
	public const MAX_ATTEMPTS = 8;

	public function __construct(
		private IDBConnection $db,
	) {
	}

	/**
	 * True when the error means the mail server could not be reached (connection, timeout,
	 * login service down). Refusals (no such folder, no permission, bad login) are real
	 * errors and must not be queued: they would only fail again.
	 */
	public static function isUnreachable(\Throwable $e): bool {
		for ($x = $e; $x !== null; $x = $x->getPrevious()) {
			if ($x instanceof \Horde_Imap_Client_Exception) {
				return in_array($x->getCode(), [
					\Horde_Imap_Client_Exception::DISCONNECT,
					\Horde_Imap_Client_Exception::SERVER_CONNECT,
					\Horde_Imap_Client_Exception::SERVER_READERROR,
					\Horde_Imap_Client_Exception::SERVER_READTIMEOUT,
					\Horde_Imap_Client_Exception::SERVER_WRITEERROR,
					\Horde_Imap_Client_Exception::LOGIN_UNAVAILABLE,
					\Horde_Imap_Client_Exception::LOGIN_TLSFAILURE,
				], true);
			}
		}
		return false;
	}

	/** Seconds to wait after the n-th failed try: 1, 2, 4 ... minutes, at most an hour. */
	public static function backoff(int $attempts): int {
		return min(3600, 60 * (2 ** max(0, $attempts - 1)));
	}

	public function enqueueFlag(int $accountId, int $mailboxId, int $uid, string $flag, bool $value, string $error = '', ?int $now = null): void {
		$now ??= time();
		// A newer change replaces an older one that has not reached the server (flag on, then off).
		$d = $this->db->getQueryBuilder();
		$d->delete('mail_pending_ops')
			->where($d->expr()->eq('mailbox_id', $d->createNamedParameter($mailboxId, IQueryBuilder::PARAM_INT)))
			->andWhere($d->expr()->eq('uid', $d->createNamedParameter($uid, IQueryBuilder::PARAM_INT)))
			->andWhere($d->expr()->eq('op', $d->createNamedParameter('flag')))
			->andWhere($d->expr()->eq('flag', $d->createNamedParameter($flag)))
			->executeStatement();
		$i = $this->db->getQueryBuilder();
		$i->insert('mail_pending_ops')->values([
			'account_id' => $i->createNamedParameter($accountId, IQueryBuilder::PARAM_INT),
			'mailbox_id' => $i->createNamedParameter($mailboxId, IQueryBuilder::PARAM_INT),
			'uid' => $i->createNamedParameter($uid, IQueryBuilder::PARAM_INT),
			'op' => $i->createNamedParameter('flag'),
			'flag' => $i->createNamedParameter($flag),
			'value' => $i->createNamedParameter($value, IQueryBuilder::PARAM_BOOL),
			'status' => $i->createNamedParameter('pending'),
			'attempts' => $i->createNamedParameter(0, IQueryBuilder::PARAM_INT),
			'last_error' => $i->createNamedParameter(mb_substr($error, 0, 500)),
			'next_try' => $i->createNamedParameter($now + self::backoff(1), IQueryBuilder::PARAM_INT),
			'created_at' => $i->createNamedParameter($now, IQueryBuilder::PARAM_INT),
		])->executeStatement();
	}

	/**
	 * Move a mail to another folder on the server (also how a delete to Trash is sent). Atrium's
	 * row is already in the target folder. A newer move of the same mail replaces an older one.
	 */
	public function enqueueMove(int $accountId, int $mailboxId, int $uid, int $targetMailboxId, string $error = '', ?int $now = null): void {
		$now ??= time();
		$d = $this->db->getQueryBuilder();
		$d->delete('mail_pending_ops')
			->where($d->expr()->eq('mailbox_id', $d->createNamedParameter($mailboxId, IQueryBuilder::PARAM_INT)))
			->andWhere($d->expr()->eq('uid', $d->createNamedParameter($uid, IQueryBuilder::PARAM_INT)))
			->andWhere($d->expr()->eq('op', $d->createNamedParameter('move')))
			->executeStatement();
		$i = $this->db->getQueryBuilder();
		$i->insert('mail_pending_ops')->values([
			'account_id' => $i->createNamedParameter($accountId, IQueryBuilder::PARAM_INT),
			'mailbox_id' => $i->createNamedParameter($mailboxId, IQueryBuilder::PARAM_INT),
			'uid' => $i->createNamedParameter($uid, IQueryBuilder::PARAM_INT),
			'op' => $i->createNamedParameter('move'),
			'flag' => $i->createNamedParameter(''),
			'value' => $i->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
			'target_mailbox_id' => $i->createNamedParameter($targetMailboxId, IQueryBuilder::PARAM_INT),
			'status' => $i->createNamedParameter('pending'),
			'attempts' => $i->createNamedParameter(0, IQueryBuilder::PARAM_INT),
			'last_error' => $i->createNamedParameter(mb_substr($error, 0, 500)),
			'next_try' => $i->createNamedParameter($now + self::backoff(1), IQueryBuilder::PARAM_INT),
			'created_at' => $i->createNamedParameter($now, IQueryBuilder::PARAM_INT),
		])->executeStatement();
	}

	/**
	 * Changes that are due, oldest first.
	 *
	 * @return list<array{id: int, op: string, account_id: int, mailbox_id: int, uid: int, flag: string, value: bool, target_mailbox_id: ?int, attempts: int}>
	 */
	public function due(int $limit = 50, ?int $now = null): array {
		$now ??= time();
		$q = $this->db->getQueryBuilder();
		$rows = $q->select('id', 'op', 'account_id', 'mailbox_id', 'uid', 'flag', 'value', 'target_mailbox_id', 'attempts')->from('mail_pending_ops')
			->where($q->expr()->eq('status', $q->createNamedParameter('pending')))
			->andWhere($q->expr()->lte('next_try', $q->createNamedParameter($now, IQueryBuilder::PARAM_INT)))
			->orderBy('id', 'ASC')
			->setMaxResults($limit)
			->executeQuery()->fetchAll();
		return array_map(static fn (array $r) => [
			'id' => (int)$r['id'], 'op' => (string)$r['op'], 'target_mailbox_id' => $r['target_mailbox_id'] === null ? null : (int)$r['target_mailbox_id'], 'account_id' => (int)$r['account_id'], 'mailbox_id' => (int)$r['mailbox_id'],
			'uid' => (int)$r['uid'], 'flag' => (string)$r['flag'], 'value' => (bool)$r['value'], 'attempts' => (int)$r['attempts'],
		], $rows);
	}

	public function done(int $id): void {
		$d = $this->db->getQueryBuilder();
		$d->delete('mail_pending_ops')->where($d->expr()->eq('id', $d->createNamedParameter($id, IQueryBuilder::PARAM_INT)))->executeStatement();
	}

	/** One more failed try: wait longer, and give up (status failed, row kept) after MAX_ATTEMPTS. */
	public function failed(int $id, int $attempts, string $error, ?int $now = null): void {
		$now ??= time();
		$attempts++;
		$u = $this->db->getQueryBuilder();
		$u->update('mail_pending_ops')
			->set('attempts', $u->createNamedParameter($attempts, IQueryBuilder::PARAM_INT))
			->set('last_error', $u->createNamedParameter(mb_substr($error, 0, 500)))
			->set('status', $u->createNamedParameter($attempts >= self::MAX_ATTEMPTS ? 'failed' : 'pending'))
			->set('next_try', $u->createNamedParameter($now + self::backoff($attempts), IQueryBuilder::PARAM_INT))
			->where($u->expr()->eq('id', $u->createNamedParameter($id, IQueryBuilder::PARAM_INT)))
			->executeStatement();
	}

	/** Changes the server never accepted (gave up after MAX_ATTEMPTS). */
	public function countFailed(int $accountId): int {
		return (int)$this->db->executeQuery('SELECT COUNT(*) FROM *PREFIX*mail_pending_ops WHERE account_id = ? AND status = ?', [$accountId, 'failed'])->fetchOne();
	}

	/** Changes still waiting for the server (for a status line). */
	public function countPending(?int $accountId = null): int {
		$q = $this->db->getQueryBuilder();
		$q->select($q->func()->count('*'))->from('mail_pending_ops')
			->where($q->expr()->eq('status', $q->createNamedParameter('pending')));
		if ($accountId !== null) {
			$q->andWhere($q->expr()->eq('account_id', $q->createNamedParameter($accountId, IQueryBuilder::PARAM_INT)));
		}
		return (int)$q->executeQuery()->fetchOne();
	}
}
