<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Notes\Activity;

use OCA\Notes\Service\Note;
use OCP\Activity\IManager;
use OCP\IConfig;
use Psr\Log\LoggerInterface;

/**
 * Atrium: writes Notes events to the activity stream (created, edited, deleted).
 *
 * Autosave writes a note every few seconds, so "edited" is published at most once per note
 * and hour, and not in the hour after "created". The last times are kept in a small user
 * preference (written only when an event is published). Publishing never breaks the action
 * itself: a failure is only logged.
 */
class ActivityPublisher {
	public const APP = 'notes';
	public const TYPE = 'notes';
	private const EDIT_QUIET = 3600;
	private const PREF = 'activityLastEdit';

	public function __construct(
		private IManager $manager,
		private IConfig $config,
		private LoggerInterface $logger,
	) {
	}

	public function created(string $userId, Note $note): void {
		try {
			$this->remember($userId, $note->getId(), time());
			$this->publish('note_created', $userId, $note->getId(), $note->getTitle(), $note->getCategory());
		} catch (\Throwable $e) {
			$this->failed($e);
		}
	}

	public function edited(string $userId, Note $note): void {
		try {
			$id = $note->getId();
			$last = $this->lastEdits($userId)[$id] ?? 0;
			if (time() - $last < self::EDIT_QUIET) {
				return;
			}
			$this->remember($userId, $id, time());
			$this->publish('note_edited', $userId, $id, $note->getTitle(), $note->getCategory());
		} catch (\Throwable $e) {
			$this->failed($e);
		}
	}

	/** Called before the file is gone, with what is needed afterwards. */
	public function deleted(string $userId, int $id, string $title, string $category): void {
		try {
			$this->remember($userId, $id, null);
			$this->publish('note_deleted', $userId, $id, $title, $category);
		} catch (\Throwable $e) {
			$this->failed($e);
		}
	}

	/** @return array<int, int> note id => unix time */
	private function lastEdits(string $userId): array {
		$v = json_decode($this->config->getUserValue($userId, self::APP, self::PREF, '{}'), true);
		return is_array($v) ? $v : [];
	}

	private function remember(string $userId, int $id, ?int $time): void {
		$all = $this->lastEdits($userId);
		unset($all[$id]);
		if ($time !== null) {
			$all[$id] = $time;
		}
		// Only the last hour matters.
		$all = array_filter($all, fn ($t) => time() - (int)$t < self::EDIT_QUIET);
		$this->config->setUserValue($userId, self::APP, self::PREF, (string)json_encode($all));
	}

	private function publish(string $subject, string $userId, int $id, string $title, string $category): void {
		$event = $this->manager->generateEvent();
		$event->setApp(self::APP)
			->setType(self::TYPE)
			->setAuthor($userId)
			->setAffectedUser($userId)
			->setTimestamp(time())
			->setSubject($subject, ['id' => $id, 'title' => $title, 'category' => $category])
			->setObject('notes', $id, $title);
		$this->manager->publish($event);
	}

	private function failed(\Throwable $e): void {
		$this->logger->warning('Notes could not publish an activity: ' . $e->getMessage(), ['app' => self::APP]);
	}
}
