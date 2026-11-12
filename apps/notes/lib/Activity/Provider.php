<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Notes\Activity;

use OCP\Activity\Exceptions\UnknownActivityException;
use OCP\Activity\IEvent;
use OCP\Activity\IEventMerger;
use OCP\Activity\IProvider;
use OCP\Files\IRootFolder;
use OCP\IURLGenerator;
use OCP\L10N\IFactory;

/** Atrium: the sentences for Notes events. A note that was renamed since shows its current title. */
class Provider implements IProvider {
	public function __construct(
		private IFactory $languages,
		private IURLGenerator $urls,
		private IRootFolder $root,
		private IEventMerger $merger,
	) {
	}

	public function parse($language, IEvent $event, ?IEvent $previousEvent = null): IEvent {
		if ($event->getApp() !== ActivityPublisher::APP) {
			throw new UnknownActivityException();
		}
		$l = $this->languages->get(ActivityPublisher::APP, $language);
		$p = $event->getSubjectParameters();
		$id = (int)($p['id'] ?? $event->getObjectId());
		$title = (string)($p['title'] ?? $event->getObjectName());
		$exists = false;
		if ($event->getSubject() !== 'note_deleted') {
			try {
				$node = $this->root->getUserFolder($event->getAffectedUser())->getFirstNodeById($id);
				if ($node !== null) {
					$exists = true;
					$title = pathinfo($node->getName(), PATHINFO_FILENAME);
				}
			} catch (\Throwable $e) {
				// user folder not available: keep the stored title
			}
		}
		$note = ['type' => 'highlight', 'id' => (string)$id, 'name' => $title];
		if ($exists) {
			$note['link'] = $this->urls->linkToRouteAbsolute('notes.page.index') . 'note/' . $id;
		}

		switch ($event->getSubject()) {
			case 'note_created':
				$subject = $l->t('You created the note {note}');
				break;
			case 'note_edited':
				$subject = $l->t('You edited the note {note}');
				break;
			case 'note_deleted':
				$subject = $l->t('You deleted the note {note}');
				break;
			default:
				throw new UnknownActivityException();
		}
		$event->setRichSubject($subject, ['note' => $note]);
		$event->setParsedSubject(str_replace('{note}', $title, $subject));
		$event->setIcon($this->urls->getAbsoluteURL($this->urls->imagePath(ActivityPublisher::APP, 'notes-dark.svg')));
		if ($exists) {
			$event->setLink($note['link']);
		}
		if ($event->getSubject() === 'note_edited') {
			return $this->merger->mergeEvents('note', $event, $previousEvent);
		}
		return $event;
	}
}
