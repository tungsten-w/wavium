<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\IMAP;

use Horde_Imap_Client_Exception;
use OCA\Mail\Account;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper as DbMapper;
use OCA\Mail\IMAP\MessageMapper as ImapMapper;
use OCA\Mail\Service\Attachment\AttachmentService;
use OCA\Mail\Service\Avatar\Avatar;
use OCA\Mail\Service\AvatarService;
use Psr\Log\LoggerInterface;
use function array_key_exists;
use function array_map;
use function array_merge;
use function array_reduce;

class PreviewEnhancer {
	public function __construct(
		private IMAPClientFactory $clientFactory,
		private ImapMapper $imapMapper,
		private DbMapper $mapper,
		private LoggerInterface $logger,
		private AvatarService $avatarService,
		private AttachmentService $attachmentService,
		private \OCP\IDBConnection $db,
	) {
	}

	/**
	 * @param Message[] $messages
	 *
	 * @return Message[]
	 */
	public function process(Account $account, Mailbox $mailbox, array $messages, bool $preLoadAvatars = false, ?string $userId = null, bool $askServer = false): array {
		if (!$askServer) {
			return $this->avatars($this->fromAtrium($account, $mailbox, $messages), $preLoadAvatars, $userId);
		}
		$needAnalyze = array_reduce($messages, static function (array $carry, Message $message) {
			if ($message->getStructureAnalyzed() || $message->isGoneFromServer()) {
				// Nothing to do (a mail kept only in Atrium has nothing on the server)
				return $carry;
			}

			return array_merge($carry, [$message->getUid()]);
		}, []);
		$client = $this->clientFactory->getClient($account);

		try {
			// Atrium: analyze the structure first. Attachment names below skip
			// the full message fetch for analyzed messages without attachments,
			// so doing this first keeps a page of old, unanalyzed mail from
			// downloading every message in full.
			if ($needAnalyze !== []) {
				try {
					$data = $this->imapMapper->getBodyStructureData(
						$client,
						$mailbox->getName(),
						$needAnalyze,
						$account->getEMailAddress()
					);
					$messages = $this->mapper->updatePreviewDataBulk(...array_map(static function (Message $message) use ($data) {
						if (!array_key_exists($message->getUid(), $data)) {
							// Nothing to do
							return $message;
						}

						$structureData = $data[$message->getUid()];
						$message->setFlagAttachments($structureData->hasAttachments());
						$message->setPreviewText($structureData->getPreviewText());
						$message->setStructureAnalyzed(true);
						$message->setImipMessage($structureData->isImipMessage());
						$message->setEncrypted($structureData->isEncrypted());
						$message->setMentionsMe($structureData->getMentionsMe());

						return $message;
					}, $messages));
				} catch (Horde_Imap_Client_Exception $e) {
					// Ignore for now, but log
					$this->logger->warning('Could not fetch structure detail data to enhance message previews: ' . $e->getMessage(), [
						'exception' => $e,
					]);
				}
			}

			foreach ($messages as $message) {
				$attachments = $this->attachmentService->getAttachmentNames($account, $mailbox, $message, $client);
				$message->setAttachments($attachments);
			}
		} finally {
			$client->logout();
		}

		return $this->avatars($messages, $preLoadAvatars, $userId);
	}

	/**
	 * Atrium: listing, scrolling and opening read Atrium's DB alone. Mail not yet
	 * analyzed by the sync gets its preview from the stored text (mail_bodies);
	 * attachment names come from the cache or are left out. The structure is
	 * analyzed by the sync side (SyncService, PreviewEnhancementProcessingJob).
	 *
	 * @param Message[] $messages
	 * @return Message[]
	 */
	private function fromAtrium(Account $account, Mailbox $mailbox, array $messages): array {
		$noPreview = [];
		foreach ($messages as $message) {
			if (($message->getPreviewText() ?? '') === '') {
				$noPreview[md5((string)$message->getMessageId() !== '' ? (string)$message->getMessageId() : 'db:' . $message->getId())] = $message;
			}
		}
		if ($noPreview !== []) {
			try {
				$qb = $this->db->getQueryBuilder();
				$rows = $qb->select('msg_hash', 'body')->from('mail_bodies')
					->where($qb->expr()->eq('account_id', $qb->createNamedParameter($account->getId(), \OCP\DB\QueryBuilder\IQueryBuilder::PARAM_INT)))
					->andWhere($qb->expr()->in('msg_hash', $qb->createNamedParameter(array_keys($noPreview), \OCP\DB\QueryBuilder\IQueryBuilder::PARAM_STR_ARRAY)))
					->executeQuery()->fetchAll();
				foreach ($rows as $r) {
					$m = $noPreview[$r['msg_hash']] ?? null;
					$text = trim((string)preg_replace('/\s+/u', ' ', (string)$r['body']));
					if ($m === null || $text === '') {
						continue;
					}
					$preview = mb_substr($text, 0, 255);
					$m->setPreviewText($preview);
					$u = $this->db->getQueryBuilder();
					$u->update('mail_messages')
						->set('preview_text', $u->createNamedParameter($preview))
						->where($u->expr()->eq('id', $u->createNamedParameter($m->getId(), \OCP\DB\QueryBuilder\IQueryBuilder::PARAM_INT)))
						->executeStatement();
				}
			} catch (\Throwable $e) {
				$this->logger->warning('Could not fill previews from stored mail text: ' . $e->getMessage());
			}
		}
		foreach ($messages as $message) {
			$message->setAttachments($this->attachmentService->getAttachmentNames($account, $mailbox, $message, null));
		}
		return $messages;
	}

	/**
	 * @param Message[] $messages
	 * @return Message[]
	 */
	private function avatars(array $messages, bool $preLoadAvatars, ?string $userId): array {
		if ($preLoadAvatars) {
			foreach ($messages as $message) {
				$from = $message->getFrom()->first();
				if ($message->getAvatar() === null && $from !== null && $from->getEmail() !== null && $userId !== null) {
					$avatar = $this->avatarService->getCachedAvatar($from->getEmail(), $userId);
					if ($avatar === null) {
						$message->setFetchAvatarFromClient(true);
					}
					if ($avatar instanceof Avatar) {
						$message->setAvatar($avatar);
					}

				}
			}
		}

		return $messages;
	}
}
