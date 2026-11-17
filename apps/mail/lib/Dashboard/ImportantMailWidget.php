<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Dashboard;

use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Service\Search\Flag;
use OCA\Mail\Service\Triage\TriageService;
use OCA\Mail\Service\Search\GlobalSearchQuery;
use OCA\Mail\Service\Search\SearchQuery;

class ImportantMailWidget extends MailWidget {
	/**
	 * @inheritDoc
	 */
	#[\Override]
	public function getId(): string {
		return 'mail';
	}

	/**
	 * @inheritDoc
	 */
	#[\Override]
	public function getTitle(): string {
		return $this->l10n->t('Important mail');
	}

	#[\Override]
	public function getSearchQuery(string $userId): SearchQuery {
		$query = new GlobalSearchQuery();
		$query->addFlag(Flag::is(Flag::IMPORTANT));
		$query->setExcludeMailboxIds($this->getMailboxIdsToExclude($userId));
		return $query;
	}

	/**
	 * Flagged-important mail, then the mail Wavium's classifier calls important
	 * (a reply or an action expected, or urgent), as the morning digest does:
	 * with triage on, few mails ever get the IMAP "important" flag (V4-1).
	 */
	#[\Override]
	protected function getEmails(string $userId, ?int $minTimestamp, int $limit = 7): array {
		$flagged = parent::getEmails($userId, $minTimestamp, $limit);
		if (count($flagged) >= $limit) {
			return $flagged;
		}
		try {
			$since = $minTimestamp ?? (time() - 14 * 86400);
			$ids = \OCP\Server::get(TriageService::class)->importantIds($userId, $this->getMailboxIdsToExclude($userId), $since, $limit);
			$seen = array_map(static fn (Message $m) => $m->getId(), $flagged);
			$ids = array_values(array_diff($ids, $seen));
			if ($ids === []) {
				return $flagged;
			}
			$more = \OCP\Server::get(MessageMapper::class)->findByIds($userId, $ids, 'DESC');
		} catch (\Throwable) {
			return $flagged;
		}
		$all = array_merge($flagged, $more);
		usort($all, static fn (Message $a, Message $b) => $b->getSentAt() <=> $a->getSentAt());
		return array_slice($all, 0, $limit);
	}
}
