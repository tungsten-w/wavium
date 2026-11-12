<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service\Search;

use Horde_Imap_Client;
use OCA\Mail\Account;
use OCA\Mail\Contracts\IMailSearch;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Exception\ClientException;
use OCA\Mail\Exception\MailboxLockedException;
use OCA\Mail\Exception\MailboxNotCachedException;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\IMAP\PreviewEnhancer;
use OCA\Mail\IMAP\Search\Provider as ImapSearchProvider;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IUser;

class MailSearch implements IMailSearch {
	/** @var ITimeFactory */
	private $timeFactory;

	public function __construct(
		private FilterStringParser $filterStringParser,
		private ImapSearchProvider $imapSearchProvider,
		private MessageMapper $messageMapper,
		private PreviewEnhancer $previewEnhancer,
		ITimeFactory $timeFactory,
		private \OCP\IDBConnection $db,
	) {
		$this->timeFactory = $timeFactory;
	}

	#[\Override]
	public function findMessage(Account $account,
		Mailbox $mailbox,
		Message $message): Message {
		$processed = $this->previewEnhancer->process(
			$account,
			$mailbox,
			[$message]
		);
		if ($processed === []) {
			throw new DoesNotExistException('Message does not exist');
		}
		return $processed[0];
	}

	/**
	 * @param Account $account
	 * @param Mailbox $mailbox
	 * @param string $sortOrder
	 * @param string|null $filter
	 * @param int|null $cursor
	 * @param int|null $limit
	 * @param string|null $view
	 *
	 * @return Message[]
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[\Override]
	public function findMessages(Account $account,
		Mailbox $mailbox,
		string $sortOrder,
		?string $filter,
		?int $cursor,
		?int $limit,
		?string $userId,
		?string $view): array {
		// Atrium: the list reads Atrium's DB, so a sync that is running (locks) does
		// not block it. Only a folder that was never synced has nothing to show.
		if (!$mailbox->isCached()) {
			throw MailboxNotCachedException::from($mailbox);
		}

		$query = $this->filterStringParser->parse($filter);
		if ($cursor !== null) {
			$query->setCursor($cursor);
		}
		if ($view !== null) {
			$query->setThreaded($view === self::VIEW_THREADED);
		}
		// In flagged we don't want anything but flagged messages
		if ($mailbox->isSpecialUse(Horde_Imap_Client::SPECIALUSE_FLAGGED)) {
			$query->addFlag(Flag::is(Flag::FLAGGED));
		}
		// Don't show deleted messages except for trash folders
		if (!$mailbox->isSpecialUse(Horde_Imap_Client::SPECIALUSE_TRASH)) {
			$query->addFlag(Flag::not(Flag::DELETED));
		}

		return $this->previewEnhancer->process(
			$account,
			$mailbox,
			$this->messageMapper->findByIds($account->getUserId(),
				$this->getIdsLocally($account, $mailbox, $query, $sortOrder, $limit),
				$sortOrder,
			),
			true,
			$userId
		);
	}

	/**
	 * Find messages across all mailboxes for a user
	 *
	 * @return Message[]
	 *
	 * @throws ServiceException
	 */
	#[\Override]
	public function findMessagesGlobally(
		IUser $user,
		SearchQuery $query,
		?int $limit): array {
		return $this->messageMapper->findByIds($user->getUID(),
			$this->getIdsGlobally($user, $query, $limit),
			'DESC'
		);
	}

	/**
	 * We combine local flag and headers merge with UIDs that match the body search if necessary
	 *
	 * @throws ServiceException
	 */
	private function getIdsLocally(Account $account, Mailbox $mailbox, SearchQuery $query, string $sortOrder, ?int $limit): array {
		if (empty($query->getBodies())) {
			return $this->messageMapper->findIdsByQuery($mailbox, $query, $sortOrder, $limit);
		}

		// Atrium: search the text Atrium keeps (mail_bodies), never the mail server.
		return $this->messageMapper->findIdsByQuery($mailbox, $query, $sortOrder, $limit, $this->bodyMatches($account, $mailbox, $query->getBodies()));
	}

	/**
	 * UIDs (kept rows included) of the mailbox whose stored text or headers
	 * contain every token, case-insensitively. Mail whose text is not stored
	 * yet cannot match (Status shows how much is stored).
	 *
	 * @param string[] $tokens
	 * @return int[]
	 */
	private function bodyMatches(Account $account, Mailbox $mailbox, array $tokens): array {
		$hashes = null;
		foreach ($tokens as $token) {
			$like = '%' . $this->db->escapeLikeParameter($token) . '%';
			$qb = $this->db->getQueryBuilder();
			$qb->select('msg_hash')->from('mail_bodies')
				->where($qb->expr()->eq('account_id', $qb->createNamedParameter($account->getId(), \OCP\DB\QueryBuilder\IQueryBuilder::PARAM_INT)))
				->andWhere($qb->expr()->orX(
					$qb->expr()->iLike('body', $qb->createNamedParameter($like)),
					$qb->expr()->iLike('headers', $qb->createNamedParameter($like)),
				));
			$found = array_fill_keys($qb->executeQuery()->fetchAll(\PDO::FETCH_COLUMN), true);
			$hashes = $hashes === null ? $found : array_intersect_key($hashes, $found);
			if ($hashes === []) {
				return [];
			}
		}
		if ($hashes === null) {
			return [];
		}
		$qb = $this->db->getQueryBuilder();
		$rows = $qb->select('id', 'uid', 'message_id')->from('mail_messages')
			->where($qb->expr()->eq('mailbox_id', $qb->createNamedParameter($mailbox->getId(), \OCP\DB\QueryBuilder\IQueryBuilder::PARAM_INT)))
			->executeQuery()->fetchAll();
		$uids = [];
		foreach ($rows as $r) {
			if (isset($hashes[\OCA\Mail\Service\Triage\TriageService::hash($r['message_id'], (int)$r['id'])])) {
				$uids[] = (int)$r['uid'];
			}
		}
		return $uids;
	}

	/**
	 * We combine local flag and headers merge with UIDs that match the body search if necessary
	 *
	 * @todo find a way to search across all mailboxes efficiently without iterating over each of them and include IMAP results
	 *
	 * @throws ServiceException
	 */
	private function getIdsGlobally(IUser $user, SearchQuery $query, ?int $limit): array {
		return $this->messageMapper->findIdsGloballyByQuery($user, $query, $limit);
	}
}
