<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2017 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

namespace OCA\Mail\Service;

use Horde_Imap_Client;
use Horde_Imap_Client_Exception;
use Horde_Imap_Client_Exception_NoSupportExtension;
use Horde_Imap_Client_Socket;
use Horde_Mime_Exception;
use OCA\Mail\Account;
use OCA\Mail\Attachment;
use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper as DbMessageMapper;
use OCA\Mail\Db\MessageTagsMapper;
use OCA\Mail\Db\Tag;
use OCA\Mail\Db\TagMapper;
use OCA\Mail\Db\ThreadMapper;
use OCA\Mail\Events\BeforeMessageDeletedEvent;
use OCA\Mail\Events\MessageDeletedEvent;
use OCA\Mail\Events\MessageFlaggedEvent;
use OCA\Mail\Exception\ClientException;
use OCA\Mail\Exception\ImapFlagEncodingException;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\Exception\TrashMailboxNotSetException;
use OCA\Mail\Folder;
use OCA\Mail\IMAP\FolderMapper;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\IMAP\ImapFlag;
use OCA\Mail\IMAP\MailboxSync;
use OCA\Mail\IMAP\MessageMapper as ImapMessageMapper;
use OCA\Mail\Model\IMAPMessage;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use OCP\EventDispatcher\IEventDispatcher;
use Psr\Log\LoggerInterface;
use function array_map;
use function array_values;

class MailManager implements IMailManager {
	/**
	 * https://datatracker.ietf.org/doc/html/rfc9051#name-flags-message-attribute
	 */
	private const SYSTEM_FLAGS = [
		'seen' => [Horde_Imap_Client::FLAG_SEEN],
		'answered' => [Horde_Imap_Client::FLAG_ANSWERED],
		'flagged' => [Horde_Imap_Client::FLAG_FLAGGED],
		'deleted' => [Horde_Imap_Client::FLAG_DELETED],
		'draft' => [Horde_Imap_Client::FLAG_DRAFT],
		'recent' => [Horde_Imap_Client::FLAG_RECENT],
	];

	/** @var IEventDispatcher */
	private $eventDispatcher;

	public function __construct(
		private IMAPClientFactory $imapClientFactory,
		private MailboxMapper $mailboxMapper,
		private MailboxSync $mailboxSync,
		private FolderMapper $folderMapper,
		private ImapMessageMapper $imapMessageMapper,
		private DbMessageMapper $dbMessageMapper,
		IEventDispatcher $eventDispatcher,
		private LoggerInterface $logger,
		private TagMapper $tagMapper,
		private MessageTagsMapper $messageTagsMapper,
		private ThreadMapper $threadMapper,
		private ImapFlag $imapFlag,
		private IDBConnection $db,
		private ITimeFactory $time,
	) {
		$this->eventDispatcher = $eventDispatcher;
	}

	#[\Override]
	public function getMailbox(string $uid, int $id): Mailbox {
		try {
			return $this->mailboxMapper->findByUid($id, $uid);
		} catch (DoesNotExistException $e) {
			throw new ClientException("Mailbox $id does not exist", 0, $e);
		}
	}

	/**
	 * @param Account $account
	 * @param bool $forceSync
	 *
	 * @return Mailbox[]
	 * @throws ServiceException
	 */
	#[\Override]
	public function getMailboxes(Account $account, bool $forceSync = false): array {
		$this->mailboxSync->sync($account, $this->logger, $forceSync);

		return $this->mailboxMapper->findAll($account);
	}

	#[\Override]
	public function createMailbox(Account $account, string $name, array $specialUse = []): Mailbox {
		$client = $this->imapClientFactory->getClient($account);
		try {
			$folder = $this->folderMapper->createFolder($client, $name, $specialUse);
			$this->folderMapper->fetchFolderAcls([$folder], $client);
			$this->folderMapper->detectFolderSpecialUse([$folder]);
			$this->mailboxSync->sync($account, $this->logger, true, $client);
		} catch (Horde_Imap_Client_Exception $e) {
			throw new ServiceException(
				'Could not get mailbox status: ' . $e->getMessage(),
				$e->getCode(),
				$e
			);
		} finally {
			$client->logout();
		}

		return $this->mailboxMapper->find($account, $name);
	}

	#[\Override]
	public function getImapMessage(Horde_Imap_Client_Socket $client,
		Account $account,
		Mailbox $mailbox,
		int $uid,
		bool $loadBody = false): IMAPMessage {
		self::assertOnServer($uid);
		try {
			return $this->imapMessageMapper->find(
				$client,
				$mailbox->getName(),
				$uid,
				$account->getUserId(),
				$loadBody
			);
		} catch (DoesNotExistException|Horde_Mime_Exception|Horde_Imap_Client_Exception $e) {
			throw new ServiceException(
				'Could not load message',
				$e->getCode(),
				$e
			);
		}
	}

	/**
	 * @param Account $account
	 * @param Mailbox $mailbox
	 * @param int[] $uids
	 * @return IMAPMessage[]
	 * @throws ServiceException
	 */
	public function getImapMessagesForScheduleProcessing(Account $account,
		Mailbox $mailbox,
		array $uids): array {
		$client = $this->imapClientFactory->getClient($account);
		try {
			return $this->imapMessageMapper->findByIds(
				$client,
				$mailbox->getName(),
				$uids,
				$account->getUserId(),
				true
			);
		} catch (Horde_Imap_Client_Exception $e) {
			throw new ServiceException(
				'Could not load messages: ' . $e->getMessage(),
				$e->getCode(),
				$e
			);
		} finally {
			$client->logout();
		}
	}

	#[\Override]
	public function getThread(Account $account, string $threadRootId): array {
		return $this->dbMessageMapper->findThread($account, $threadRootId);
	}

	#[\Override]
	public function getMessageIdForUid(Mailbox $mailbox, $uid): ?int {
		return $this->dbMessageMapper->getIdForUid($mailbox, $uid);
	}

	#[\Override]
	public function getMessage(string $uid, int $id): Message {
		return $this->dbMessageMapper->findByUserId($uid, $id);
	}

	/**
	 * @param Horde_Imap_Client_Socket $client
	 * @param Account $account
	 * @param string $mailbox
	 * @param int $uid
	 *
	 * @return string
	 *
	 * @throws ServiceException
	 */
	#[\Override]
	public function getSource(Horde_Imap_Client_Socket $client,
		Account $account,
		string $mailbox,
		int $uid): ?string {
		self::assertOnServer($uid);
		try {
			return $this->imapMessageMapper->getFullText(
				$client,
				$mailbox,
				$uid,
				$account->getUserId(),
				false,
			);
		} catch (Horde_Imap_Client_Exception|DoesNotExistException $e) {
			throw new ServiceException('Could not load message', 0, $e);
		}
	}

	/**
	 * @param Account $sourceAccount
	 * @param string $sourceFolderId
	 * @param int $uid
	 * @param Account $destinationAccount
	 * @param string $destFolderId
	 *
	 * @return ?int the new UID (or null if couldn't be determined)
	 * @throws ServiceException
	 */
	#[\Override]
	public function moveMessage(Account $sourceAccount,
		string $sourceFolderId,
		int $uid,
		Account $destinationAccount,
		string $destFolderId): ?int {
		if ($sourceAccount->getId() === $destinationAccount->getId()) {
			try {
				$sourceMailbox = $this->mailboxMapper->find($sourceAccount, $sourceFolderId);
			} catch (DoesNotExistException $e) {
				throw new ServiceException("Source mailbox $sourceFolderId does not exist", 0, $e);
			}

			if (Message::isAtriumOnlyUid($uid)) {
				// Atrium: a mail kept only in Atrium moves in Atrium alone.
				$this->moveKeptMessage($sourceMailbox, $uid, $this->findMailboxByName($destinationAccount, $destFolderId));
				return null;
			}
			$rowId = $this->dbMessageMapper->getIdForUid($sourceMailbox, $uid);

			try {
				$newUid = $this->moveMessageOnSameAccount(
					$sourceAccount,
					$sourceFolderId,
					$destFolderId,
					$uid
				);
			} catch (ServiceException $e) {
				if (!PendingOps::isUnreachable($e)) {
					throw $e;
				}
				$this->moveWhileOffline($sourceAccount, $sourceMailbox, $uid, $this->findMailboxByName($destinationAccount, $destFolderId), $e);
				return null;
			}

			// Atrium: the move is confirmed, the mail lives on in the target folder,
			// so the source row really goes (Horde may already have marked it gone
			// when the server reported the expunge, hence by id, not by uid).
			if ($rowId !== null) {
				$this->dbMessageMapper->deleteByIds($rowId);
			}

			// Delete cached source message (the source imap message is copied and deleted)
			$this->eventDispatcher->dispatch(
				MessageDeletedEvent::class,
				new MessageDeletedEvent($sourceAccount, $sourceMailbox, $uid)
			);

			return $newUid;
		} else {
			throw new ServiceException('It is not possible to move across accounts yet');
		}
	}

	/**
	 * @throws ClientException
	 * @throws ServiceException
	 * @todo evaluate if we should sync mailboxes first
	 */
	#[\Override]
	public function deleteMessage(Account $account,
		string $mailboxId,
		int $messageUid): void {
		try {
			$sourceMailbox = $this->mailboxMapper->find($account, $mailboxId);
		} catch (DoesNotExistException $e) {
			throw new ServiceException("Source mailbox $mailboxId does not exist", 0, $e);
		}

		if (Message::isAtriumOnlyUid($messageUid)) {
			$this->deleteKeptMessage($account, $sourceMailbox, $messageUid);
			return;
		}

		$client = $this->imapClientFactory->getClient($account);
		try {
			$this->deleteMessageWithClient($account, $sourceMailbox, $messageUid, $client);
		} finally {
			$client->logout();
		}
	}

	/**
	 * @throws ServiceException
	 * @throws ClientException
	 * @throws TrashMailboxNotSetException
	 *
	 * @todo evaluate if we should sync mailboxes first
	 */
	#[\Override]
	public function deleteMessageWithClient(
		Account $account,
		Mailbox $mailbox,
		int $messageUid,
		Horde_Imap_Client_Socket $client,
	): void {
		if (Message::isAtriumOnlyUid($messageUid)) {
			$this->deleteKeptMessage($account, $mailbox, $messageUid);
			return;
		}
		$this->eventDispatcher->dispatchTyped(
			new BeforeMessageDeletedEvent($account, $mailbox, $messageUid)
		);

		try {
			$trashMailboxId = $account->getMailAccount()->getTrashMailboxId();
			if ($trashMailboxId === null) {
				throw new TrashMailboxNotSetException();
			}
			$trashMailbox = $this->mailboxMapper->findById($trashMailboxId);
		} catch (DoesNotExistException $e) {
			throw new ServiceException('No trash folder', 0, $e);
		}

		if ($mailbox->getName() === $trashMailbox->getName()) {
			// Delete inside trash -> expunge, but only after 30 days in Trash (Atrium rule).
			$this->assertTrashAgeAllowsDelete($trashMailbox, $messageUid);
			$this->imapMessageMapper->expunge(
				$client,
				$mailbox->getName(),
				$messageUid
			);
			// Atrium: the server no longer has it; the row stays, marked gone
			// (Horde's expunge notice and MessageCacheUpdaterListener retire it).
		} else {
			$rowId = $this->dbMessageMapper->getIdForUid($mailbox, $messageUid);
			try {
				$this->imapMessageMapper->move(
					$client,
					$mailbox->getName(),
					$messageUid,
					$trashMailbox->getName()
				);
			} catch (ServiceException $e) {
				if (!PendingOps::isUnreachable($e)) {
					throw $e;
				}
				// DB first: it is in Trash in Atrium now; the server catches up later.
				$this->moveWhileOffline($account, $mailbox, $messageUid, $trashMailbox, $e);
				$this->eventDispatcher->dispatchTyped(new MessageDeletedEvent($account, $mailbox, $messageUid));
				return;
			}
			// Moved to Trash on the server: the Trash copy is the mail now.
			if ($rowId !== null) {
				$this->dbMessageMapper->deleteByIds($rowId);
			}
		}

		$this->eventDispatcher->dispatchTyped(
			new MessageDeletedEvent($account, $mailbox, $messageUid)
		);
	}

	/**
	 * @param Account $account
	 * @param string $sourceFolderId
	 * @param string $destFolderId
	 * @param int $messageId
	 *
	 * @return ?int the new UID (or null if it couldn't be determined)
	 * @throws ServiceException
	 *
	 */
	private function moveMessageOnSameAccount(Account $account,
		string $sourceFolderId,
		string $destFolderId,
		int $messageId): ?int {
		$client = $this->imapClientFactory->getClient($account);
		try {
			return $this->imapMessageMapper->move($client, $sourceFolderId, $messageId, $destFolderId);
		} finally {
			$client->logout();
		}
	}

	#[\Override]
	public function markFolderAsRead(Account $account, Mailbox $mailbox): void {
		$client = $this->imapClientFactory->getClient($account);
		try {
			$this->imapMessageMapper->markAllRead($client, $mailbox->getName());
		} finally {
			$client->logout();
		}
		$this->dbMessageMapper->markKeptSeen($mailbox);
	}

	#[\Override]
	public function updateSubscription(Account $account, Mailbox $mailbox, bool $subscribed): Mailbox {
		/**
		 * 1. Change subscription on IMAP
		 */
		$client = $this->imapClientFactory->getClient($account);
		try {
			$client->subscribeMailbox($mailbox->getName(), $subscribed);

			/**
			 * 2. Pull changes into the mailbox database cache
			 */
			$this->mailboxSync->sync($account, $this->logger, true, $client);
		} catch (Horde_Imap_Client_Exception $e) {
			throw new ServiceException(
				"Could not set subscription status for mailbox {$mailbox->getId()} on IMAP: {$e->getMessage()}",
				$e->getCode(),
				$e
			);
		} finally {
			$client->logout();
		}

		/**
		 * 3. Return the updated object
		 */
		return $this->mailboxMapper->find($account, $mailbox->getName());
	}

	#[\Override]
	public function enableMailboxBackgroundSync(Mailbox $mailbox,
		bool $syncInBackground): Mailbox {
		$mailbox->setSyncInBackground($syncInBackground);

		return $this->mailboxMapper->update($mailbox);
	}

	/**
	 * Send one flag change to the mail server (system flags and supported keywords only).
	 * Pass $client to reuse a login; otherwise it logs in and out itself.
	 *
	 * @throws ServiceException when the server cannot be reached or refuses
	 */
	public function applyFlagOnServer(Account $account, Mailbox $mb, int $uid, string $flag, bool $value, ?Horde_Imap_Client_Socket $client = null): void {
		$own = $client === null;
		$client ??= $this->imapClientFactory->getClient($account);
		try {
			// Only send system flags to the IMAP server as other flags might not be supported
			$imapFlags = $this->filterFlags($client, $account, $flag, $mb->getName());
			foreach ($imapFlags as $imapFlag) {
				if (empty($imapFlag) === true) {
					continue;
				}
				if ($value) {
					$this->imapMessageMapper->addFlag($client, $mb, [$uid], $imapFlag);
				} else {
					$this->imapMessageMapper->removeFlag($client, $mb, [$uid], $imapFlag);
				}
			}
		} catch (Horde_Imap_Client_Exception $e) {
			throw new ServiceException(
				'Could not set message flag on IMAP: ' . $e->getMessage(),
				$e->getCode(),
				$e
			);
		} finally {
			if ($own) {
				$client->logout();
			}
		}
	}

	#[\Override]
	public function flagMessage(Account $account, string $mailbox, int $uid, string $flag, bool $value): void {
		try {
			$mb = $this->mailboxMapper->find($account, $mailbox);
		} catch (DoesNotExistException $e) {
			throw new ClientException("Mailbox $mailbox does not exist", 0, $e);
		}

		// Atrium: a mail kept only in Atrium is flagged in Atrium alone. DB first: when the
		// server cannot be reached the change is still saved here and queued for PendingOpsJob.
		if (!Message::isAtriumOnlyUid($uid)) {
			try {
				$this->applyFlagOnServer($account, $mb, $uid, $flag, $value);
			} catch (ServiceException $e) {
				if (!PendingOps::isUnreachable($e)) {
					throw $e;
				}
				$this->logger->warning('Flag change queued, mail server not reachable: ' . $e->getMessage(), ['app' => 'mail']);
				(new PendingOps($this->db))->enqueueFlag($account->getId(), $mb->getId(), $uid, $flag, $value, $e->getMessage());
			}
		}

		// Looking the message up by uid is a shortcut to avoid changing this method's
		// signature, which the JMAP PR does anyway.
		$messages = $this->dbMessageMapper->findByUids($mb, [$uid]);
		if (count($messages) < 1) {
			// The message should be in the database cache, otherwise the client wouldn't
			// know about the uid. Skip the event rather than fail the whole flag operation.
			return;
		}

		$message = reset($messages);

		$this->eventDispatcher->dispatch(
			MessageFlaggedEvent::class,
			new MessageFlaggedEvent(
				$account,
				$mb,
				$message,
				$flag,
				$value
			)
		);
	}

	/**
	 * Tag (flag) multiple messages on IMAP using a given client instance
	 *
	 * @param Message[] $messages
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	public function tagMessagesWithClient(Horde_Imap_Client_Socket $client, Account $account, Mailbox $mailbox, array $messages, Tag $tag, bool $value):void {
		if ($this->isPermflagsEnabled($client, $account, $mailbox->getName()) === true) {
			// Atrium: mails kept only in Atrium are tagged in Atrium alone.
			$messageIds = array_values(array_filter(array_map(static fn (Message $message) => $message->getUid(), $messages), static fn (int $uid) => !Message::isAtriumOnlyUid($uid)));
			if ($messageIds !== []) try {
				if ($value) {
					// imap keywords and flags work the same way
					$this->imapMessageMapper->addFlag($client, $mailbox, $messageIds, $tag->getImapLabel());
				} else {
					$this->imapMessageMapper->removeFlag($client, $mailbox, $messageIds, $tag->getImapLabel());
				}
			} catch (Horde_Imap_Client_Exception $e) {
				throw new ServiceException(
					'Could not set message keyword on IMAP: ' . $e->getMessage(),
					$e->getCode(),
					$e
				);
			}
		}

		if ($value) {
			foreach ($messages as $message) {
				$this->tagMapper->tagMessage($tag, $message->getMessageId(), $account->getUserId());
			}
		} else {
			foreach ($messages as $message) {
				$this->tagMapper->untagMessage($tag, $message->getMessageId());
			}
		}
	}

	/**
	 * Tag (flag) a message on IMAP
	 *
	 * @param Account $account
	 * @param string $mailbox
	 * @param Message $message
	 * @param Tag $tag
	 * @param boolean $value
	 * @return void
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 * @uses
	 *
	 * @link https://github.com/nextcloud/mail/issues/25
	 */
	#[\Override]
	public function tagMessage(Account $account, string $mailbox, Message $message, Tag $tag, bool $value): void {
		try {
			$mb = $this->mailboxMapper->find($account, $mailbox);
		} catch (DoesNotExistException $e) {
			throw new ClientException("Mailbox $mailbox does not exist", 0, $e);
		}
		if ($message->isGoneFromServer()) {
			// Atrium: nothing to tag on the server.
			if ($value) {
				$this->tagMapper->tagMessage($tag, $message->getMessageId(), $account->getUserId());
			} else {
				$this->tagMapper->untagMessage($tag, $message->getMessageId());
			}
			return;
		}
		$client = $this->imapClientFactory->getClient($account);
		try {
			$this->tagMessagesWithClient($client, $account, $mb, [$message], $tag, $value);
		} finally {
			$client->logout();
		}
	}

	/**
	 * @param Account $account
	 *
	 * @return Quota|null
	 * @see https://tools.ietf.org/html/rfc2087
	 */
	#[\Override]
	public function getQuota(Account $account): ?Quota {
		/**
		 * Get all the quotas roots of the user's mailboxes
		 */
		$client = $this->imapClientFactory->getClient($account);
		try {
			$quotas = array_map(static fn (Folder $mb) => $client->getQuotaRoot($mb->getMailbox()), $this->folderMapper->getFolders($account, $client));
		} catch (Horde_Imap_Client_Exception_NoSupportExtension $ex) {
			return null;
		} finally {
			$client->logout();
		}

		/**
		 * Extract the 'storage' quota
		 *
		 * Falls back to 0/0 if this quota has no storage information
		 *
		 * @see https://tools.ietf.org/html/rfc2087#section-3
		 */
		$storageQuotas = array_map(static fn (array $root) => $root['storage'] ?? [
			'usage' => 0,
			'limit' => 0,
		], array_merge(...array_values($quotas)));

		if ($storageQuotas === []) {
			// Nothing left to do, and array_merge doesn't like to be called with zero arguments.
			return null;
		}

		/**
		 * Deduplicate identical quota roots
		 */
		$storage = array_merge(...array_values($storageQuotas));

		return new Quota(
			1024 * (int)($storage['usage'] ?? 0),
			1024 * (int)($storage['limit'] ?? 0)
		);
	}

	#[\Override]
	public function renameMailbox(Account $account, Mailbox $mailbox, string $name): Mailbox {
		/*
		 * 1. Rename on IMAP
		 */
		$client = $this->imapClientFactory->getClient($account);
		try {
			$this->folderMapper->renameFolder(
				$client,
				$mailbox->getName(),
				$name
			);

			/**
			 * 2. Get the IMAP changes into our database cache
			 */
			$this->mailboxSync->sync($account, $this->logger, true, $client);
		} finally {
			$client->logout();
		}

		/**
		 * 3. Return the cached object with the new ID
		 */
		try {
			return $this->mailboxMapper->find($account, $name);
		} catch (DoesNotExistException $e) {
			throw new ServiceException("The renamed mailbox $name does not exist", 0, $e);
		}
	}

	/**
	 * @param Account $account
	 * @param Mailbox $mailbox
	 *
	 * @throws ServiceException
	 */
	#[\Override]
	public function deleteMailbox(Account $account,
		Mailbox $mailbox): void {
		$client = $this->imapClientFactory->getClient($account);
		try {
			// Atrium never-delete rule: deleting a folder deletes its mail with it.
			$count = (int)($client->status($mailbox->getName(), Horde_Imap_Client::STATUS_MESSAGES)['messages'] ?? 0);
			if ($count > 0) {
				throw new ClientException("This folder still holds $count mails. Move them out first: deleting a folder would delete its mail.");
			}
			$this->folderMapper->delete($client, $mailbox->getName());
		} finally {
			$client->logout();
		}
		$this->mailboxMapper->delete($mailbox);
	}

	public const KEPT_MESSAGE = 'This mail is only in Atrium: it is no longer on the mail server.';

	/**  ClientException for a row kept only in Atrium (nothing to ask the server). */
	public static function assertOnServer(int $uid): void {
		if (Message::isAtriumOnlyUid($uid)) {
			throw new ClientException(self::KEPT_MESSAGE);
		}
	}

	private function findMailboxByName(Account $account, string $name): Mailbox {
		try {
			return $this->mailboxMapper->find($account, $name);
		} catch (DoesNotExistException $e) {
			throw new ServiceException("Mailbox $name does not exist", 0, $e);
		}
	}

	/**
	 * DB first: the mail server cannot be reached, so the mail moves in Atrium now (as a stand-in
	 * row like a kept mail, which the sync replaces by the real row once the server has moved it)
	 * and the server move is queued for PendingOpsJob.
	 */
	private function moveWhileOffline(Account $account, Mailbox $from, int $uid, Mailbox $to, \Throwable $reason): void {
		$this->logger->warning('Move queued, mail server not reachable: ' . $reason->getMessage(), ['app' => 'mail']);
		$qb = $this->db->getQueryBuilder();
		$qb->update('mail_messages')
			->set('mailbox_id', $qb->createNamedParameter($to->getId(), IQueryBuilder::PARAM_INT))
			->set('uid', $qb->createFunction('-id'))
			->set('server_gone_at', $qb->createNamedParameter(time(), IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('mailbox_id', $qb->createNamedParameter($from->getId(), IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('uid', $qb->createNamedParameter($uid, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->isNull('server_gone_at'))
			->executeStatement();
		(new PendingOps($this->db))->enqueueMove($account->getId(), $from->getId(), $uid, $to->getId(), $reason->getMessage());
	}

	/** Send a queued move to the mail server. @throws ServiceException */
	public function applyMoveOnServer(Mailbox $from, int $uid, Mailbox $to, Horde_Imap_Client_Socket $client): ?int {
		return $this->imapMessageMapper->move($client, $from->getName(), $uid, $to->getName());
	}

	/** Move a row kept only in Atrium to another folder of the same account (database only). */
	private function moveKeptMessage(Mailbox $from, int $uid, Mailbox $to): void {
		if ($from->getAccountId() !== $to->getAccountId()) {
			throw new ClientException('It is not possible to move across accounts yet');
		}
		$qb = $this->db->getQueryBuilder();
		$qb->update('mail_messages')
			->set('mailbox_id', $qb->createNamedParameter($to->getId(), IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('mailbox_id', $qb->createNamedParameter($from->getId(), IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('uid', $qb->createNamedParameter($uid, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->isNotNull('server_gone_at'))
			->executeStatement();
	}

	/**
	 * Atrium: "delete" on a mail kept only in Atrium moves it to Trash in Atrium.
	 * In Trash it stays: Atrium never deletes its own copy of mail the server no
	 * longer has (docs/lessons.md).
	 */
	private function deleteKeptMessage(Account $account, Mailbox $mailbox, int $uid): void {
		$trashMailboxId = $account->getMailAccount()->getTrashMailboxId();
		if ($trashMailboxId === null) {
			throw new TrashMailboxNotSetException();
		}
		if ($mailbox->getId() === $trashMailboxId) {
			throw new ClientException('This mail is no longer on the mail server; Atrium keeps its own copy and never deletes it.');
		}
		try {
			$trash = $this->mailboxMapper->findById($trashMailboxId);
		} catch (DoesNotExistException $e) {
			throw new ServiceException('No trash folder', 0, $e);
		}
		$this->moveKeptMessage($mailbox, $uid, $trash);
	}

	/**
	 * Atrium never-delete rule (non-negotiable): mail is only removed for good
	 * after MIN_TRASH_DAYS in Trash. The clock starts when Atrium first sees the
	 * mail in Trash (mail_messages_retention); unknown mail starts it now.
	 *
	 * @throws ClientException
	 */
	public const MIN_TRASH_DAYS = 30;

	private function assertTrashAgeAllowsDelete(Mailbox $trash, int $uid): void {
		$qb = $this->db->getQueryBuilder();
		$since = $qb->select('known_since')->from('mail_messages_retention')
			->where($qb->expr()->eq('mailbox_id', $qb->createNamedParameter($trash->getId(), IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('uid', $qb->createNamedParameter($uid, IQueryBuilder::PARAM_INT)))
			->executeQuery()->fetchOne();
		$now = $this->time->getTime();
		if ($since === false) {
			$i = $this->db->getQueryBuilder();
			$i->insert('mail_messages_retention')->values([
				'mailbox_id' => $i->createNamedParameter($trash->getId(), IQueryBuilder::PARAM_INT),
				'uid' => $i->createNamedParameter($uid, IQueryBuilder::PARAM_INT),
				'known_since' => $i->createNamedParameter($now, IQueryBuilder::PARAM_INT),
			])->executeStatement();
			$since = $now;
		}
		$left = (int)$since + self::MIN_TRASH_DAYS * 86400 - $now;
		if ($left > 0) {
			throw new ClientException('Mail stays in Trash for ' . self::MIN_TRASH_DAYS . ' days before it can be deleted for good (' . (int)ceil($left / 86400) . ' days left).');
		}
	}

	/**
	 * Clear messages in folder	 *
	 * @param Account $account
	 * @param Mailbox $mailbox
	 *
	 * @throws DoesNotExistException
	 * @throws Horde_Imap_Client_Exception
	 * @throws Horde_Imap_Client_Exception_NoSupportExtension
	 * @throws ServiceException
	 */
	#[\Override]
	public function clearMailbox(Account $account,
		Mailbox $mailbox): void {
		$client = $this->imapClientFactory->getClient($account);
		$trashMailboxId = $account->getMailAccount()->getTrashMailboxId();
		$currentMailboxId = $mailbox->getId();
		try {
			if (($currentMailboxId !== $trashMailboxId) && !is_null($trashMailboxId)) {
				$trash = $this->mailboxMapper->findById($trashMailboxId);
				$serverIds = $this->dbMessageMapper->findServerIds($mailbox);
				$client->copy($mailbox->getName(), $trash->getName(), [
					'move' => true
				]);
			} else {
				// Atrium never-delete rule: emptying Trash (or a folder without Trash) would
				// remove mail for good. Trash empties itself after 30 days instead.
				throw new ClientException('Emptying is disabled: mail stays in Trash ' . self::MIN_TRASH_DAYS . ' days, then goes away by itself.');
			}
			// Moved to Trash on the server. Mail kept only in Atrium stays put.
			$this->dbMessageMapper->deleteByIds(...$serverIds);
		} finally {
			$client->logout();
		}
	}

	/**
	 * @param Account $account
	 * @param Mailbox $mailbox
	 * @param Message $message
	 * @return Attachment[]
	 */
	#[\Override]
	public function getMailAttachments(Account $account, Mailbox $mailbox, Message $message): array {
		$stored = new StoredAttachments($this->db);
		$hash = StoredAttachments::key($message->getMessageId(), (int)$message->getId());
		if ($message->isGoneFromServer()) {
			// Atrium keeps only what was downloaded while the mail was still on the server.
			return $stored->forMessage($account->getId(), $hash);
		}
		$client = $this->imapClientFactory->getClient($account);
		try {
			$attachments = $this->imapMessageMapper->getAttachments(
				$client,
				$mailbox->getName(),
				$message->getUid(),
				$account->getUserId(),
			);
		} finally {
			$client->logout();
		}
		// Someone asked for all of them (download all): keep them.
		foreach ($attachments as $a) {
			$stored->store($account->getId(), $hash, $a);
		}
		return $attachments;
	}

	/**
	 * @param Account $account
	 * @param Mailbox $mailbox
	 * @param Message $message
	 * @param string $attachmentId
	 * @return Attachment
	 *
	 * @throws DoesNotExistException
	 * @throws Horde_Imap_Client_Exception
	 * @throws Horde_Imap_Client_Exception_NoSupportExtension
	 * @throws ServiceException
	 * @throws Horde_Mime_Exception
	 */
	#[\Override]
	public function getMailAttachment(Account $account,
		Mailbox $mailbox,
		Message $message,
		string $attachmentId): Attachment {
		// Atrium: an attachment is kept only once it has been downloaded; after that no server is needed.
		$stored = new StoredAttachments($this->db);
		$hash = StoredAttachments::key($message->getMessageId(), (int)$message->getId());
		$copy = $stored->find($account->getId(), $hash, $attachmentId);
		if ($copy !== null) {
			return $copy;
		}
		if ($message->isGoneFromServer()) {
			throw new DoesNotExistException('This attachment was never downloaded and the mail is no longer on the mail server.');
		}
		$client = $this->imapClientFactory->getClient($account);
		try {
			$attachment = $this->imapMessageMapper->getAttachment(
				$client,
				$mailbox->getName(),
				$message->getUid(),
				$attachmentId,
				$account->getUserId(),
			);
		} finally {
			$client->logout();
		}
		$stored->store($account->getId(), $hash, $attachment);
		return $attachment;
	}

	/**
	 * @param string $imapLabel
	 * @param string $userId
	 * @return Tag
	 * @throws ClientException
	 */
	#[\Override]
	public function getTagByImapLabel(string $imapLabel, string $userId): Tag {
		try {
			return $this->tagMapper->getTagByImapLabel($imapLabel, $userId);
		} catch (DoesNotExistException $e) {
			throw new ClientException('Unknown Tag', 0, $e);
		}
	}

	/**
	 * Filter out IMAP flags that aren't supported by the client server
	 *
	 * @param string $flag
	 * @param string $mailbox
	 * @return array
	 */
	public function filterFlags(Horde_Imap_Client_Socket $client, Account $account, string $flag, string $mailbox): array {
		// check if flag is RFC defined system flag
		if (array_key_exists($flag, self::SYSTEM_FLAGS) === true) {
			return self::SYSTEM_FLAGS[$flag];
		}
		// check if server supports custom keywords / this specific keyword
		try {
			$capabilities = $client->status($mailbox, Horde_Imap_Client::STATUS_PERMFLAGS);
		} catch (Horde_Imap_Client_Exception $e) {
			throw new ServiceException(
				'Could not get message flag options from IMAP: ' . $e->getMessage(),
				$e->getCode(),
				$e
			);
		}
		// check if server returned supported flags
		if (!isset($capabilities['permflags'])) {
			return [];
		}
		// check if server supports custom flags or specific flag
		if (in_array("\*", $capabilities['permflags']) || in_array($flag, $capabilities['permflags'])) {
			return [$flag];
		}

		return [];
	}

	/**
	 * Check IMAP server for support for PERMANENTFLAGS
	 *
	 * @param Account $account
	 * @param string $mailbox
	 * @return boolean
	 */
	#[\Override]
	public function isPermflagsEnabled(Horde_Imap_Client_Socket $client, Account $account, string $mailbox): bool {
		try {
			$capabilities = $client->status($mailbox, Horde_Imap_Client::STATUS_PERMFLAGS);
		} catch (Horde_Imap_Client_Exception $e) {
			throw new ServiceException(
				'Could not get message flag options from IMAP: ' . $e->getMessage(),
				$e->getCode(),
				$e
			);
		}
		return (is_array($capabilities) === true && array_key_exists('permflags', $capabilities) === true && in_array("\*", $capabilities['permflags'], true) === true);
	}

	#[\Override]
	public function createTag(string $displayName, string $color, string $userId): Tag {
		try {
			$imapLabel = $this->imapFlag->create($displayName);
		} catch (ImapFlagEncodingException $e) {
			throw new ClientException('Error converting display name to UTF7-IMAP ', 0, $e);
		}

		try {
			return $this->getTagByImapLabel($imapLabel, $userId);
		} catch (ClientException $e) {
			// it's valid that a tag does not exist.
		}

		$tag = new Tag();
		$tag->setUserId($userId);
		$tag->setDisplayName($displayName);
		$tag->setImapLabel($imapLabel);
		$tag->setColor($color);
		$tag->setIsDefaultTag(false);

		return $this->tagMapper->insert($tag);
	}

	#[\Override]
	public function updateTag(int $id, string $displayName, string $color, string $userId): Tag {
		try {
			$tag = $this->tagMapper->getTagForUser($id, $userId);
		} catch (DoesNotExistException $e) {
			throw new ClientException('Tag not found', 0, $e);
		}

		$tag->setDisplayName($displayName);
		$tag->setColor($color);

		return $this->tagMapper->update($tag);
	}

	#[\Override]
	public function deleteTag(int $id, string $userId, array $accounts) :Tag {
		try {
			$tag = $this->tagMapper->getTagForUser($id, $userId);
		} catch (DoesNotExistException $e) {
			throw new ClientException('Tag not found', 0, $e);
		}

		foreach ($accounts as $account) {
			$this->deleteTagForAccount($id, $userId, $tag, $account);
		}
		return $this->tagMapper->delete($tag);
	}

	#[\Override]
	public function deleteTagForAccount(int $id, string $userId, Tag $tag, Account $account) :void {
		try {
			$messageTags = $this->messageTagsMapper->getMessagesByTag($id);
			$messages = array_merge(... array_map(fn ($messageTag) => $this->getByMessageId($account, $messageTag->getImapMessageId()), array_values($messageTags)));
		} catch (DoesNotExistException $e) {
			throw new ClientException('Messages not found', 0, $e);
		}

		$client = $this->imapClientFactory->getClient($account);

		foreach ($messageTags as $messageTag) {
			$this->messageTagsMapper->delete($messageTag);
		}
		$groupedMessages = [];
		foreach ($messages as $message) {
			$mailboxId = $message->getMailboxId();
			if (array_key_exists($mailboxId, $groupedMessages)) {
				$groupedMessages[$mailboxId][] = $message;
			} else {
				$groupedMessages[$mailboxId] = [$message];
			}
		}
		try {
			foreach ($groupedMessages as $mailboxId => $messages) {
				$mailbox = $this->getMailbox($userId, $mailboxId);
				$this->tagMessagesWithClient($client, $account, $mailbox, $messages, $tag, false);
			}
		} finally {
			$client->logout();
		}
	}

	#[\Override]
	public function moveThread(Account $srcAccount, Mailbox $srcMailbox, Account $dstAccount, Mailbox $dstMailbox, string $threadRootId): array {
		$mailAccount = $srcAccount->getMailAccount();
		$messageInTrash = $srcMailbox->getId() === $mailAccount->getTrashMailboxId();

		$messages = $this->threadMapper->findMessageUidsAndMailboxNamesByAccountAndThreadRoot(
			$mailAccount,
			$threadRootId,
			$messageInTrash
		);

		$newUids = [];
		foreach ($messages as $message) {
			$this->logger->debug('move message', [
				'messageId' => $message['messageUid'],
				'srcMailboxId' => $srcMailbox->getId(),
				'dstMailboxId' => $dstMailbox->getId()
			]);

			$newUid = $this->moveMessage(
				$srcAccount,
				$message['mailboxName'],
				$message['messageUid'],
				$dstAccount,
				$dstMailbox->getName()
			);
			if ($newUid !== null) {
				$newUids[] = $newUid;
			}
		}
		return $newUids;
	}

	/**
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[\Override]
	public function deleteThread(Account $account, Mailbox $mailbox, string $threadRootId): void {
		$mailAccount = $account->getMailAccount();
		$messageInTrash = $mailbox->getId() === $mailAccount->getTrashMailboxId();

		$messages = $this->threadMapper->findMessageUidsAndMailboxNamesByAccountAndThreadRoot(
			$mailAccount,
			$threadRootId,
			$messageInTrash
		);

		foreach ($messages as $message) {
			$this->logger->debug('deleting message', [
				'messageId' => $message['messageUid'],
				'mailboxId' => $mailbox->getId(),
			]);

			if ($messageInTrash && Message::isAtriumOnlyUid((int)$message['messageUid'])) {
				// Atrium keeps its own copy of mail already gone from the server.
				continue;
			}
			$this->deleteMessage(
				$account,
				$message['mailboxName'],
				$message['messageUid']
			);
		}
	}

	/**
	 * @return Message[]
	 */
	#[\Override]
	public function getByMessageId(Account $account, string $messageId): array {
		return $this->dbMessageMapper->findByMessageId($account, $messageId);
	}
}
